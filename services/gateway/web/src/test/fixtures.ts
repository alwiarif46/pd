import type {
  AmendmentLinkDto,
  BidDto,
  BidFactDto,
  DocumentDto,
  JobDto,
  MeDto,
  OrganizationDto,
  OrgPayloadDto,
  RfpCreditDto,
  ScheduleActivityDto,
  TabProposalDto,
} from '@/api';
import type { ScheduleActivity } from '@/types';

/** API DTOs with plain defaults, for tests. Pass only the fields a test cares about. */

const stamp = '2026-10-01T00:00:00.000Z';
const base = { createdAt: stamp, updatedAt: stamp, orgId: 'org-1' };

export function bidDto(over: Partial<BidDto> = {}): BidDto {
  return {
    ...base,
    id: 'bid-1',
    name: 'VA EHR Support',
    agency: 'Department of Veterans Affairs',
    bidType: 'federal',
    solicitationNumber: '36C10B26R0001',
    solicitationKey: '36C10B26R0001',
    status: 'writing',
    startDate: null,
    dueDate: '2026-11-03T00:00:00.000Z',
    dueTime: '14:00',
    timeZone: 'America/New_York',
    countMode: null,
    oralsEnabled: false,
    scheduleWorkdaysOnly: true,
    creditId: 'credit-1',
    creditStatus: 'reserved',
    keyOverridesUsed: 0,
    retentionExtendedUntil: null,
    defaultLiveUntil: null,
    filesLiveUntil: null,
    keyOverridesLeft: 2,
    ...over,
  };
}

export function docDto(over: Partial<DocumentDto> = {}): DocumentDto {
  return {
    ...base,
    bidId: 'bid-1',
    id: 'doc-1',
    fileName: 'rfp.pdf',
    mime: 'application/pdf',
    sizeBytes: 1024 * 1024,
    sha256: 'a'.repeat(64),
    kind: 'solicitation',
    amendmentNo: null,
    storagePath: null,
    viewerPath: null,
    extractMethod: 'pdf_text',
    pagesEstimated: null,
    pageCount: 40,
    encryption: 'none',
    scanStatus: 'clean',
    extractStatus: 'ready',
    markingFound: null,
    markingStatus: 'none',
    markingPage: null,
    liveUntil: null,
    liveStatus: 'live',
    restoredUntil: null,
    keyCheck: 'not_applicable',
    keyReason: null,
    keyFound: null,
    amendmentNoSource: null,
    amendmentNoFound: null,
    amendmentStatus: null,
    amendmentTabsStatus: null,
    ...over,
  };
}

export function jobDto(over: Partial<JobDto> = {}): JobDto {
  return {
    ...base,
    id: 'job-1',
    bidId: 'bid-1',
    documentId: 'doc-1',
    type: 'scan',
    status: 'completed',
    progress: 100,
    queuePosition: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    queueDepth: 0,
    stage: null,
    etaSeconds: null,
    ...over,
  };
}

export function linkDto(over: Partial<AmendmentLinkDto> = {}): AmendmentLinkDto {
  return {
    ...base,
    id: 'link-1',
    amendmentId: 'amd-1',
    amendmentNo: 2,
    oldRow: { rowId: 'row-old', label: 'C.3.2', text: 'Business hours.', sourcePage: 12 },
    newRow: { rowId: 'row-new', label: 'C.3.2', text: 'Around the clock.', sourcePage: 3 },
    rowTable: 'compliance_rows',
    oldRowId: 'row-old',
    newRowId: 'row-new',
    action: 'supersede',
    confidence: '0.62',
    status: 'proposed',
    decidedBy: null,
    sourcePage: 3,
    sourceQuote: 'Around the clock.',
    ...over,
  };
}

export function organizationDto(over: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    createdAt: stamp,
    updatedAt: stamp,
    id: 'org-1',
    name: 'Northbridge',
    emailDomain: 'northbridge.example',
    plan: 'free',
    planStatus: 'free',
    cycleStart: null,
    cycleEnd: null,
    freeFirstMonthEnds: null,
    ...over,
  };
}

export function creditDto(over: Partial<RfpCreditDto> = {}): RfpCreditDto {
  return {
    ...base,
    id: 'credit-1',
    periodStart: stamp,
    periodEnd: '2026-11-01T00:00:00.000Z',
    allowed: 2,
    used: 0,
    reserved: 1,
    ...over,
  };
}

export function orgPayload(over: Partial<OrgPayloadDto> = {}): OrgPayloadDto {
  return {
    org: organizationDto(),
    credits: creditDto(),
    role: 'owner',
    seatLimit: 2,
    mbCap: 50,
    billingAvailable: false,
    ...over,
  };
}

export function meDto(over: Partial<MeDto> = {}): MeDto {
  return { id: 'user-1', email: 'dana@northbridge.example', name: 'Dana Reyes', phone: null, orgId: 'org-1', ...over };
}

export function scheduleActivityDto(over: Partial<ScheduleActivityDto> = {}): ScheduleActivityDto {
  return {
    ...base,
    bidId: 'bid-1',
    id: 'act-1',
    origin: 'user',
    kind: 'writing',
    reviewColor: null,
    label: 'First draft writing',
    phase: null,
    startDate: '2026-11-16T00:00:00.000Z',
    endDate: '2026-11-18T00:00:00.000Z',
    time: null,
    owner: null,
    artifact: null,
    note: null,
    status: null,
    locked: false,
    dateKey: 'other',
    documentId: null,
    sourcePage: null,
    sourcePageEnd: null,
    sourceQuote: null,
    quoteVerified: false,
    amendmentNo: 0,
    supersedeStatus: null,
    supersededByRowId: null,
    changedByAmendment: null,
    confidence: null,
    flags: null,
    ...over,
  };
}

/** The UI-contract shape of a schedule activity (see types/schedule.ts). */
export function scheduleActivity(over: Partial<ScheduleActivity> = {}): ScheduleActivity {
  return {
    id: 'act-1',
    label: 'First draft writing',
    kind: 'writing',
    reviewColor: null,
    start: '2026-11-16',
    end: '2026-11-18',
    owner: null,
    locked: false,
    origin: 'user',
    sourcePage: null,
    sourcePageEnd: null,
    sourceQuote: null,
    amendment: { kind: 'original' },
    ...over,
  };
}

export function bidFactDto(over: Partial<BidFactDto> = {}): BidFactDto {
  return {
    ...base,
    bidId: 'bid-1',
    id: 'fact-1',
    field: 'Agency',
    value: 'VA',
    confirmed: true,
    factKey: 'agency',
    documentId: null,
    sourcePage: null,
    sourcePageEnd: null,
    sourceQuote: null,
    quoteVerified: false,
    amendmentNo: 0,
    supersedeStatus: null,
    supersededByRowId: null,
    changedByAmendment: null,
    origin: 'user',
    confidence: null,
    flags: null,
    ...over,
  };
}

/** An open tab proposal (overview or schedule) around `row`. */
export function tabProposalDto<T>(row: T, over: Partial<TabProposalDto<T>> = {}): TabProposalDto<T> {
  return {
    linkId: 'link-a',
    linkIds: ['link-a'],
    amendmentId: 'amd-2',
    amendmentNo: 2,
    oldRowIds: [],
    sourcePage: null,
    sourceQuote: null,
    row,
    ...over,
  };
}
