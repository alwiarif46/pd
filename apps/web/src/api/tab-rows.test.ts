import { describe, expect, expectTypeOf, it } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { dismissCheckThese, listCheckThese, promoteCheckThese } from './compliance';
import { ApiError } from './errors';
import { getRow, updateRow } from './rows';
import { setToken } from './session';
import { createTabRow, getTab, moveOutlineItem } from './tabs';
import type {
  CandidateDto,
  CheckTheseDto,
  ComplianceRowDto,
  CreateRowBodyMap,
  Disposition,
  OralsItemDto,
  OutlineItemDto,
  OutlineStatus,
  ProductionItemDto,
  ReviewDto,
  ReviewFindingDto,
  ResumeMatchDto,
  RowHistoryDto,
  RowPatchMap,
  RowStatus,
} from './types';

describe('check these and outline move routes', () => {
  it.each([
    ['listCheckThese', () => listCheckThese('b/1'), 'GET', '/api/bids/b%2F1/check-these', undefined],
    ['promoteCheckThese', () => promoteCheckThese('c1'), 'POST', '/api/check-these/c1/promote', undefined],
    ['dismissCheckThese', () => dismissCheckThese('c1'), 'POST', '/api/check-these/c1/dismiss', undefined],
    [
      'moveOutlineItem',
      () => moveOutlineItem('b1', { id: 'o1', parentId: null, index: 2 }),
      'POST',
      '/api/bids/b1/outline/move',
      { id: 'o1', parentId: null, index: 2 },
    ],
  ] as const)('%s', async (_name, call, method, path, body) => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await call();
    const recorded = lastCall(fetchMock);
    expect(recorded.method).toBe(method);
    expect(recorded.url).toBe(path);
    expect(recorded.headers.get('Authorization')).toBe('Bearer tok');
    expect(jsonBody(recorded)).toEqual(body);
  });

  it('returns the check-these list as the server sends it', async () => {
    const hits: CheckTheseDto[] = [{ id: 'c1', documentId: 'd1', sentence: 'The offeror shall comply.', page: 4 }];
    mockFetch(jsonResponse(200, hits));
    await expect(listCheckThese('b1')).resolves.toEqual(hits);
  });

  it('surfaces a second promote as a 409 ApiError with the server text', async () => {
    mockFetch(jsonResponse(409, { error: 'That sentence was already added or dismissed' }));
    const error = await promoteCheckThese('c1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'That sentence was already added or dismissed' });
  });

  it('surfaces a cyclic outline move as a 409 ApiError', async () => {
    mockFetch(jsonResponse(409, { error: 'An item cannot move under itself or one of its own sections' }));
    await expect(moveOutlineItem('b1', { id: 'o1', parentId: 'o2', index: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('sends typed patches for owner, minutes, status and disposition', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true }));
    await updateRow('b1', 'orals_items', 'r1', { owner: 'Kim', minutes: 15 });
    expect(jsonBody(lastCall(fetchMock))).toEqual({ fields: { owner: 'Kim', minutes: 15 } });
    await updateRow('b1', 'review_findings', 'r2', { disposition: 'accepted' });
    expect(jsonBody(lastCall(fetchMock))).toEqual({ fields: { disposition: 'accepted' } });
    await updateRow('b1', 'resume_matches', 'r3', { reviewerOverride: false });
    expect(jsonBody(lastCall(fetchMock))).toEqual({ fields: { reviewerOverride: false } });
  });

  it('passes the derived fields of the tab and row DTOs through', async () => {
    const candidate = {
      id: 'c1', orgId: 'o', bidId: 'b1', createdAt: 't', updatedAt: 't', name: 'Pat', role: 'PM', documentId: 'd1',
      status: 'processing', uploadedAt: '2026-10-01T00:00:00.000Z', resumeDeleted: false,
    } satisfies CandidateDto;
    mockFetch(jsonResponse(200, { requirements: [], candidates: [candidate], matches: [] }));
    const resumes = await getTab('b1', 'resumes');
    expect(resumes.candidates[0]).toEqual(candidate);

    const history = {
      id: 'h1', orgId: 'o', createdAt: 't', updatedAt: 't', rowTable: 'outline_items', rowId: 'r1',
      userId: 'u1', userName: 'Avery', field: 'position', oldValue: '0', newValue: '2', changedAt: 't',
    } satisfies RowHistoryDto;
    mockFetch(jsonResponse(200, { row: {}, history: [history] }));
    const detail = await getRow('b1', 'outline_items', 'r1');
    expect(detail.history[0].userName).toBe('Avery');
  });

  it('creates typed production and orals rows', async () => {
    const fetchMock = mockFetch(jsonResponse(201, {}), jsonResponse(201, {}));
    await createTabRow('b1', 'production', { category: 'format', rule: '12 point', owner: 'Dana' });
    expect(jsonBody(lastCall(fetchMock))).toEqual({ category: 'format', rule: '12 point', owner: 'Dana' });
    await createTabRow('b1', 'orals', { category: 'session', item: 'Demo', minutes: 10 });
    expect(jsonBody(lastCall(fetchMock))).toEqual({ category: 'session', item: 'Demo', minutes: 10 });
  });
});

describe('tab-row DTO types', () => {
  it('types statuses, categories, and the new fields', () => {
    expectTypeOf<ComplianceRowDto['status']>().toEqualTypeOf<RowStatus>();
    expectTypeOf<OutlineItemDto['status']>().toEqualTypeOf<OutlineStatus>();
    expectTypeOf<OutlineItemDto['position']>().toEqualTypeOf<number>();
    expectTypeOf<CandidateDto['status']>().toEqualTypeOf<'processing' | 'ready' | 'failed'>();
    expectTypeOf<CandidateDto['uploadedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<CandidateDto['resumeDeleted']>().toEqualTypeOf<boolean>();
    expectTypeOf<ResumeMatchDto['aiResult']>().toEqualTypeOf<'meets' | 'partial' | 'gap' | 'unknown' | null>();
    expectTypeOf<ReviewDto['status']>().toEqualTypeOf<'planned' | 'in_progress' | 'done'>();
    expectTypeOf<ReviewDto['draftFileName']>().toEqualTypeOf<string | null>();
    expectTypeOf<ReviewFindingDto['disposition']>().toEqualTypeOf<Disposition>();
    expectTypeOf<ReviewFindingDto['author']>().toEqualTypeOf<string | null>();
    expectTypeOf<ProductionItemDto['category']>().toEqualTypeOf<'format' | 'files' | 'submission' | 'copies' | 'other'>();
    expectTypeOf<ProductionItemDto['origin']>().toEqualTypeOf<'ai' | 'user' | 'standard' | null>();
    expectTypeOf<ProductionItemDto['owner']>().toEqualTypeOf<string | null>();
    expectTypeOf<OralsItemDto['category']>().toEqualTypeOf<'rules' | 'prep' | 'session'>();
    expectTypeOf<OralsItemDto['minutes']>().toEqualTypeOf<number | null>();
    expectTypeOf<OralsItemDto['sourceQuote']>().toEqualTypeOf<string | null>();
    expectTypeOf<RowHistoryDto['userName']>().toEqualTypeOf<string | null>();
    expectTypeOf<RowPatchMap['compliance_rows']['status']>().toEqualTypeOf<RowStatus | undefined>();
    expectTypeOf<RowPatchMap['orals_items']['minutes']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<CreateRowBodyMap['production']['category']>().toEqualTypeOf<ProductionItemDto['category']>();
  });
});
