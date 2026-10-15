import { type AnyPgColumn, index, pgTable, uniqueIndex, uuid, text, timestamp, boolean, integer, jsonb, decimal } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { ActivityKind, ActivityOrigin, ReviewColor } from '../schedule';
import type { DateKey, FactKey, TabsStatus } from '../amendment-tabs';

/** documents.key_status values (migration 0008). */
export type KeyStatus = 'match' | 'mismatch' | 'not_found' | 'bid_key_pending' | 'overridden';
/**
 * amendments.status values (migrations 0008, 0009). 'needs_number': the key matched (or was
 * overridden) but the amendment number could not be settled (the number in the file is taken by
 * another amendment, or page 1 names two numbers); the user sets it. 'failed': the amendment step
 * threw; a retry returns it to processing.
 */
export type AmendmentStatus = 'held' | 'processing' | 'needs_number' | 'failed' | 'needs_confirmation' | 'applied';
/**
 * documents.amendment_no_source values (migration 0009): 'user' typed at upload or set later,
 * 'document' read from the file, 'sequence' the next number on the bid (shown as assumed).
 */
export type AmendmentNoSource = 'user' | 'document' | 'sequence';

// Base columns for all tables
const baseColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
};

// =============================================================================
// Accounts and Billing
// =============================================================================

export const users = pgTable('users', {
  ...baseColumns,
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at'),
  phoneE164: text('phone_e164').unique(),
  phoneVerifiedAt: timestamp('phone_verified_at'),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  lastLoginAt: timestamp('last_login_at'),
});

export const organizations = pgTable('organizations', {
  ...baseColumns,
  name: text('name').notNull(),
  emailDomain: text('email_domain'),
  plan: text('plan').notNull().$type<'free' | 'starter' | 'growth'>(),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // 'free' on the free plan; 'active' or 'past_due' on a paid plan (06 s5). CHECK in 0007.
  planStatus: text('plan_status').notNull().$type<'active' | 'past_due' | 'free'>(),
  cycleStart: timestamp('cycle_start'),
  cycleEnd: timestamp('cycle_end'),
  freeFirstMonthEnds: timestamp('free_first_month_ends'),
}, (table) => ({
  // One organization per Stripe customer. NULLs are distinct in a unique index, so
  // organizations without a customer are not constrained.
  stripeCustomer: uniqueIndex('organizations_stripe_customer_uq').on(table.stripeCustomerId),
}));

export const memberships = pgTable('memberships', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull().$type<'owner' | 'member'>(),
});

export const invites = pgTable('invites', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  role: text('role').notNull().$type<'owner' | 'member'>(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  acceptedAt: timestamp('accepted_at'),
});

