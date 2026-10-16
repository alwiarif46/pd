import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  costOf,
  coverage,
  diffAmendment,
  extractRows,
  mapRows,
  type ComplianceRequirement,
  type DiffLink,
  type ExistingRow,
} from '@pd/ai';
import { isUuid, lockDocumentJobs, normalizeSolicitationKey, schema, withOrg } from '@pd/core';
import { chunks, type Db, loadPages, providerForJob, recordRun, replaceCheckThese } from './ai-jobs.js';
import { readLinkConfidence, setPages } from './amendment-job.js';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';
import { allocateReqIds } from './req-ids.js';

/*
 * Backfill for amendments applied before the added-rows run (PR #22, migration 0009; 04 s3.1
 * steps 3 to 6). The run before it wrote links and closed rows, but never inserted the rows the
 * amendment's own text holds, so such an amendment has:
 * - no compliance rows with the amendment as their document (nothing "Added by Amd N");
 * - supersede links with no new_row_id, so a proposed one cannot be confirmed (new_row_missing),
 *   and add links naming no row;
 * - superseded rows with no superseded_by_row_id (no "replaced by" jump);
 * - no source_page and source_quote on its supersede and withdraw links;
 * - no "check these" hits for its document and no ai_runs row.
 * (0009 already set changed_by_amendment from the auto and confirmed links.)
 *
 * The backfill supplies those and changes nothing that was decided: passes 1 to 4 on the
 * amendment's pages, the diff against only the rows the amendment's own links name (so it finds
 * which new row replaced each one), pass 5 and pass 6, as the live run does. Then, in one
 * transaction per amendment under the live write's locks, it inserts every new row (as the live
 * run does), fills the empty new_row_id and quotes of the amendment's existing links, points a
 * row an auto or confirmed supersede closed at its replacement, adds an add link for each new row
 * that replaces nothing, writes "check these" and an ai_runs row, and records the ids it wrote in
 * an audit_log row (`amendment_backfill`), which is also what makes a second run a no-op. It
 * never closes or reopens a row, never creates or decides a proposal, never changes the
 * amendment's status, and never touches a credit: the live amendment run settles none either.
 *
 * An amendment with a later amendment of the bid (applied, needs_confirmation or processing) is
 * skipped: the later one diffed against rows without this one's, so this one's rows would sit
 * active next to the later replacements of the same clauses.
 */

export const BACKFILL_ACTION = 'amendment_backfill';
export const BACKFILL_TASK = 'amendment_backfill';

export const BACKFILL_USAGE = 'Usage: backfill-amendments.ts --org <uuid> [--org <uuid> ...] [--bid <uuid>] [--limit N] [--apply]';

/** Statuses of a later amendment that hold an earlier one back (it wrote, or will write, rows). */
const LATER_BLOCKS: schema.AmendmentStatus[] = ['applied', 'needs_confirmation', 'processing'];

export interface BackfillArgs {
  orgIds: string[];
  bidId: string | undefined;
  limit: number | undefined;
  apply: boolean;
}

/** Command-line flags; an error names the bad flag. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs | { error: string } {
  const orgIds: string[] = [];
  let bidId: string | undefined;
  let limit: number | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (flag === '--org' || flag === '--bid') {
      if (!isUuid(value)) {
        return { error: `${flag} needs an id (got ${value ?? 'nothing'})` };
      }
      if (flag === '--org') {
        orgIds.push(value);
      } else {
        bidId = value;
      }
      index += 1;
      continue;
    }
    if (flag === '--limit') {
      if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
        return { error: `--limit needs a whole number of at least 1 (got ${value ?? 'nothing'})` };
      }
      limit = Number(value);
      index += 1;
      continue;
    }
    return { error: `Unknown argument ${flag}` };
  }
  if (orgIds.length === 0) {
    return { error: 'Name at least one organization with --org (row-level security shows one at a time)' };
  }
  return { orgIds: [...new Set(orgIds)], bidId, limit, apply };
}

/** An existing link of the amendment, as the plan sees it. */
export interface OldLink {
  id: string;
  action: 'supersede' | 'withdraw' | 'add';
  status: 'auto' | 'proposed' | 'confirmed' | 'rejected';
  oldRowId: string | null;
  newRowId: string | null;
  sourceQuote: string | null;
}

