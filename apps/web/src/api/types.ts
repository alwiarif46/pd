/**
 * Wire types for the PD API. They mirror the server JSON: timestamps are ISO strings, nullable
 * columns are `| null`, and `decimal` columns (`confidence`) are strings because pg returns them so.
 * Response types end in `Dto`; request bodies end in `Input` or `Patch`.
 * Containers map these to the UI contract types in `@/types`.
 */

export type Ok = { ok: true };

export type Role = 'owner' | 'member';
export type Plan = 'free' | 'starter' | 'growth';
export type BidType = 'federal' | 'sled';
export type FileKind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
export type TabName =
  | 'overview'
  | 'schedule'
  | 'compliance'
  | 'outline'
  | 'resumes'
  | 'reviews'
  | 'production'
  | 'orals'
  | 'lessons';
export type SeedableTab = 'overview' | 'schedule' | 'production' | 'orals' | 'lessons';
/** Schedule templates (packages/core SCHEDULE_TEMPLATES). The server also maps the legacy ids 'standard' and 'color-reviews'. */
export type ScheduleTemplate = 'federal-standard' | 'federal-fast' | 'task-order';
/** `schedule_activities.kind` (migration 0010 CHECK; packages/core ACTIVITY_KINDS). */
export type ActivityKind = 'milestone' | 'writing' | 'review' | 'production' | 'submission' | 'custom';
/** `schedule_activities.review_color`: only on kind 'review' (packages/core REVIEW_COLORS). */
export type ReviewColor = 'blue' | 'pink' | 'red' | 'green' | 'gold' | 'white_glove';
/** `schedule_activities.origin`: 'template' rows came from a schedule template. */
export type ActivityOrigin = 'ai' | 'user' | 'template';
export type AdjustMode = 'shift' | 'scale' | 'keep';
export type RowTable =
  | 'bid_facts'
  | 'kickoff_items'
  | 'schedule_activities'
  | 'compliance_rows'
  | 'outline_items'
  | 'personnel_requirements'
  | 'candidates'
  | 'resume_matches'
  | 'reviews'
  | 'review_assignments'
  | 'review_findings'
  | 'production_items'
  | 'orals_items'
  | 'lessons';
export type ReqType = 'shall' | 'must' | 'will' | 'should' | 'other';
export type PersonnelKind = 'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other';
export type MatchResult = 'meets' | 'partial' | 'gap' | 'unknown';
export type ReviewType = 'pink' | 'red' | 'green' | 'gold' | 'other';
export type FindingKind = 'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment';

interface BaseDto {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface OrgScopedDto extends BaseDto {
  orgId: string;
}

interface BidScopedDto extends OrgScopedDto {
  bidId: string;
}

/** Source columns carried by every AI-extractable row. */
export interface SourceColumnsDto {
  documentId: string | null;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  quoteVerified: boolean;
  amendmentNo: number;
  supersedeStatus: 'active' | 'superseded' | 'withdrawn' | null;
  supersededByRowId: string | null;
  changedByAmendment: number | null;
  origin: 'ai' | 'user' | null;
  confidence: string | null;
  flags: string[] | null;
}

// ---------------------------------------------------------------------------
// Account and organization
// ---------------------------------------------------------------------------

export interface MeDto {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  orgId: string | null;
}

export interface MePatch {
  name?: string;
  password?: string;
  /** Required by the API whenever `password` is sent (400 if missing, 403 if wrong). */
  currentPassword?: string;
}

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
  phone: string;
}

export interface OrganizationDto extends BaseDto {
  name: string;
  emailDomain: string | null;
  plan: Plan;
  planStatus: PlanStatus;
  cycleStart: string | null;
  cycleEnd: string | null;
  freeFirstMonthEnds: string | null;
}

export interface RfpCreditDto extends OrgScopedDto {
  periodStart: string;
  periodEnd: string;
  allowed: number;
  used: number;
  reserved: number;
}

/**
 * GET /api/org `credits` before the current period has a row (the first reservation of the period
 * creates it): the bounds and allowance that row will get, with nothing used or reserved.
 */
export interface ProjectedCreditDto {
  id: null;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  allowed: number;
  used: 0;
  reserved: 0;
  createdAt: null;
  updatedAt: null;
}