export const sessions = pgTable('sessions', {
  ...baseColumns,
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  lastSeenAt: timestamp('last_seen_at'),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const authTokens = pgTable('auth_tokens', {
  ...baseColumns,
  userId: uuid('user_id').notNull().references(() => users.id),
  purpose: text('purpose').notNull().$type<'verify_email' | 'reset_password'>(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
});

export const rfpCredits = pgTable('rfp_credits', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  allowed: integer('allowed').notNull(),
  used: integer('used').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
}, (table) => ({
  orgPeriod: uniqueIndex('rfp_credits_org_period_uq').on(table.orgId, table.periodStart),
}));

export const phoneCodes = pgTable('phone_codes', {
  ...baseColumns,
  /** The account the code was sent for. verify-phone accepts only that account's latest code. */
  userId: uuid('user_id').references(() => users.id),
  phoneE164: text('phone_e164').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: timestamp('used_at'),
}, (table) => ({
  userCreatedIdx: index('phone_codes_user_id_created_at_idx').on(table.userId, table.createdAt),
}));

export const stripeEvents = pgTable('stripe_events', {
  ...baseColumns,
  eventId: text('event_id').notNull().unique(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at').notNull(),
  processedAt: timestamp('processed_at'),
});

export const auditLog = pgTable('audit_log', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  detail: jsonb('detail'),
});

// =============================================================================
// Bids and Documents
// =============================================================================

export const bids = pgTable('bids', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  agency: text('agency'),
  bidType: text('bid_type').notNull().$type<'federal' | 'sled'>(),
  solicitationNumber: text('solicitation_number').notNull(),
  solicitationKey: text('solicitation_key').notNull(),
  // CHECK bids_status_check (migration 0005, hand-written) allows only these values.
  status: text('status').notNull().default('planning').$type<'planning' | 'writing' | 'submitted' | 'closed'>(),
  startDate: timestamp('start_date'),
  dueDate: timestamp('due_date'),
  dueTime: text('due_time'),
  timeZone: text('time_zone'),
  countMode: text('count_mode'),
  oralsEnabled: boolean('orals_enabled').notNull().default(false),
  creditId: uuid('credit_id').references(() => rfpCredits.id),
  creditStatus: text('credit_status').$type<'reserved' | 'consumed' | 'released'>(),
  keyOverridesUsed: integer('key_overrides_used').notNull().default(0),
  retentionExtendedUntil: timestamp('retention_extended_until'),
  // The schedule's "Workdays only" setting (migration 0010): shift, scale, and templates skip
  // weekends and US federal holidays when true (packages/core schedule.ts).
  scheduleWorkdaysOnly: boolean('schedule_workdays_only').notNull().default(true),
});

export const documents = pgTable('documents', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  kind: text('kind').notNull().$type<'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft'>(),
  // Amendments only: 1 to 999 (CHECK documents_amendment_no_check, migration 0009). Unique among
  // the bid's amendments that are not deleted (documents_bid_amendment_no_uq). The index is a
  // backstop: the worker and the api check the full rule, which also keeps the number of a
  // deleted amendment that wrote rows (packages/core amendment-numbers.ts).
  amendmentNo: integer('amendment_no'),
  // Where amendment_no came from (CHECK documents_amendment_no_source_check, migration 0009).
  amendmentNoSource: text('amendment_no_source').$type<AmendmentNoSource>(),
  // The amendment number read from the file, when one was found (it may differ from a typed one).
  amendmentNoFound: integer('amendment_no_found'),
  storagePath: text('storage_path'),
  viewerPath: text('viewer_path'),
  extractMethod: text('extract_method').$type<'pdf_text' | 'ocr' | 'docx_pdf' | 'docx_text_fallback' | 'xlsx'>(),
  pagesEstimated: integer('pages_estimated'),
  pageCount: integer('page_count'),
  encryption: text('encryption').$type<'none' | 'owner_password' | 'user_password'>(),
  scanStatus: text('scan_status'),
  extractStatus: text('extract_status'),
  markingFound: jsonb('marking_found').$type<string[]>(),
  markingStatus: text('marking_status').$type<'none' | 'blocked' | 'confirmed'>(),
  // The lowest page a marking was found on (the marking step writes it), or null.
  markingPage: integer('marking_page'),
  // Not written yet: the api computes the live-until date it shows (packages/core retention.ts);
  // the retention job will store it here.
  liveUntil: timestamp('live_until'),
  liveStatus: text('live_status').$type<'live' | 'archived' | 'restore_requested' | 'restoring' | 'restored' | 'deleted'>(),
  // Amendments only: the solicitation-number check (04 s3.1 step 1); null until it runs and on
  // every other kind. CHECK documents_key_status_check (migration 0008, hand-written).
  keyStatus: text('key_status').$type<KeyStatus>(),
  // The number the check found: the matched text on a match, else the top labelled candidate.
  keyFound: text('key_found'),
}, (table) => ({
  bidAmendmentNo: uniqueIndex('documents_bid_amendment_no_uq').on(table.bidId, table.amendmentNo)
    .where(sql`kind = 'amendment' and amendment_no is not null and live_status is distinct from 'deleted'`),
}));

