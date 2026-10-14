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
  status: string;
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
}

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
  liveUntil: string | null;
  liveStatus: 'live' | 'archived' | 'restoring' | 'restored' | 'deleted' | null;
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
}

export interface AmendmentLinkDto extends OrgScopedDto {
  amendmentId: string;
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
  status: string | null;
}

export interface OutlineItemDto extends BidScopedDto, SourceColumnsDto {
  parentId: string | null;
  number: string | null;
  title: string;
  pageLimit: number | null;
  sourceRef: string | null;
  writer: string | null;
  status: string | null;
  dueDate: string | null;
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
}

export interface ResumeMatchDto extends OrgScopedDto {
  candidateId: string;
  requirementId: string;
  result: MatchResult;
  evidenceQuote: string | null;
  evidencePage: number | null;
  reviewerOverride: boolean;
}

export interface ReviewDto extends BidScopedDto {
  type: ReviewType;
  draftDocumentId: string | null;
  scheduledAt: string | null;
  status: string | null;
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
  disposition: string | null;
}

export interface ProductionItemDto extends BidScopedDto, SourceColumnsDto {
  category: string;
  rule: string;
  done: boolean;
}

export interface OralsItemDto extends BidScopedDto, SourceColumnsDto {
  category: string;
  item: string;
  done: boolean;
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
    status?: string | null;
    responseSection?: string | null;
  };
  outline_items: {
    title?: string;
    writer?: string | null;
    status?: string | null;
    pageLimit?: number;
    dueDate?: string | null;
  };
  personnel_requirements: { role?: string; requirement?: string };
  candidates: { name?: string; role?: string };
  resume_matches: { result?: MatchResult; reviewerOverride?: boolean };
  reviews: { status?: string | null; scheduledAt?: string | null };
  review_assignments: { reviewerName?: string; sections?: string | null };
  review_findings: { disposition?: string | null; text?: string };
  production_items: { done?: boolean; rule?: string };
  orals_items: { done?: boolean; item?: string };
  lessons: { answer?: string; author?: string | null };
}

export type ComplianceRowPatch = RowPatchMap['compliance_rows'];

export interface CreateComplianceRowInput {
  requirementText: string;
  reqId?: string;
  sectionRef?: string;
  reqType?: ReqType;
  owner?: string;
  status?: string;
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
    pageLimit?: number;
    writer?: string;
    status?: string;
  };
  resumes:
    | { kind: 'candidate'; name: string; role: string }
    | { kind: 'match'; candidateId: string; requirementId: string; result?: MatchResult }
    | { role: string; requirement: string; kind?: PersonnelKind };
  reviews:
    | { kind: 'finding'; reviewId: string; text: string; findingKind?: FindingKind; evalFactor?: string }
    | { kind: 'assignment'; reviewId: string; reviewerName: string; sections?: string }
    | { type: ReviewType; scheduledAt?: string };
  production: { category: string; rule: string };
  orals: { category: string; item: string };
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