export interface BackfillPair {
  linkId: string;
  oldRowId: string;
  newRowId: string;
  /** The diff's confidence for this pairing. */
  confidence: number | null;
  sourcePage: number | null;
  sourceQuote: string | null;
}

export interface BackfillPlan {
  /** Every new row, with its code-generated id. */
  inserts: (ComplianceRequirement & { id: string })[];
  /** A supersede link with no new row, and the new row the diff names for it. */
  pairs: BackfillPair[];
  /** A withdraw link with no quote, and the quote the diff found. */
  quoteFills: { linkId: string; sourcePage: number | null; sourceQuote: string | null }[];
  /** New rows no link pairs: each gets an add link. */
  addRowIds: string[];
}

/**
 * The backfill's writes, pure. Every new row is inserted. Each supersede link of the amendment
 * with no new row takes the new row of the diff's highest-confidence quoted supersede of its old
 * row; a withdraw link with no quote takes the quote of the diff's best quoted withdraw of its
 * row. For an auto, confirmed or rejected link the diff's confidence must reach `threshold` (a
 * less certain pairing leaves the link as it is). A proposed link takes any confidence: the
 * pre-#22 proposals were the ones below it, and pairing only names the row the user decides on.
 * Diff links to rows the amendment's links do not name are ignored. A new row no link takes gets
 * an add link.
 */
export function planBackfill(
  oldLinks: readonly OldLink[],
  newRows: readonly ComplianceRequirement[],
  diffLinks: readonly DiffLink[],
  threshold: number,
  newId: () => string = randomUUID,
): BackfillPlan {
  const inserts = newRows.map((row) => ({ ...row, flags: [...row.flags], id: newId() }));
  const quoted = diffLinks.filter((link) => link.sourceQuote);
  const best = (action: 'supersede' | 'withdraw', oldRowId: string, floor: number) => quoted
    .filter((link) => link.action === action && link.oldRowId === oldRowId && (link.confidence ?? 0) >= floor
      && (action === 'withdraw' || (link.newIndex !== null && inserts[link.newIndex])))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const pairs: BackfillPair[] = [];
  const quoteFills: BackfillPlan['quoteFills'] = [];
  for (const link of [...oldLinks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!link.oldRowId) {
      continue;
    }
    const floor = link.status === 'proposed' ? 0 : threshold;
    if (link.action === 'supersede' && link.newRowId === null) {
      const match = best('supersede', link.oldRowId, floor);
      if (match && match.newIndex !== null) {
        pairs.push({
          linkId: link.id, oldRowId: link.oldRowId, newRowId: inserts[match.newIndex].id,
          confidence: match.confidence, sourcePage: match.sourcePage, sourceQuote: match.sourceQuote,
        });
      }
    } else if (link.action === 'withdraw' && link.sourceQuote === null) {
      const match = best('withdraw', link.oldRowId, floor);
      if (match) {
        quoteFills.push({ linkId: link.id, sourcePage: match.sourcePage, sourceQuote: match.sourceQuote });
      }
    }
  }
  const paired = new Set(pairs.map((pair) => pair.newRowId));
  return { inserts, pairs, quoteFills, addRowIds: inserts.filter((row) => !paired.has(row.id)).map((row) => row.id) };
}

type LinkRow = typeof schema.amendmentLinks.$inferSelect;
type AmendmentRow = typeof schema.amendments.$inferSelect;

interface Facts {
  amendment: AmendmentRow;
  document: { liveStatus: string | null; fileName: string; storagePath: string | null } | undefined;
  bid: { creditStatus: string | null; solicitationKey: string } | undefined;
  links: LinkRow[];
  rowsFromText: number;
  /** check_these rows of the document: only the post-#22 amendment run writes them. */
  hits: number;
  backfilled: boolean;
  pages: number;
  /** Numbers of the bid's later amendments that are applied, needs_confirmation or processing. */
  later: number[];
}

/** The statement that makes a read transaction read-only (the dry run, and every pre-read). */
export const READ_ONLY_SQL = 'set transaction read only';

async function readOnly(db: Db): Promise<void> {
  await db.execute(sql.raw(READ_ONLY_SQL));
}