export const uploadSessions = pgTable('upload_sessions', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  fileName: text('file_name').notNull(),
  kind: text('kind').notNull().$type<'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft'>(),
  declaredSize: integer('declared_size').notNull(),
  sha256: text('sha256').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  chunksReceived: integer('chunks_received').notNull().default(0),
  bytesReceived: integer('bytes_received').notNull().default(0),
  status: text('status').notNull().$type<'open' | 'complete' | 'expired' | 'cancelled'>(),
  expiresAt: timestamp('expires_at').notNull(),
  // The credit this session reserved for its bid, if any. Released when the session is abandoned.
  creditId: uuid('credit_id').references(() => rfpCredits.id),
  // Amendments only: the number typed at upload, 1 to 999 (CHECK in migration 0009).
  amendmentNo: integer('amendment_no'),
});

export const amendments = pgTable('amendments', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  // Mirrors documents.amendment_no: null until the number is settled (migration 0009).
  amendmentNo: integer('amendment_no'),
  solicitationKeyFound: boolean('solicitation_key_found').notNull(),
  keyOverride: boolean('key_override').notNull().default(false),
  overrideReason: text('override_reason'),
  // CHECK amendments_status_check (migration 0008, hand-written). 'held': the key check did not
  // match and there is no override, so no AI step runs.
  status: text('status').notNull().$type<AmendmentStatus>(),
  datesChanged: jsonb('dates_changed'),
  // The bid key the check compared against; the AI write goes ahead only while the bid has it.
  matchedKey: text('matched_key'),
  // Step 8, the bid facts and dates (CHECK amendments_tabs_status_check, migration 0011):
  // 'pending' once the compliance apply queued it, 'applied', or 'failed' until a retry; null when
  // step 8 never queued (amendments applied before 0011).
  tabsStatus: text('tabs_status').$type<TabsStatus>(),
}, (table) => ({
  // One amendments row per document (migration 0008 dedupes first); the key check upserts on it.
  document: uniqueIndex('amendments_document_uq').on(table.documentId),
}));

export const amendmentLinks = pgTable('amendment_links', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  amendmentId: uuid('amendment_id').notNull().references(() => amendments.id, { onDelete: 'cascade' }),
  rowTable: text('row_table').notNull(),
  oldRowId: uuid('old_row_id'),
  newRowId: uuid('new_row_id'),
  action: text('action').notNull().$type<'supersede' | 'withdraw' | 'add'>(),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  status: text('status').notNull().$type<'auto' | 'proposed' | 'confirmed' | 'rejected'>(),
  decidedBy: uuid('decided_by').references(() => users.id),
  // The amendment text that justifies a supersede or withdraw, quote-checked against the
  // amendment's pages (migration 0009); null on add links and on links written before 0009.
  sourcePage: integer('source_page'),
  sourceQuote: text('source_quote'),
}, (table) => ({
  amendmentIdx: index('amendment_links_amendment_id_idx').on(table.amendmentId),
  oldRowIdx: index('amendment_links_old_row_id_idx').on(table.oldRowId),
  newRowIdx: index('amendment_links_new_row_id_idx').on(table.newRowId),
}));

export const pages = pgTable('pages', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNo: integer('page_no').notNull(),
  text: text('text').notNull(),
  ocrUsed: boolean('ocr_used').notNull().default(false),
  sectionTag: text('section_tag').$type<'instructions' | 'evaluation' | 'scope' | 'terms' | 'attachments' | 'other'>(),
});

export const archiveObjects = pgTable('archive_objects', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Null once the document (or its bid) is deleted: the row stays so the purge job can delete
  // the archive copy (07 s2).
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  objectType: text('object_type').notNull().$type<'original' | 'viewer'>(),
  archiveKey: text('archive_key').notNull(),
  archivedAt: timestamp('archived_at').notNull(),
  expiresAt: timestamp('expires_at'),
  restoreStatus: text('restore_status').$type<'none' | 'requested' | 'restoring' | 'restored'>(),
  restoreRequestedAt: timestamp('restore_requested_at'),
  restoredUntil: timestamp('restored_until'),
  purgedAt: timestamp('purged_at'),
});