export interface OrgPayloadDto {
  org: OrganizationDto | null;
  /** The period that holds now; projected (`id: null`) until its row exists. Null only without an organization. */
  credits: RfpCreditDto | ProjectedCreditDto | null;
  role: Role;
  /** Members the plan allows (06 s2). */
  seatLimit: number;
  /** Files per bid, in MB (06 s3). */
  mbCap: number;
  /** False until Stripe is configured on the server; Checkout and Portal answer 503 then. */
  billingAvailable: boolean;
}

export interface CreatedOrgDto {
  id: string;
  name: string;
  plan: Plan;
}

export interface ProcessingInfoDto {
  provider: string;
  model: string;
  subprocessors: string[];
  privacyPath: string;
}

/** 'free' on the free plan; 'active' or 'past_due' (Stripe is retrying) on a paid plan. */
export type PlanStatus = 'active' | 'past_due' | 'free';

/** One member of the organization, oldest first (GET /api/org/members). */
export interface OrgMemberDto {
  orgId: string;
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  joinedAt: string;
  /** The signed-in user. */
  isYou: boolean;
}

export type PaidPlan = Exclude<Plan, 'free'>;

/** A Stripe-hosted page to send the browser to (Checkout or the Customer Portal). */
export interface BillingRedirectDto {
  url: string;
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

export interface BidDto extends OrgScopedDto {
  name: string;
  agency: string | null;
  bidType: BidType;
  solicitationNumber: string;
  solicitationKey: string;
  status: BidStatus;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  timeZone: string | null;
  countMode: string | null;
  oralsEnabled: boolean;
  /** The schedule's "Workdays only" setting: shift, scale, and templates skip weekends and US federal holidays. Default true. */
  scheduleWorkdaysOnly: boolean;
  creditId: string | null;
  creditStatus: 'reserved' | 'consumed' | 'released' | null;
  keyOverridesUsed: number;
  retentionExtendedUntil: string | null;
  /** 03 s39 without an extension: paid, the later of latest non-resume upload + 90 days and due + 90; free, latest upload + 90; null if neither. */
  defaultLiveUntil: string | null;
  /** The later of `defaultLiveUntil` and `retentionExtendedUntil` (paid plans; free ignores the extension). */
  filesLiveUntil: string | null;
  /** Amendment key overrides left on this bid (limit from app_settings, default 2). */
  keyOverridesLeft: number;
}

export interface CreateBidInput {
  name: string;
  bidType: BidType;
  solicitationNumber?: string;
}

export interface BidPatch {
  name?: string;
  agency?: string | null;
  bidType?: BidType;
  solicitationNumber?: string;
  startDate?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  timeZone?: string | null;
  oralsEnabled?: boolean;
  retentionExtendedUntil?: string | null;
  /** Any other value is refused with 400. */
  status?: BidStatus;
  /** The schedule's "Workdays only" setting; anything but a boolean is refused with 400. */
  scheduleWorkdaysOnly?: boolean;
}

/** `bids.status` (09 s5.2); the database holds only these values. New bids start in `planning`. */
export type BidStatus = 'planning' | 'writing' | 'submitted' | 'closed';

// ---------------------------------------------------------------------------
// Uploads and documents
// ---------------------------------------------------------------------------

export interface OpenUploadInput {
  fileName: string;
  kind: FileKind;
  declaredSize: number;
  sha256: string;
  chunkCount: number;
  /** Amendments only: the amendment's number, 1 to 999. 409 `amendment_no_taken` when the bid already has it. */
  amendmentNo?: number;
}

/** `{ duplicate: true }` (200) when the file is already on the bid, otherwise a new session (201). */
export type UploadSessionDto = { duplicate: true } | { id: string; expiresAt: string };

export interface UploadCompleteDto {
  documentId: string;
  jobId: string;
}

export interface DocumentDto extends BidScopedDto {
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  kind: FileKind;
  amendmentNo: number | null;
  storagePath: string | null;
  viewerPath: string | null;
  extractMethod: 'pdf_text' | 'ocr' | 'docx_pdf' | 'docx_text_fallback' | 'xlsx' | null;
  pagesEstimated: number | null;
  pageCount: number | null;
  encryption: 'none' | 'owner_password' | 'user_password' | null;
  scanStatus: string | null;
  extractStatus: string | null;
  markingFound: string[] | null;
  markingStatus: 'none' | 'blocked' | 'confirmed' | null;
  /** The lowest page a marking was found on, or null. */
  markingPage: number | null;
  /** Computed by the 03 s39 rule (plan, upload date, due date, extension); null for a deleted file. */
  liveUntil: string | null;
  liveStatus: DocumentLiveStatus | null;
  /** The latest `restored_until` of the file's restored, unpurged archive copies, or null. */
  restoredUntil: string | null;
  keyCheck: KeyCheck;
  /** Why `keyCheck` is `mismatch`: another number, no number found, or the bid key is still PENDING; null otherwise. */
  keyReason: KeyReason | null;
  /** The solicitation number the amendment check found (the matched text, or the top labelled number); null if none or not an amendment. */
  keyFound: string | null;
  /** Amendments only: where `amendmentNo` came from. `sequence` is assumed (no number in the file) and editable. */
  amendmentNoSource: AmendmentNoSource | null;
  /** Amendments only: the number read from the file, when one was found (it may differ from a typed one). */
  amendmentNoFound: number | null;
  /** Amendments only: the amendment's status; `needs_number` waits for the user to set the number. */
  amendmentStatus: AmendmentStatus | null;
}

export type AmendmentNoSource = 'user' | 'document' | 'sequence';
export type AmendmentStatus = 'held' | 'needs_number' | 'processing' | 'failed' | 'needs_confirmation' | 'applied';

/** PATCH /api/documents/:id/amendment-no. */
export interface SetAmendmentNoDto {
  ok: true;
  amendmentNo: number;
}

export interface ViewTokenDto {
  token: string;
  expiresInSeconds: number;
}

export interface PageDto extends OrgScopedDto {
  documentId: string;
  pageNo: number;
  text: string;
  ocrUsed: boolean;
  sectionTag: 'instructions' | 'evaluation' | 'scope' | 'terms' | 'attachments' | 'other' | null;
}

export interface DocumentPagesDto {
  fileName: string;
  liveStatus: DocumentDto['liveStatus'];
  pagesEstimated: number | null;
  extractMethod: DocumentDto['extractMethod'];
  pages: PageDto[];
}

export type DocumentLiveStatus = 'live' | 'archived' | 'restore_requested' | 'restoring' | 'restored' | 'deleted';

/**
 * The amendment key check (09 s5.11): `not_applicable` for anything but an amendment; `mismatch`
 * when the bid's solicitation number was not found in the amendment (see `KeyReason`) and no
 * override was given; `overridden` after an owner override; otherwise `ok` (matched, or not
 * checked yet).
 */
export type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden';

/** Why an amendment is held: a different number (`mismatch`), no number (`not_found`), or the bid key is still PENDING. */
export type KeyReason = 'mismatch' | 'not_found' | 'bid_key_pending';

/** POST /api/documents/:id/restore. A repeat while a restore is pending returns the current state. */
export interface RestoreDocumentDto {
  status: 'restore_requested' | 'restoring' | 'restored';
}

export interface KeyOverrideDto {
  ok: true;
  amendmentId: string;
  remaining: number;
}

// ---------------------------------------------------------------------------
// Jobs and amendments
// ---------------------------------------------------------------------------

export interface JobDto extends OrgScopedDto {
  bidId: string | null;
  documentId: string | null;
  type: string;
  status: string;
  progress: number;
  queuePosition: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  queueDepth: number;
  /** The pipeline queue holding the job, or null when it is in none. */
  stage: string | null;
  /** Seconds until the job is expected to finish; null without enough history. */
  etaSeconds: number | null;
}

/** A compliance row an amendment link points at. */
export interface AmendmentRowRef {
  rowId: string;
  label: string;
  text: string;
  sourcePage: number | null;
}

export interface AmendmentLinkDto extends OrgScopedDto {
  amendmentId: string;
  amendmentNo: number | null;
  oldRow: AmendmentRowRef | null;
  newRow: AmendmentRowRef | null;
  rowTable: string;
  oldRowId: string | null;
  newRowId: string | null;
  action: 'supersede' | 'withdraw' | 'add';
  confidence: string | null;
  status: 'auto' | 'proposed' | 'confirmed' | 'rejected';
  decidedBy: string | null;
  /** The amendment text behind a supersede or withdraw, quote-checked; null on add links and on links written before migration 0009. */
  sourcePage: number | null;
  sourceQuote: string | null;
}

/**
 * POST /api/amendment-links/:id/confirm and /reject. Decisions are final: the same decision again
 * answers 200; the other is 409 `link_already_decided`. Confirm is 409 `row_already_closed` when
 * the old row is no longer active and `new_row_missing` when the replacing row is gone.
 * `amendmentStatus` is `applied` once no proposal is left.
 */
export interface AmendmentDecisionDto {
  ok: true;
  status: 'confirmed' | 'rejected';
  amendmentStatus: AmendmentStatus;
}

// ---------------------------------------------------------------------------
// Tab rows
// ---------------------------------------------------------------------------

export interface BidFactDto extends BidScopedDto, SourceColumnsDto {
  field: string;
  value: string;
  confirmed: boolean;
}

export interface KickoffItemDto extends BidScopedDto {
  label: string;
  done: boolean;
  owner: string | null;
  note: string | null;
}

/**
 * Dates are UTC-midnight timestamps ('2026-11-20T00:00:00.000Z'); the day is `startDate.slice(0, 10)`.
 * `endDate` null means the same day as `startDate`.
 */
export interface ScheduleActivityDto extends BidScopedDto, Omit<SourceColumnsDto, 'origin'> {
  origin: ActivityOrigin | null;
  kind: ActivityKind;
  reviewColor: ReviewColor | null;
  label: string;
  phase: string | null;
  startDate: string | null;
  endDate: string | null;
  time: string | null;
  owner: string | null;
  artifact: string | null;
  note: string | null;
  status: string | null;
  locked: boolean;
}

export interface ComplianceRowDto extends BidScopedDto, SourceColumnsDto {
  reqId: string;
  sectionRef: string | null;
  requirementText: string;
  reqType: ReqType | null;
  instrRef: string | null;
  evalRef: string | null;
  responseSection: string | null;
  owner: string | null;
  status: RowStatus;
}

export interface OutlineItemDto extends BidScopedDto, SourceColumnsDto {
  parentId: string | null;
  number: string | null;
  title: string;
  pageLimit: number | null;
  sourceRef: string | null;
  writer: string | null;
  status: OutlineStatus;
  dueDate: string | null;
  /** Order among siblings (same parent), 0..n-1. The tab returns items sorted by it. */
  position: number;
}

export interface PersonnelRequirementDto extends BidScopedDto, SourceColumnsDto {
  role: string;
  requirement: string;
  kind: PersonnelKind | null;
}

export interface CandidateDto extends BidScopedDto {
  name: string;
  role: string;
  documentId: string | null;
  /** From the latest job on the resume: failed, pending or running (processing), else ready. */
  status: CandidateStatus;
  /** When the resume was uploaded; null with no resume. */
  uploadedAt: string | null;
  /** The resume document was deleted (90-day rule); evidence quotes are gone. */
  resumeDeleted: boolean;
}

export interface ResumeMatchDto extends OrgScopedDto {
  candidateId: string;
  requirementId: string;
  result: MatchResult;
  evidenceQuote: string | null;
  evidencePage: number | null;
  reviewerOverride: boolean;
  /** The AI's own result, restored by `{ reviewerOverride: false }`; null when there is none. */
  aiResult: MatchResult | null;
}

export interface ReviewDto extends BidScopedDto {
  type: ReviewType;
  draftDocumentId: string | null;
  scheduledAt: string | null;
  status: ReviewStatus;
  /** The draft document's file name. */
  draftFileName: string | null;
}

export interface ReviewAssignmentDto extends OrgScopedDto {
  reviewId: string;
  reviewerName: string;
  sections: string | null;
}

export interface ReviewFindingDto extends OrgScopedDto {
  reviewId: string;
  evalFactor: string | null;
  kind: FindingKind;
  text: string;
  documentId: string | null;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  origin: 'ai' | 'user' | null;
  disposition: Disposition;
  /** The user who added the finding by hand; null for AI findings. */
  authorUserId: string | null;
  /** That user's name, or email when the name is not set; null for AI findings. */
  author: string | null;
}

export interface ProductionItemDto extends BidScopedDto, Omit<SourceColumnsDto, 'origin'> {
  category: ProductionCategory;
  rule: string;
  done: boolean;
  owner: string | null;
  /** 'standard' for the seeded checklist. */
  origin: ChecklistOrigin | null;
}

export interface OralsItemDto extends BidScopedDto, Omit<SourceColumnsDto, 'origin'> {
  category: OralsCategory;
  item: string;
  done: boolean;
  owner: string | null;
  minutes: number | null;
  /** 'standard' for the seeded checklist. */
  origin: ChecklistOrigin | null;
}

export interface LessonDto extends BidScopedDto {
  question: string;
  answer: string;
  author: string | null;
}

export interface RowHistoryDto extends OrgScopedDto {
  rowTable: string;
  rowId: string;
  userId: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  /** users.name, or email when the name is not set; null for changes no user made. */
  userName: string | null;
}

export type RowStatus = 'open' | 'assigned' | 'drafted' | 'done';
export type OutlineStatus = 'not_started' | 'in_progress' | 'review' | 'done';
export type CandidateStatus = 'processing' | 'ready' | 'failed';
export type ReviewStatus = 'planned' | 'in_progress' | 'done';
export type Disposition = 'open' | 'accepted' | 'rejected' | 'done';
export type ProductionCategory = 'format' | 'files' | 'submission' | 'copies' | 'other';
export type OralsCategory = 'rules' | 'prep' | 'session';
export type ChecklistOrigin = 'ai' | 'user' | 'standard';

/** A pre-scan sentence no compliance row quotes (GET /api/bids/:id/check-these). */
export interface CheckTheseDto {
  id: string;
  documentId: string;
  sentence: string;
  page: number;
}

/** POST /api/bids/:id/outline/move. `parentId` null makes the item a volume; `index` is clamped. */
export interface MoveOutlineInput {
  id: string;
  parentId: string | null;
  index: number;
}

// ---------------------------------------------------------------------------
// Tab payloads, row maps, and request bodies
// ---------------------------------------------------------------------------

export interface TabPayloadMap {
  overview: { facts: BidFactDto[]; kickoff: KickoffItemDto[] };
  /** Activities by start date (undated last), and the bid's "Workdays only" setting. */
  schedule: { activities: ScheduleActivityDto[]; workdaysOnly: boolean };
  compliance: { rows: ComplianceRowDto[] };
  outline: { items: OutlineItemDto[] };
  resumes: { requirements: PersonnelRequirementDto[]; candidates: CandidateDto[]; matches: ResumeMatchDto[] };
  reviews: { reviews: ReviewDto[]; assignments: ReviewAssignmentDto[]; findings: ReviewFindingDto[] };
  production: { items: ProductionItemDto[] };
  orals: { items: OralsItemDto[] };
  lessons: { items: LessonDto[] };
}

export interface RowTableMap {
  bid_facts: BidFactDto;
  kickoff_items: KickoffItemDto;
  schedule_activities: ScheduleActivityDto;
  compliance_rows: ComplianceRowDto;
  outline_items: OutlineItemDto;
  personnel_requirements: PersonnelRequirementDto;
  candidates: CandidateDto;
  resume_matches: ResumeMatchDto;
  reviews: ReviewDto;
  review_assignments: ReviewAssignmentDto;
  review_findings: ReviewFindingDto;
  production_items: ProductionItemDto;
  orals_items: OralsItemDto;
  lessons: LessonDto;
}

export interface RowDetailDto<T extends RowTable> {
  row: RowTableMap[T];
  history: RowHistoryDto[];
}

/** Exactly the fields the server's `patchRow` reads, per table. */
export interface RowPatchMap {
  bid_facts: { value?: string; confirmed?: boolean };
  kickoff_items: { done?: boolean; owner?: string | null; note?: string | null };
  /**
   * Dates are 'YYYY-MM-DD' (400 otherwise, or when the end is before the start). A date move on a
   * row that is locked and stays locked is 409 `activity_locked`; send `locked: false` with the
   * move to unlock and move at once. Changing `kind` away from 'review' clears `reviewColor`;
   * a color on another kind is 400.
   */
  schedule_activities: {
    label?: string;
    startDate?: string | null;
    endDate?: string | null;
    locked?: boolean;
    owner?: string | null;
    status?: string | null;
    kind?: ActivityKind;
    reviewColor?: ReviewColor | null;
  };
  compliance_rows: {
    requirementText?: string;
    owner?: string | null;
    status?: RowStatus;
    responseSection?: string | null;
  };
  outline_items: {
    title?: string;
    writer?: string | null;
    status?: OutlineStatus;
    pageLimit?: number | null;
    dueDate?: string | null;
  };
  personnel_requirements: { role?: string; requirement?: string };
  /** `documentId` links a resume uploaded to this bid; `null` unlinks it. */
  candidates: { name?: string; role?: string; documentId?: string | null };
  /** Setting `result` marks a reviewer override; `{ reviewerOverride: false }` restores `aiResult`. */
  resume_matches: { result?: MatchResult; reviewerOverride?: boolean };
  /** `draftDocumentId` links a draft uploaded to this bid; `null` unlinks it. */
  reviews: { status?: ReviewStatus; scheduledAt?: string | null; draftDocumentId?: string | null };
  review_assignments: { reviewerName?: string; sections?: string | null };
  review_findings: { disposition?: Disposition; text?: string };
  production_items: { done?: boolean; rule?: string; owner?: string | null };
  /** `minutes` is a whole number, 0 or more, or null. */
  orals_items: { done?: boolean; item?: string; owner?: string | null; minutes?: number | null };
  lessons: { answer?: string; author?: string | null };
}

export type ComplianceRowPatch = RowPatchMap['compliance_rows'];

export interface CreateComplianceRowInput {
  requirementText: string;
  reqId?: string;
  sectionRef?: string;
  reqType?: ReqType;
  owner?: string;
  status?: RowStatus;
}

/** Exactly what the server's `insertRow` accepts, per tab. */
export interface CreateRowBodyMap {
  overview: { kind: 'fact'; field: string; value: string } | { label: string };
  /** `kind` and `reviewColor` are inferred from the label when not sent; `endDate` defaults to `startDate`. */
  schedule: {
    label: string;
    startDate?: string | null;
    endDate?: string | null;
    kind?: ActivityKind;
    reviewColor?: ReviewColor | null;
    owner?: string | null;
    locked?: boolean;
  };
  compliance: CreateComplianceRowInput;
  outline: {
    title: string;
    number?: string;
    parentId?: string;
    pageLimit?: number | null;
    writer?: string;
    status?: OutlineStatus;
  };
  resumes:
    | { kind: 'candidate'; name: string; role: string; documentId?: string }
    | { kind: 'match'; candidateId: string; requirementId: string; result?: MatchResult }
    | { role: string; requirement: string; kind?: PersonnelKind };
  reviews:
    | {
        kind: 'finding';
        reviewId: string;
        text: string;
        findingKind?: FindingKind;
        evalFactor?: string;
        disposition?: Disposition;
      }
    | { kind: 'assignment'; reviewId: string; reviewerName: string; sections?: string }
    | { type: ReviewType; scheduledAt?: string; status?: ReviewStatus; draftDocumentId?: string };
  production: { category: ProductionCategory; rule: string; owner?: string | null };
  orals: { category: OralsCategory; item: string; owner?: string | null; minutes?: number | null };
  lessons: { question: string; answer?: string; author?: string };
}

export interface CreatedRowMap {
  overview: BidFactDto | KickoffItemDto;
  schedule: ScheduleActivityDto;
  compliance: ComplianceRowDto;
  outline: OutlineItemDto;
  resumes: CandidateDto | ResumeMatchDto | PersonnelRequirementDto;
  reviews: ReviewFindingDto | ReviewAssignmentDto | ReviewDto;
  production: ProductionItemDto;
  orals: OralsItemDto;
  lessons: LessonDto;
}

/** POST /api/bids/:id/schedule/adjust. previousDue and nextDue ('YYYY-MM-DD') are required for shift and scale. */
export interface AdjustScheduleInput {
  mode: AdjustMode;
  previousDue?: string;
  nextDue?: string;
  /** Overrides the bid's setting for this call only. */
  workdaysOnly?: boolean;
}

/** One activity the adjust moved; days are 'YYYY-MM-DD'. */
export interface ScheduleMoveDto {
  id: string;
  previousStart: string;
  previousEnd: string;
  start: string;
  end: string;
}

export interface AdjustScheduleDto {
  ok: true;
  requestedMode: AdjustMode;
  /** What was done: 'shift' when a scale had no usable anchor (the bid has no start date before both due dates). */
  mode: AdjustMode;
  workdaysOnly: boolean;
  unit: 'workdays' | 'days';
  /** The due date's move in `unit`s. */
  delta: number;
  moved: number;
  moves: ScheduleMoveDto[];
}

/** POST /api/bids/:id/tabs/schedule/seed. 409 `due_date_required` when the bid has no due date. */
export interface SeedScheduleInput {
  template?: ScheduleTemplate;
  /** true: delete the unlocked activities first; default false: add to them. */
  replace?: boolean;
}

export interface SeedScheduleDto {
  ok: true;
  template: ScheduleTemplate;
  added: number;
  replaced: number;
  activities: ScheduleActivityDto[];
}