/**
 * The amendment's state, read under the caller's transaction. With `lock`, in the live
 * amendment write's lock order (apps/api/src/credits.ts): the document's job lock (advisory,
 * before any row lock), organization key share, document, its check_these rows, bid, amendment,
 * then the amendment's links (link confirm and reject take amendment, link, rows; the rows are
 * locked by the caller after this).
 */
async function readFacts(db: Db, orgId: string, target: Target, lock: boolean): Promise<Facts | null> {
  const { amendmentId, documentId, bidId } = target;
  if (lock) {
    await lockDocumentJobs(db, documentId);
    await shareOrg(db, orgId);
  }
  const documentQuery = db.select({
    liveStatus: schema.documents.liveStatus,
    fileName: schema.documents.fileName,
    storagePath: schema.documents.storagePath,
  }).from(schema.documents).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
  const [document] = lock ? await documentQuery.for('update') : await documentQuery;
  const hitQuery = db.select({ id: schema.checkThese.id }).from(schema.checkThese).where(and(
    eq(schema.checkThese.documentId, documentId),
    eq(schema.checkThese.orgId, orgId),
  )).orderBy(asc(schema.checkThese.id));
  const hits = lock ? await hitQuery.for('update') : await hitQuery;
  const bidQuery = db.select({ creditStatus: schema.bids.creditStatus, solicitationKey: schema.bids.solicitationKey })
    .from(schema.bids).where(and(eq(schema.bids.id, bidId), eq(schema.bids.orgId, orgId)));
  const [bid] = lock ? await bidQuery.for('update') : await bidQuery;
  const amendmentQuery = db.select().from(schema.amendments).where(and(
    eq(schema.amendments.id, amendmentId),
    eq(schema.amendments.orgId, orgId),
  ));
  const [amendment] = lock ? await amendmentQuery.for('update') : await amendmentQuery;
  if (!amendment) {
    return null;
  }
  const linkQuery = db.select().from(schema.amendmentLinks).where(and(
    eq(schema.amendmentLinks.amendmentId, amendmentId),
    eq(schema.amendmentLinks.orgId, orgId),
  )).orderBy(asc(schema.amendmentLinks.id));
  const links = lock ? await linkQuery.for('update') : await linkQuery;
  const [rows] = await db.select({ n: count() }).from(schema.complianceRows).where(and(
    eq(schema.complianceRows.documentId, documentId),
    eq(schema.complianceRows.orgId, orgId),
  ));
  const [marker] = await db.select({ id: schema.auditLog.id }).from(schema.auditLog).where(and(
    eq(schema.auditLog.orgId, orgId),
    eq(schema.auditLog.action, BACKFILL_ACTION),
    eq(schema.auditLog.targetId, amendmentId),
  )).limit(1);
  const [pages] = await db.select({ n: count() }).from(schema.pages).where(and(
    eq(schema.pages.documentId, documentId),
    eq(schema.pages.orgId, orgId),
  ));
  // Deleted documents count too: a deleted amendment that applied keeps its rows.
  const later = amendment.amendmentNo === null ? [] : (await db.select({ amendmentNo: schema.amendments.amendmentNo }).from(schema.amendments).where(and(
    eq(schema.amendments.orgId, orgId),
    eq(schema.amendments.bidId, amendment.bidId),
    gt(schema.amendments.amendmentNo, amendment.amendmentNo),
    inArray(schema.amendments.status, LATER_BLOCKS),
  )).orderBy(asc(schema.amendments.amendmentNo))).flatMap((row) => (row.amendmentNo === null ? [] : [row.amendmentNo]));
  return {
    amendment, document, bid, links, rowsFromText: rows?.n ?? 0, hits: hits.length, backfilled: Boolean(marker), pages: pages?.n ?? 0, later,
  };
}