export const jobs = pgTable('jobs', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull(),
  progress: integer('progress').notNull().default(0),
  queuePosition: integer('queue_position'),
  error: text('error'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
});

export const exports = pgTable('exports', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  tab: text('tab').notNull(),
  format: text('format').notNull(),
  storagePath: text('storage_path').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at').notNull(),
});

// =============================================================================
// AI Records and Settings
// =============================================================================

export const aiRuns = pgTable('ai_runs', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'set null' }),
  task: text('task').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  skillName: text('skill_name'),
  skillVersion: text('skill_version'),
  promptVersion: text('prompt_version'),
  status: text('status').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  durationMs: integer('duration_ms'),
});

export const aiSettings = pgTable('ai_settings', {
  ...baseColumns,
  task: text('task').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  temperature: decimal('temperature', { precision: 3, scale: 2 }),
  chunkTokens: integer('chunk_tokens').notNull(),
  active: boolean('active').notNull().default(true),
});

export const providerSettings = pgTable('provider_settings', {
  ...baseColumns,
  provider: text('provider').notNull(),
  maxConcurrent: integer('max_concurrent').notNull(),
  perBidCap: integer('per_bid_cap').notNull(),
});

export const appSettings = pgTable('app_settings', {
  ...baseColumns,
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
});

export const aiUsageDaily = pgTable('ai_usage_daily', {
  ...baseColumns,
  day: timestamp('day').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  tokens: integer('tokens').notNull().default(0),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
});

// =============================================================================
// Relations
// =============================================================================

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  invites: many(invites),
  rfpCredits: many(rfpCredits),
  bids: many(bids),
  auditLogs: many(auditLog),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
  authTokens: many(authTokens),
  exports: many(exports),
  amendmentLinks: many(amendmentLinks),
}));

export const bidsRelations = relations(bids, ({ many }) => ({
  documents: many(documents),
  amendments: many(amendments),
  jobs: many(jobs),
  exports: many(exports),
  bidFacts: many(bidFacts),
  kickoffItems: many(kickoffItems),
  scheduleActivities: many(scheduleActivities),
  complianceRows: many(complianceRows),
  outlineItems: many(outlineItems),
  personnelRequirements: many(personnelRequirements),
  candidates: many(candidates),
  reviews: many(reviews),
  productionItems: many(productionItems),
  oralsItems: many(oralsItems),
  lessons: many(lessons),
}));

// =============================================================================
// Tab Data (Source columns on every source-bearing table)
// =============================================================================

// Common source columns mixin
const sourceColumns = {
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  sourcePage: integer('source_page'),
  sourcePageEnd: integer('source_page_end'),
  sourceQuote: text('source_quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  amendmentNo: integer('amendment_no').notNull().default(0),
  // 'proposed' (bid_facts and schedule_activities only, PR5): an amendment's replacement for a row
  // a user touched, not part of the tab until the user inserts it (packages/core amendment-tabs.ts).
  supersedeStatus: text('supersede_status').$type<'active' | 'superseded' | 'withdrawn' | 'proposed'>(),
  supersededByRowId: uuid('superseded_by_row_id'),
  changedByAmendment: integer('changed_by_amendment'),
  origin: text('origin').$type<'ai' | 'user'>(),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  flags: jsonb('flags').$type<string[]>(),
};

export const bidFacts = pgTable('bid_facts', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  value: text('value').notNull(),
  ...sourceColumns,
  confirmed: boolean('confirmed').notNull().default(false),
  // CHECK bid_facts_fact_key_check (migration 0011): the FACT_KEYS list; factKeyOf(field).
  factKey: text('fact_key').notNull().default('other').$type<FactKey>(),
}, (table) => ({
  bidFactKeyIdx: index('bid_facts_bid_id_fact_key_idx').on(table.bidId, table.factKey),
}));

