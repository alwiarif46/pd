import type { AmendmentLinkDto, BidDto, DocumentDto, JobDto } from '@/api';
import type { AmendmentProposal, Plan, ProcessingState, ProcessingStep, Tab, TabBlock, TabSignal } from '@/types';
import { PAID_TABS } from '@/features/shell/routes';

/**
 * Pure derivations for TabFrame (09 s5.12) and the shell's tab signals (09 s5.1), from the bid state the
 * shell loads (bid, documents, jobs, amendment links) and the organization's plan and credits.
 */

/** What the shell knows about the open bid. */
export interface BidSnapshot {
  plan: Plan;
  creditsLeft: number;
  creditsResetOn: string;
  /** Files per bid, in MB. */
  mbCap: number;
  bid: BidDto | null;
  docs: DocumentDto[];
  jobs: JobDto[];
  links: AmendmentLinkDto[];
}

export interface MarkingRequest {
  documentId: string;
  fileName: string;
  markings: string[];
  page: number | null;
}

export interface TabFrameModel {
  block: TabBlock | null;
  processing: ProcessingState | null;
  markings: MarkingRequest[];
  proposals: AmendmentProposal[];
  overCap: { usedBytes: number; capMb: number } | null;
  draftNotice: boolean;
  /** The failed job "Try again" retries, when the block is `failed`. */
  retryJobId: string | null;
}

/** 05 s3: what each paid tab does, for the locked state. */
export const LOCKED_DESCRIPTIONS: Partial<Record<Tab, string>> = {
  outline: 'A volume and section tree with page budgets, writers, and due dates.',
  resumes: 'Roles and requirements beside candidate resumes, with gaps called out.',
  reviews: 'Pink, red, green, and gold team findings against the evaluation factors.',
  production: 'A submission checklist drawn from the solicitation.',
  orals: 'Orals rules, a preparation checklist, and a session plan.',
  lessons: 'A short survey after submission or award.',
};

const MB = 1024 * 1024;

/** Pipeline stages and job types, as a person reads them. */
const STEP_LABELS: Record<string, string> = {
  scan: 'Virus scan',
  file: 'Read the file',
  marking: 'Marking check',
  classify: 'Classify pages',
  'ai:overview': 'Bid facts',
  overview: 'Bid facts',
  'ai:dates': 'Dates',
  dates: 'Dates',
  'ai:compliance': 'Compliance matrix',
  compliance: 'Compliance matrix',
  'ai:amendment': 'Amendment changes',
  amendment: 'Amendment changes',
};

/** Stages every tab waits on (reading the file); the AI stages each fill one tab. */
const READ_STAGES = new Set(['scan', 'file', 'marking', 'classify']);
const STAGE_TAB: Record<string, Tab> = {
  'ai:overview': 'overview',
  overview: 'overview',
  'ai:dates': 'schedule',
  dates: 'schedule',
  'ai:compliance': 'compliance',
  compliance: 'compliance',
  'ai:amendment': 'compliance',
  amendment: 'compliance',
};

export function stepKey(job: JobDto): string {
  return job.stage ?? job.type;
}

export function stepLabel(job: JobDto): string {
  return STEP_LABELS[stepKey(job)] ?? 'Processing';
}

export function isLive(doc: DocumentDto): boolean {
  return doc.liveStatus !== 'deleted';
}

export function isActive(job: JobDto): boolean {
  return job.status === 'pending' || job.status === 'running';
}

/** A document still in the pipeline (scan or text extraction not finished). */
export function isProcessing(doc: DocumentDto): boolean {
  return isLive(doc) && (doc.scanStatus === 'pending' || doc.extractStatus === 'pending');
}

/**
 * Failed jobs that still matter: the latest job for each document and type failed (a retry that
 * succeeded clears it), and its document, if it has one, is still on the bid.
 */
