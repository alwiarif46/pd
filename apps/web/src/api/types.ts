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
export type ScheduleTemplate = 'standard' | 'color-reviews';
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

export interface OrgPayloadDto {
  org: OrganizationDto | null;
  credits: RfpCreditDto | null;
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
 * when the solicitation number was not found and no override was given; `overridden` after an
 * owner override; otherwise `ok`.
 */
export type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden';

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

export interface ScheduleActivityDto extends BidScopedDto, SourceColumnsDto {
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
  schedule: { activities: ScheduleActivityDto[] };
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
  schedule_activities: {
    label?: string;
    startDate?: string | null;
    endDate?: string | null;
    locked?: boolean;
    owner?: string | null;
    status?: string | null;
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
  candidates: { name?: string; role?: string };
  /** Setting `result` marks a reviewer override; `{ reviewerOverride: false }` restores `aiResult`. */
  resume_matches: { result?: MatchResult; reviewerOverride?: boolean };
  reviews: { status?: ReviewStatus; scheduledAt?: string | null };
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
  schedule: { label: string; startDate?: string | null; endDate?: string | null };
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
    | { kind: 'candidate'; name: string; role: string }
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
    | { type: ReviewType; scheduledAt?: string; status?: ReviewStatus };
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

export interface AdjustScheduleInput {
  mode: 'shift' | 'scale' | 'keep';
  previousDue?: string;
  nextDue?: string;
}