export const kickoffItems = pgTable('kickoff_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  done: boolean('done').notNull().default(false),
  owner: text('owner'),
  note: text('note'),
});

export const scheduleActivities = pgTable('schedule_activities', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  phase: text('phase'),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  time: text('time'),
  owner: text('owner'),
  artifact: text('artifact'),
  note: text('note'),
  status: text('status'),
  locked: boolean('locked').notNull().default(false),
  ...sourceColumns,
  // CHECK schedule_activities_origin_check (migration 0010): 'template' rows came from a schedule template.
  origin: text('origin').$type<ActivityOrigin>(),
  // CHECK schedule_activities_kind_check (migration 0010): the ACTIVITY_KINDS list.
  kind: text('kind').notNull().default('custom').$type<ActivityKind>(),
  // CHECK schedule_activities_review_color_check (REVIEW_COLORS) and
  // schedule_activities_review_color_kind_check (only a 'review' has a color), migration 0010.
  reviewColor: text('review_color').$type<ReviewColor>(),
  // CHECK schedule_activities_date_key_check (migration 0011): the DATE_KEYS list. Only a dated AI
  // row has a key other than 'other' (classifyDateHit).
  dateKey: text('date_key').notNull().default('other').$type<DateKey>(),
}, (table) => ({
  bidDateKeyIdx: index('schedule_activities_bid_id_date_key_idx').on(table.bidId, table.dateKey),
}));

export const complianceRows = pgTable('compliance_rows', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  reqId: text('req_id').notNull(),
  sectionRef: text('section_ref'),
  requirementText: text('requirement_text').notNull(),
  ...sourceColumns,
  reqType: text('req_type').$type<'shall' | 'must' | 'will' | 'should' | 'other'>(),
  instrRef: text('instr_ref'),
  evalRef: text('eval_ref'),
  responseSection: text('response_section'),
  owner: text('owner'),
  // CHECK (open, assigned, drafted, done) in migration 0006.
  status: text('status').notNull().default('open').$type<'open' | 'assigned' | 'drafted' | 'done'>(),
}, (table) => ({
  // req_id allocation reads the highest suffix per prefix on the bid (migration 0009).
  bidReqIdx: index('compliance_rows_bid_id_req_id_idx').on(table.bidId, table.reqId),
}));

export const outlineItems = pgTable('outline_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => outlineItems.id, { onDelete: 'set null' }),
  number: text('number'),
  title: text('title').notNull(),
  pageLimit: integer('page_limit'),
  sourceRef: text('source_ref'),
  ...sourceColumns,
  writer: text('writer'),
  // CHECK (not_started, in_progress, review, done) in migration 0006.
  status: text('status').notNull().default('not_started').$type<'not_started' | 'in_progress' | 'review' | 'done'>(),
  dueDate: timestamp('due_date'),
  /** Order among siblings (same bid and parent), 0..n-1. Kept contiguous by the move route. */
  position: integer('position').notNull().default(0),
});

export const personnelRequirements = pgTable('personnel_requirements', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  requirement: text('requirement').notNull(),
  kind: text('kind').$type<'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other'>(),
  ...sourceColumns,
});

export const candidates = pgTable('candidates', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
});

export const resumeMatches = pgTable('resume_matches', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  candidateId: uuid('candidate_id').notNull().references(() => candidates.id, { onDelete: 'cascade' }),
  requirementId: uuid('requirement_id').notNull().references(() => personnelRequirements.id, { onDelete: 'cascade' }),
  result: text('result').notNull().$type<'meets' | 'partial' | 'gap' | 'unknown'>(),
  /** The AI's own result, kept so a reviewer override can be undone. Null when there is none. */
  aiResult: text('ai_result').$type<'meets' | 'partial' | 'gap' | 'unknown'>(),
  evidenceQuote: text('evidence_quote'),
  evidencePage: integer('evidence_page'),
  reviewerOverride: boolean('reviewer_override').notNull().default(false),
});