export function failedJobs(jobs: JobDto[], docs: DocumentDto[]): JobDto[] {
  const latest = new Map<string, JobDto>();
  for (const job of jobs) {
    const key = `${job.documentId ?? ''}\u0000${job.type}`;
    const seen = latest.get(key);
    if (!seen || job.createdAt > seen.createdAt || (job.createdAt === seen.createdAt && job.id > seen.id)) {
      latest.set(key, job);
    }
  }
  const live = new Set(docs.filter(isLive).map((doc) => doc.id));
  return [...latest.values()]
    .filter((job) => job.status === 'failed' && (job.documentId === null || live.has(job.documentId)))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** A plain reason for a failed job, from the document and job state. Never the job's error text. */
export function failureReason(job: JobDto, docs: DocumentDto[]): string {
  const doc = job.documentId ? docs.find((d) => d.id === job.documentId) : undefined;
  if (doc?.encryption === 'user_password') return 'Upload an unlocked copy.';
  if (doc?.scanStatus === 'infected') return 'This file did not pass the virus scan. Remove it and upload a clean copy.';
  if (READ_STAGES.has(stepKey(job)) || doc?.extractStatus === 'rejected') return 'We could not read this file.';
  return `${stepLabel(job)} stopped before it finished.`;
}

function liveSolicitations(docs: DocumentDto[]): DocumentDto[] {
  return docs.filter((doc) => isLive(doc) && doc.kind === 'solicitation');
}

/** A failure blocks a tab when it is the solicitation's (or the bid's) and the stage fills that tab. */
function blockingFailure(tab: Tab, jobs: JobDto[], docs: DocumentDto[]): JobDto | null {
  const solicitationIds = new Set(liveSolicitations(docs).map((doc) => doc.id));
  return (
    failedJobs(jobs, docs).find((job) => {
      if (job.documentId !== null && !solicitationIds.has(job.documentId)) return false;
      const key = stepKey(job);
      return READ_STAGES.has(key) || STAGE_TAB[key] === tab;
    }) ?? null
  );
}

/** ProcessingState from the active jobs: one step per job, the lowest queue position, the longest wait. */
export function processingState(jobs: JobDto[], docs: DocumentDto[]): ProcessingState | null {
  const active = jobs.filter(isActive);
  if (active.length === 0) return null;
  const names = new Map(docs.map((doc) => [doc.id, doc.fileName]));
  const steps: ProcessingStep[] = active.map((job) => {
    const fileName = job.documentId ? names.get(job.documentId) : undefined;
    return {
      id: job.id,
      label: fileName ? `${stepLabel(job)} (${fileName})` : stepLabel(job),
      status: job.status === 'running' ? 'running' : 'waiting',
      percent: Math.max(0, Math.min(100, Math.round(job.progress))),
    };
  });
  const positions = active.map((job) => job.queuePosition).filter((n): n is number => n !== null);
  const etas = active.map((job) => job.etaSeconds).filter((n): n is number => n !== null);
  return {
    steps,
    queuePosition: positions.length ? Math.min(...positions) : null,
    etaSeconds: etas.length ? Math.max(...etas) : null,
  };
}

/** `confidence` is a decimal string from pg; anything unreadable is shown as no confidence. */
export function toConfidence(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Proposed supersede and withdraw links on compliance rows, as cards. Adds are always applied, so they are never
 * proposed. Fact and date proposals are shown on Overview and Schedule from their tab payloads, not here.
 */
export function toProposals(links: AmendmentLinkDto[]): AmendmentProposal[] {
  return links
    .filter((link) => link.rowTable === 'compliance_rows' && link.status === 'proposed' && link.action !== 'add')
    .map((link) => ({
      id: link.id,
      amendmentNo: link.amendmentNo ?? 0,
      action: link.action,
      confidence: toConfidence(link.confidence),
      oldRow: link.oldRow,
      newRow: link.newRow,
    }));
}

export function markingRequests(docs: DocumentDto[]): MarkingRequest[] {
  return docs
    .filter((doc) => isLive(doc) && doc.markingStatus === 'blocked')
    .map((doc) => ({
      documentId: doc.id,
      fileName: doc.fileName,
      markings: doc.markingFound && doc.markingFound.length > 0 ? doc.markingFound : ['a controlled marking'],
      page: doc.markingPage,
    }));
}

export function usedBytes(docs: DocumentDto[]): number {
  return docs.filter(isLive).reduce((sum, doc) => sum + doc.sizeBytes, 0);
}

/** Tabs that show amendment proposals in "Needs you". */
const PROPOSAL_TABS: ReadonlySet<Tab> = new Set(['compliance', 'documents']);

/**
 * The TabFrame states for `tab` (05 s4). Block precedence: locked (a paid tab on Free), then no
 * solicitation, then out of credits, then failed. Documents and Settings are never blocked (that is where
 * files are uploaded and the bid is fixed), and Settings shows no banners.
 */
export function deriveTabFrame(ctx: BidSnapshot, tab: Tab, opts: { hasAiRows?: boolean } = {}): TabFrameModel {
  const empty: TabFrameModel = {
    block: null,
    processing: null,
    markings: [],
    proposals: [],
    overCap: null,
    draftNotice: false,
    retryJobId: null,
  };
  if (ctx.plan === 'free' && PAID_TABS.includes(tab)) {
    return { ...empty, block: { kind: 'locked', description: LOCKED_DESCRIPTIONS[tab] ?? '' } };
  }
  if (tab === 'settings') return empty;

  const processing = processingState(ctx.jobs, ctx.docs);
  const used = usedBytes(ctx.docs);
  const model: TabFrameModel = {
    ...empty,
    processing,
    markings: markingRequests(ctx.docs),
    proposals: PROPOSAL_TABS.has(tab) ? toProposals(ctx.links) : [],
    overCap: used >= ctx.mbCap * MB ? { usedBytes: used, capMb: ctx.mbCap } : null,
    draftNotice: Boolean(opts.hasAiRows) && processing === null,
  };
  if (tab === 'documents') return model;

  const hasSolicitation = liveSolicitations(ctx.docs).length > 0;
  if (!hasSolicitation) return { ...model, block: { kind: 'no_solicitation' } };

  const creditStatus = ctx.bid?.creditStatus ?? null;
  if ((creditStatus === null || creditStatus === 'released') && ctx.creditsLeft <= 0) {
    return {
      ...model,
      block: { kind: 'out_of_credits', creditsLeft: ctx.creditsLeft, creditsResetOn: ctx.creditsResetOn },
    };
  }

  const failure = blockingFailure(tab, ctx.jobs, ctx.docs);
  if (failure) {
    return { ...model, block: { kind: 'failed', reason: failureReason(failure, ctx.docs) }, retryJobId: failure.id };
  }
  return model;
}

/* ---- Tab signals (09 s5.1) ---- */

const COMPLIANCE_STAGES = new Set(['ai:compliance', 'compliance', 'ai:amendment', 'amendment']);

function pick(flags: { waiting: boolean; failed: boolean; processing: boolean }): TabSignal | null {
  if (flags.waiting) return 'waiting';
  if (flags.failed) return 'failed';
  if (flags.processing) return 'processing';
  return null;
}

/**
 * The sidebar signals. Bid-wide state goes on Documents (any active job; a blocked marking or an
 * amendment whose solicitation number does not match; any failed job); compliance state goes on
 * Compliance (its AI stages running or failed; proposed amendment changes). One signal per tab:
 * waiting (needs you) wins over failed, which wins over processing.
 */
export function tabSignals(docs: DocumentDto[], jobs: JobDto[], links: AmendmentLinkDto[]): { tab: Tab; signal: TabSignal }[] {
  const active = jobs.filter(isActive);
  const failed = failedJobs(jobs, docs);
  const live = docs.filter(isLive);
  const out: { tab: Tab; signal: TabSignal }[] = [];

  const documents = pick({
    waiting: live.some((doc) => doc.markingStatus === 'blocked' || doc.keyCheck === 'mismatch'),
    failed: failed.length > 0,
    processing: active.length > 0 || live.some(isProcessing),
  });
  if (documents) out.push({ tab: 'documents', signal: documents });

  const compliance = pick({
    waiting: toProposals(links).length > 0,
    failed: failed.some((job) => COMPLIANCE_STAGES.has(stepKey(job))),
    processing: active.some((job) => COMPLIANCE_STAGES.has(stepKey(job))),
  });
  if (compliance) out.push({ tab: 'compliance', signal: compliance });
  return out;
}

export const SIGNAL_LABELS: Record<TabSignal, string> = {
  processing: 'Processing',
  waiting: 'Needs you',
  failed: 'Failed',
};