/** Why the amendment is not backfilled, or null when it is in the pre-#22 shape and may be. */
function skipReason(facts: Facts, target: Target): string | null {
  const { amendment, document, bid } = facts;
  if (facts.backfilled) {
    return 'already backfilled';
  }
  if (amendment.documentId !== target.documentId || amendment.bidId !== target.bidId) {
    return 'amendment no longer matches its document and bid';
  }
  if (amendment.status !== 'applied' && amendment.status !== 'needs_confirmation') {
    return `status is ${amendment.status}`;
  }
  if (!document) {
    return 'document not found';
  }
  if (document.liveStatus === 'deleted') {
    return 'document deleted';
  }
  if (!bid) {
    return 'bid not found';
  }
  if (amendment.amendmentNo === null) {
    return 'no amendment number';
  }
  if (!(amendment.solicitationKeyFound || amendment.keyOverride)) {
    return 'key not matched or overridden';
  }
  if (!amendment.keyOverride && normalizeSolicitationKey(bid.solicitationKey) !== amendment.matchedKey) {
    return 'bid key changed since the key check';
  }
  if (bid.creditStatus !== 'consumed') {
    return `bid credit is ${bid.creditStatus ?? 'missing'}, not consumed`;
  }
  if (facts.rowsFromText > 0) {
    return 'already has rows from its text';
  }
  if (facts.links.some((link) => link.newRowId !== null || link.sourceQuote !== null)) {
    return 'links written by the post-#22 run';
  }
  if (facts.hits > 0) {
    return 'check these written by the post-#22 run';
  }
  if (facts.links.length === 0) {
    return 'no links; cannot tell pre/post-#22';
  }
  if (facts.later.length > 0) {
    return `later amendment ${facts.later[0]} exists; rows could duplicate`;
  }
  if (facts.pages === 0) {
    return 'no extracted text';
  }
  return null;
}

export interface BackfillOptions extends BackfillArgs {
  log?: (line: string) => void;
}

export interface BackfillReport {
  /** Amendments in the pre-#22 shape when read (before any lock). */
  eligible: number;
  backfilled: number;
  /** Not in the pre-#22 shape, including one that changed between the read and the lock. */
  skipped: number;
  /** Any failure: a read, a model pass or the write. The amendment is left as it was. */
  failed: number;
}

type Target = { orgId: string; bidId: string; amendmentId: string; documentId: string };