export const reviews = pgTable('reviews', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  type: text('type').notNull().$type<'pink' | 'red' | 'green' | 'gold' | 'other'>(),
  draftDocumentId: uuid('draft_document_id').references(() => documents.id, { onDelete: 'set null' }),
  scheduledAt: timestamp('scheduled_at'),
  // CHECK (planned, in_progress, done) in migration 0006.
  status: text('status').notNull().default('planned').$type<'planned' | 'in_progress' | 'done'>(),
});

export const reviewAssignments = pgTable('review_assignments', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  reviewId: uuid('review_id').notNull().references(() => reviews.id, { onDelete: 'cascade' }),
  reviewerName: text('reviewer_name').notNull(),
  sections: text('sections'),
});

export const reviewFindings = pgTable('review_findings', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  reviewId: uuid('review_id').notNull().references(() => reviews.id, { onDelete: 'cascade' }),
  evalFactor: text('eval_factor'),
  kind: text('kind').notNull().$type<'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment'>(),
  text: text('text').notNull(),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  sourcePage: integer('source_page'),
  sourcePageEnd: integer('source_page_end'),
  sourceQuote: text('source_quote'),
  origin: text('origin').$type<'ai' | 'user'>(),
  // CHECK (open, accepted, rejected, done) in migration 0006.
  disposition: text('disposition').notNull().default('open').$type<'open' | 'accepted' | 'rejected' | 'done'>(),
  /** The user who added the finding by hand; null for AI findings. */
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const productionItems = pgTable('production_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  // CHECK (format, files, submission, copies, other) in migration 0006.
  category: text('category').notNull().$type<'format' | 'files' | 'submission' | 'copies' | 'other'>(),
  rule: text('rule').notNull(),
  ...sourceColumns,
  // Seeded checklist rows are 'standard'.
  origin: text('origin').$type<'ai' | 'user' | 'standard'>(),
  done: boolean('done').notNull().default(false),
  owner: text('owner'),
});

export const oralsItems = pgTable('orals_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  // CHECK (rules, prep, session) in migration 0006.
  category: text('category').notNull().$type<'rules' | 'prep' | 'session'>(),
  item: text('item').notNull(),
  ...sourceColumns,
  // Seeded checklist rows are 'standard'.
  origin: text('origin').$type<'ai' | 'user' | 'standard'>(),
  done: boolean('done').notNull().default(false),
  owner: text('owner'),
  // CHECK (minutes >= 0) in migration 0006.
  minutes: integer('minutes'),
});

export const lessons = pgTable('lessons', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  author: text('author'),
});

export const rowHistory = pgTable('row_history', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  rowTable: text('row_table').notNull(),
  rowId: uuid('row_id').notNull(),
  userId: uuid('user_id').references(() => users.id),
  field: text('field').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  changedAt: timestamp('changed_at').notNull(),
});

// =============================================================================
// Compliance pre-scan hits ("check these", 05 s3.4)
// =============================================================================

/**
 * Requirement-like sentences the pre-scan found that no compliance row quotes. The worker
 * replaces a document's open hits in the transaction that writes its rows; the user promotes a
 * hit to a compliance row or dismisses it. CHECK on status in migration 0006.
 */
export const checkThese = pgTable('check_these', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  sentence: text('sentence').notNull(),
  pageNo: integer('page_no').notNull(),
  status: text('status').notNull().default('open').$type<'open' | 'promoted' | 'dismissed'>(),
  promotedRowId: uuid('promoted_row_id').references(() => complianceRows.id, { onDelete: 'set null' }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at'),
}, (table) => ({
  bidStatusIdx: index('check_these_bid_id_status_idx').on(table.bidId, table.status),
  documentStatusIdx: index('check_these_document_id_status_idx').on(table.documentId, table.status),
}));
