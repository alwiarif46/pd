import { type AnyPgColumn, pgTable, uuid, text, timestamp, boolean, integer, jsonb, decimal } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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
  planStatus: text('plan_status').notNull(),
  cycleStart: timestamp('cycle_start'),
  cycleEnd: timestamp('cycle_end'),
  freeFirstMonthEnds: timestamp('free_first_month_ends'),
});

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
});

export const phoneCodes = pgTable('phone_codes', {
  ...baseColumns,
  phoneE164: text('phone_e164').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
});

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
  status: text('status').notNull(),
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
});

export const documents = pgTable('documents', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  kind: text('kind').notNull().$type<'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft'>(),
  amendmentNo: integer('amendment_no'),
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
  liveUntil: timestamp('live_until'),
  liveStatus: text('live_status').$type<'live' | 'archived' | 'restoring' | 'restored' | 'deleted'>(),
});

export const uploadSessions = pgTable('upload_sessions', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  fileName: text('file_name').notNull(),
  kind: text('kind').notNull().$type<'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft'>(),
  declaredSize: integer('declared_size').notNull(),
  sha256: text('sha256').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  chunksReceived: integer('chunks_received').notNull().default(0),
  bytesReceived: integer('bytes_received').notNull().default(0),
  status: text('status').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const amendments = pgTable('amendments', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  amendmentNo: integer('amendment_no').notNull(),
  solicitationKeyFound: boolean('solicitation_key_found').notNull(),
  keyOverride: boolean('key_override').notNull().default(false),
  overrideReason: text('override_reason'),
  status: text('status').notNull().$type<'processing' | 'needs_confirmation' | 'applied'>(),
  datesChanged: jsonb('dates_changed'),
});

export const amendmentLinks = pgTable('amendment_links', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  amendmentId: uuid('amendment_id').notNull().references(() => amendments.id),
  rowTable: text('row_table').notNull(),
  oldRowId: uuid('old_row_id'),
  newRowId: uuid('new_row_id'),
  action: text('action').notNull().$type<'supersede' | 'withdraw' | 'add'>(),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  status: text('status').notNull().$type<'auto' | 'proposed' | 'confirmed' | 'rejected'>(),
  decidedBy: uuid('decided_by').references(() => users.id),
});

export const pages = pgTable('pages', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  documentId: uuid('document_id').notNull().references(() => documents.id),
  pageNo: integer('page_no').notNull(),
  text: text('text').notNull(),
  ocrUsed: boolean('ocr_used').notNull().default(false),
  sectionTag: text('section_tag').$type<'instructions' | 'evaluation' | 'scope' | 'terms' | 'attachments' | 'other'>(),
});

export const archiveObjects = pgTable('archive_objects', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  documentId: uuid('document_id').notNull().references(() => documents.id),
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
  bidId: uuid('bid_id').references(() => bids.id),
  documentId: uuid('document_id').references(() => documents.id),
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
  bidId: uuid('bid_id').notNull().references(() => bids.id),
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
  bidId: uuid('bid_id').references(() => bids.id),
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
  documentId: uuid('document_id').references(() => documents.id),
  sourcePage: integer('source_page'),
  sourcePageEnd: integer('source_page_end'),
  sourceQuote: text('source_quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  amendmentNo: integer('amendment_no').notNull().default(0),
  supersedeStatus: text('supersede_status').$type<'active' | 'superseded' | 'withdrawn'>(),
  supersededByRowId: uuid('superseded_by_row_id'),
  changedByAmendment: integer('changed_by_amendment'),
  origin: text('origin').$type<'ai' | 'user'>(),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  flags: jsonb('flags').$type<string[]>(),
};

export const bidFacts = pgTable('bid_facts', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  field: text('field').notNull(),
  value: text('value').notNull(),
  ...sourceColumns,
  confirmed: boolean('confirmed').notNull().default(false),
});

export const kickoffItems = pgTable('kickoff_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  label: text('label').notNull(),
  done: boolean('done').notNull().default(false),
  owner: text('owner'),
  note: text('note'),
});

export const scheduleActivities = pgTable('schedule_activities', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
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
});

export const complianceRows = pgTable('compliance_rows', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  reqId: text('req_id').notNull(),
  sectionRef: text('section_ref'),
  requirementText: text('requirement_text').notNull(),
  ...sourceColumns,
  reqType: text('req_type').$type<'shall' | 'must' | 'will' | 'should' | 'other'>(),
  instrRef: text('instr_ref'),
  evalRef: text('eval_ref'),
  responseSection: text('response_section'),
  owner: text('owner'),
  status: text('status'),
});

export const outlineItems = pgTable('outline_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  parentId: uuid('parent_id').references((): AnyPgColumn => outlineItems.id),
  number: text('number'),
  title: text('title').notNull(),
  pageLimit: integer('page_limit'),
  sourceRef: text('source_ref'),
  ...sourceColumns,
  writer: text('writer'),
  status: text('status'),
  dueDate: timestamp('due_date'),
});

export const personnelRequirements = pgTable('personnel_requirements', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  role: text('role').notNull(),
  requirement: text('requirement').notNull(),
  kind: text('kind').$type<'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other'>(),
  ...sourceColumns,
});

export const candidates = pgTable('candidates', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  documentId: uuid('document_id').references(() => documents.id),
});

export const resumeMatches = pgTable('resume_matches', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  candidateId: uuid('candidate_id').notNull().references(() => candidates.id),
  requirementId: uuid('requirement_id').notNull().references(() => personnelRequirements.id),
  result: text('result').notNull().$type<'meets' | 'partial' | 'gap' | 'unknown'>(),
  evidenceQuote: text('evidence_quote'),
  evidencePage: integer('evidence_page'),
  reviewerOverride: boolean('reviewer_override').notNull().default(false),
});

export const reviews = pgTable('reviews', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  type: text('type').notNull().$type<'pink' | 'red' | 'green' | 'gold' | 'other'>(),
  draftDocumentId: uuid('draft_document_id').references(() => documents.id),
  scheduledAt: timestamp('scheduled_at'),
  status: text('status'),
});

export const reviewAssignments = pgTable('review_assignments', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  reviewId: uuid('review_id').notNull().references(() => reviews.id),
  reviewerName: text('reviewer_name').notNull(),
  sections: text('sections'),
});

export const reviewFindings = pgTable('review_findings', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  reviewId: uuid('review_id').notNull().references(() => reviews.id),
  evalFactor: text('eval_factor'),
  kind: text('kind').notNull().$type<'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment'>(),
  text: text('text').notNull(),
  documentId: uuid('document_id').references(() => documents.id),
  sourcePage: integer('source_page'),
  sourcePageEnd: integer('source_page_end'),
  sourceQuote: text('source_quote'),
  origin: text('origin').$type<'ai' | 'user'>(),
  disposition: text('disposition'),
});

export const productionItems = pgTable('production_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  category: text('category').notNull(),
  rule: text('rule').notNull(),
  ...sourceColumns,
  done: boolean('done').notNull().default(false),
});

export const oralsItems = pgTable('orals_items', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
  category: text('category').notNull(),
  item: text('item').notNull(),
  ...sourceColumns,
  done: boolean('done').notNull().default(false),
});

export const lessons = pgTable('lessons', {
  ...baseColumns,
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  bidId: uuid('bid_id').notNull().references(() => bids.id),
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