function field(value: string): string {
  return /^[\w.:/-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Runs the backfill for the organizations named (each read under its own `app.org_id`, as the
 * worker does; there is no cross-tenant path). Dry run unless `apply`: it lists each amendment
 * of the organization with what would change, reading in read-only transactions, and makes no
 * model call. With `apply`, each eligible amendment runs on its own: the model passes, then one
 * transaction. A failure is logged and leaves that amendment as it was. One line per amendment,
 * `key=value`, plus a summary line.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const mode = options.apply ? 'apply' : 'dry-run';
  const report: BackfillReport = { eligible: 0, backfilled: 0, skipped: 0, failed: 0 };
  const line = (target: Target, amendmentNo: number | null | undefined, parts: Record<string, string | number>) => log([
    'backfill-amendments', `mode=${mode}`, `org=${target.orgId}`, `bid=${target.bidId}`, `amendment=${target.amendmentId}`,
    `document=${target.documentId}`, `amd=${amendmentNo ?? '?'}`,
    ...Object.entries(parts).map(([key, value]) => `${key}=${typeof value === 'number' ? value : field(value)}`),
  ].join(' '));
  const failed = (target: Target, amendmentNo: number | null | undefined, error: unknown) => {
    report.failed += 1;
    line(target, amendmentNo, { result: 'failed', error: error instanceof Error ? error.message : String(error) });
  };

  for (const orgId of options.orgIds) {
    let targets: Target[];
    try {
      targets = await withOrg(orgId, async (db) => {
        await readOnly(db);
        return db.select({
          orgId: schema.amendments.orgId,
          bidId: schema.amendments.bidId,
          amendmentId: schema.amendments.id,
          documentId: schema.amendments.documentId,
        }).from(schema.amendments)
          .innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId))
          .where(and(
            eq(schema.amendments.orgId, orgId),
            eq(schema.documents.orgId, orgId),
            eq(schema.documents.kind, 'amendment'),
            options.bidId ? eq(schema.amendments.bidId, options.bidId) : undefined,
          ))
          .orderBy(asc(schema.amendments.bidId), asc(schema.amendments.amendmentNo), asc(schema.amendments.id));
      });
    } catch (error) {
      report.failed += 1;
      log(`backfill-amendments mode=${mode} org=${orgId} result=failed error=${field(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    for (const target of targets) {
      if (options.limit !== undefined && report.eligible >= options.limit) {
        break;
      }
      let facts: Facts | null = null;
      try {
        facts = await withOrg(orgId, async (db) => {
          await readOnly(db);
          return readFacts(db, orgId, target, false);
        });
        if (!facts) {
          continue;
        }
        const reason = skipReason(facts, target);
        const common = { status: facts.amendment.status, later_amendments: facts.later.length };
        if (reason) {
          report.skipped += 1;
          line(target, facts.amendment.amendmentNo, { ...common, result: 'skip', reason });
          continue;
        }
        report.eligible += 1;
        if (!options.apply) {
          line(target, facts.amendment.amendmentNo, {
            ...common,
            result: 'would-backfill',
            file: facts.document?.fileName ?? '',
            pages: facts.pages,
            links: facts.links.length,
            unpaired_supersedes: facts.links.filter((link) => link.action === 'supersede' && link.oldRowId && link.newRowId === null).length,
            links_without_quote: facts.links.filter((link) => link.action !== 'add' && link.sourceQuote === null).length,
            open_proposals: facts.links.filter((link) => link.status === 'proposed').length,
            writes: 'rows from its text, link new rows and quotes, replacement pointers, check these, ai_runs, audit_log; no status, credit or closure change',
          });
          continue;
        }
        const outcome = await backfillOne(target, facts);
        if ('skip' in outcome) {
          report.skipped += 1;
          line(target, facts.amendment.amendmentNo, { ...common, result: 'skip', reason: outcome.skip });
        } else {
          report.backfilled += 1;
          line(target, facts.amendment.amendmentNo, { ...common, result: 'backfilled', ...outcome });
        }
      } catch (error) {
        failed(target, facts?.amendment.amendmentNo, error);
      }
    }
  }
  log([
    'backfill-amendments', `mode=${mode}`, 'summary',
    `orgs=${options.orgIds.length}`,
    ...(options.bidId ? [`bid_filter=${options.bidId}`] : []),
    ...(options.limit !== undefined ? [`limit=${options.limit}`] : []),
    options.apply ? `backfilled=${report.backfilled}` : `would_backfill=${report.eligible}`,
    `skipped=${report.skipped}`,
    `failed=${report.failed}`,
  ].join(' '));
  return report;
}

interface Written {
  rows_inserted: number;
  links_paired: number;
  add_links: number;
  quotes_filled: number;
  pointers_set: number;
  proposals_unpaired: number;
  hits: number;
}

const byConfidence = (a: BackfillPair, b: BackfillPair) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.linkId.localeCompare(b.linkId);

/** One amendment: the model passes outside any transaction, then one write transaction. */
async function backfillOne(target: Target, read: Facts): Promise<Written | { skip: string }> {
  const started = Date.now();
  const { orgId, bidId, documentId } = target;
  const amendmentNo = read.amendment.amendmentNo ?? 0;
  const payload: JobPayload = { orgId, bidId, documentId, jobId: randomUUID(), storagePath: read.document?.storagePath ?? '', kind: 'amendment' };
  const threshold = await readLinkConfidence(orgId);
  const { provider, config } = providerForJob();
  const amendmentPages = await loadPages(orgId, documentId);
  const extracted = await extractRows({ pages: amendmentPages, provider, config, amendmentNo });
  // The diff sees only the rows this amendment's own links name, whatever their status now: it
  // tells which new row replaced each one. The bid's other active rows are not offered, so
  // nothing the earlier run or the user decided is reopened.
  const namedIds = [...new Set(read.links.flatMap((link) => (link.action !== 'add' && link.oldRowId ? [link.oldRowId] : [])))];
  const named: ExistingRow[] = namedIds.length === 0 ? [] : await withOrg(orgId, async (db) => {
    await readOnly(db);
    return db.select({
      id: schema.complianceRows.id,
      reqId: schema.complianceRows.reqId,
      sectionRef: schema.complianceRows.sectionRef,
      requirementText: schema.complianceRows.requirementText,
      sourceQuote: schema.complianceRows.sourceQuote,
    }).from(schema.complianceRows).where(and(
      inArray(schema.complianceRows.id, namedIds),
      eq(schema.complianceRows.bidId, bidId),
      eq(schema.complianceRows.orgId, orgId),
    ));
  });
  const diff = named.length === 0 || extracted.requirements.length === 0
    ? { links: [] as DiffLink[], dropped: 0, tokensUsed: 0 }
    : await diffAmendment({ newRows: extracted.requirements, existing: named, amendmentPages, provider, config });
  const map = await mapRows({ rows: extracted.requirements, pages: await setPages(payload), provider, config });
  const checkThese = coverage(extracted.hits, extracted.requirements);
  const tokens = extracted.tokensUsed + diff.tokensUsed + map.tokensUsed;

  return withOrg(orgId, async (db): Promise<Written | { skip: string }> => {
    const facts = await readFacts(db, orgId, target, true);
    const reason = facts ? skipReason(facts, target) : 'amendment not found';
    if (!facts || reason) {
      return { skip: reason ?? 'amendment not found' };
    }
    const now = facts.amendment.amendmentNo!;
    const plan = planBackfill(facts.links.map((link) => ({
      id: link.id, action: link.action, status: link.status, oldRowId: link.oldRowId, newRowId: link.newRowId, sourceQuote: link.sourceQuote,
    })), extracted.requirements, diff.links, threshold);
    // The old rows the pairs name, locked by id after the links (credits.ts lock order).
    const pairedIds = [...new Set(plan.pairs.map((pair) => pair.oldRowId))];
    const oldRows = pairedIds.length === 0 ? [] : await db.select().from(schema.complianceRows).where(and(
      inArray(schema.complianceRows.id, pairedIds),
      eq(schema.complianceRows.bidId, bidId),
      eq(schema.complianceRows.orgId, orgId),
    )).orderBy(asc(schema.complianceRows.id)).for('update');
    const oldById = new Map(oldRows.map((row) => [row.id, row]));
    const linkById = new Map(facts.links.map((link) => [link.id, link]));
    // A row removed since the earlier run cannot be paired: its new row gets an add link instead.
    const pairs = plan.pairs.filter((pair) => oldById.has(pair.oldRowId));
    const pairedNew = new Set(pairs.map((pair) => pair.newRowId));
    const addRowIds = plan.inserts.filter((row) => !pairedNew.has(row.id)).map((row) => row.id);
    const pairedLinks = new Set(pairs.map((pair) => pair.linkId));
    const proposalsUnpaired = facts.links.filter((link) => link.action === 'supersede' && link.status === 'proposed'
      && link.newRowId === null && !pairedLinks.has(link.id)).length;
    // A replacement the earlier run applied (auto) or the user confirmed: the new row takes the
    // references the map left empty from the row it replaces, the highest-confidence one first
    // (as the live run's inheritReferences), and that row points at it.
    const replaces = pairs.filter((pair) => {
      const status = linkById.get(pair.linkId)?.status;
      return status === 'auto' || status === 'confirmed';
    }).sort(byConfidence);
    const insertById = new Map(plan.inserts.map((row) => [row.id, row]));
    for (const pair of replaces) {
      const row = insertById.get(pair.newRowId)!;
      const old = oldById.get(pair.oldRowId)!;
      row.instrRef ??= old.instrRef ?? undefined;
      row.evalRef ??= old.evalRef ?? undefined;
      row.responseSection ??= old.responseSection ?? undefined;
    }

    const reqIds = await allocateReqIds(db, orgId, bidId, plan.inserts);
    for (const chunk of chunks(plan.inserts.map((row, index) => ({ row, reqId: reqIds[index] })))) {
      await db.insert(schema.complianceRows).values(chunk.map(({ row, reqId }) => ({
        id: row.id,
        orgId,
        bidId,
        reqId,
        sectionRef: row.sectionRef,
        requirementText: row.requirementText,
        documentId,
        sourcePage: row.sourcePage,
        sourcePageEnd: row.sourcePageEnd,
        sourceQuote: row.sourceQuote,
        quoteVerified: true,
        amendmentNo: now,
        origin: 'ai' as const,
        confidence: row.confidence.toFixed(2),
        flags: row.flags,
        reqType: row.reqType,
        instrRef: row.instrRef,
        evalRef: row.evalRef,
        responseSection: row.responseSection,
        supersedeStatus: 'active' as const,
      })));
    }
    const filled = new Set<string>();
    let quotesFilled = 0;
    const fill = async (linkId: string, values: { newRowId?: string; sourcePage: number | null; sourceQuote: string | null }) => {
      const link = linkById.get(linkId)!;
      const quote = link.sourceQuote === null && values.sourceQuote !== null;
      if (quote) {
        quotesFilled += 1;
      }
      await db.update(schema.amendmentLinks).set({
        ...(values.newRowId ? { newRowId: values.newRowId } : {}),
        ...(quote ? { sourcePage: values.sourcePage, sourceQuote: values.sourceQuote } : {}),
        updatedAt: new Date(),
      }).where(and(eq(schema.amendmentLinks.id, linkId), eq(schema.amendmentLinks.orgId, orgId)));
      filled.add(linkId);
    };
    for (const pair of pairs) {
      await fill(pair.linkId, { newRowId: pair.newRowId, sourcePage: pair.sourcePage, sourceQuote: pair.sourceQuote });
    }
    for (const quote of plan.quoteFills) {
      await fill(quote.linkId, quote);
    }
    // Only an empty pointer on a row that is still superseded is set, to its highest-confidence
    // replacement; changed_by_amendment only when 0009 could not set it.
    const pointed: { rowId: string; prevChangedByAmendment: number | null }[] = [];
    for (const pair of replaces) {
      const old = oldById.get(pair.oldRowId)!;
      if (old.supersedeStatus !== 'superseded' || old.supersededByRowId !== null || pointed.some((item) => item.rowId === old.id)) {
        continue;
      }
      await db.update(schema.complianceRows).set({
        supersededByRowId: pair.newRowId,
        changedByAmendment: old.changedByAmendment ?? now,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.complianceRows.id, old.id),
        eq(schema.complianceRows.bidId, bidId),
        eq(schema.complianceRows.orgId, orgId),
        eq(schema.complianceRows.supersedeStatus, 'superseded'),
        isNull(schema.complianceRows.supersededByRowId),
      ));
      pointed.push({ rowId: old.id, prevChangedByAmendment: old.changedByAmendment });
    }
    const addLinks = addRowIds.length === 0 ? [] : await db.insert(schema.amendmentLinks).values(addRowIds.map((newRowId) => ({
      orgId,
      amendmentId: target.amendmentId,
      rowTable: 'compliance_rows',
      oldRowId: null,
      newRowId,
      action: 'add' as const,
      confidence: null,
      status: 'auto' as const,
      sourcePage: null,
      sourceQuote: null,
    }))).returning({ id: schema.amendmentLinks.id });
    await replaceCheckThese(db, payload, checkThese);
    await recordRun({
      orgId,
      bidId,
      task: BACKFILL_TASK,
      provider: config.providerName,
      model: config.model,
      skillName: extracted.skillName,
      skillVersion: extracted.skillVersion,
      tokens,
      costUsd: costOf(config.providerName, tokens),
      durationMs: Date.now() - started,
      status: 'completed',
    }, db);
    const written: Written = {
      rows_inserted: plan.inserts.length,
      links_paired: pairs.length,
      add_links: addLinks.length,
      quotes_filled: quotesFilled,
      pointers_set: pointed.length,
      proposals_unpaired: proposalsUnpaired,
      hits: checkThese.length,
    };
    // The record of what was written (to undo it by id) and the marker a second run stops at.
    // Filled links had null new_row_id, source_page and source_quote before; pointed rows had a
    // null superseded_by_row_id and the changed_by_amendment recorded here.
    await db.insert(schema.auditLog).values({
      orgId,
      action: BACKFILL_ACTION,
      targetType: 'amendment',
      targetId: target.amendmentId,
      detail: {
        documentId,
        amendmentNo: now,
        insertedRowIds: plan.inserts.map((row) => row.id),
        addLinkIds: addLinks.map((link) => link.id),
        filledLinkIds: [...filled].sort(),
        pointedRows: pointed,
        ...written,
      },
    });
    return written;
  });
}
