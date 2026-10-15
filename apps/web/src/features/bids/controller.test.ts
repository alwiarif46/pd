import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import type { BidDto, OrganizationDto, OrgPayloadDto } from '@/api';
import type { BidCard } from '@/types';
import {
  createBidAction,
  daysLeft,
  DUPLICATE_MESSAGE,
  loadBidsScreen,
  loadNewBidScreen,
  messageOf,
  periodEndFrom,
  planUploads,
  sortBidCards,
  summarizeOrg,
  toBidCard,
  type BidsApi,
} from './controller';
import { stashUploadNotices, takeUploadNotices } from './notices';
import { bidDocumentsHash, bidHash } from './routes';

function bid(overrides: Partial<BidDto> = {}): BidDto {
  return {
    id: 'b1',
    orgId: 'o1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    name: 'Navy IT',
    agency: 'NAVWAR',
    bidType: 'federal',
    solicitationNumber: 'N6600126R0001',
    solicitationKey: 'N6600126R0001',
    status: 'planning',
    startDate: null,
    dueDate: '2026-10-16',
    dueTime: null,
    timeZone: null,
    countMode: null,
    oralsEnabled: false,
    creditId: null,
    creditStatus: null,
    keyOverridesUsed: 0,
    retentionExtendedUntil: null,
    defaultLiveUntil: null,
    filesLiveUntil: null,
    keyOverridesLeft: 2,
    ...overrides,
  };
}

function card(overrides: Partial<BidCard> = {}): BidCard {
  return { id: 'c', name: 'A', status: 'planning', creditUsed: false, ...overrides };
}

function organization(overrides: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    id: 'o1',
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    name: 'Acme',
    emailDomain: null,
    plan: 'free',
    planStatus: 'free',
    cycleStart: null,
    cycleEnd: null,
    freeFirstMonthEnds: null,
    ...overrides,
  };
}

function payload(overrides: Partial<OrgPayloadDto> = {}): OrgPayloadDto {
  return {
    org: organization(),
    credits: null,
    role: 'owner',
    seatLimit: 2,
    mbCap: 50,
    billingAvailable: false,
    ...overrides,
  };
}

function file(name: string, type = ''): File {
  return new File(['x'], name, { type });
}

type Mock = { [K in keyof BidsApi]: ReturnType<typeof vi.fn> } & BidsApi;

function mockApi(): Mock {
  return {
    listBids: vi.fn().mockResolvedValue([]),
    createBid: vi.fn().mockResolvedValue(bid({ id: 'new-bid' })),
    uploadFile: vi.fn().mockResolvedValue({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' }),
    getOrg: vi.fn().mockResolvedValue(payload()),
  } as never;
}

describe('daysLeft', () => {
  const noon = new Date(2026, 9, 14, 12, 0, 0); // 14 Oct 2026, local time

  it('counts calendar days from today', () => {
    expect(daysLeft('2026-10-16', noon)).toBe(2);
    expect(daysLeft('2026-10-14', noon)).toBe(0);
    expect(daysLeft('2026-10-10', noon)).toBe(-4);
    expect(daysLeft('2026-11-06', noon)).toBe(23);
  });

  it('does not depend on the time of day', () => {
    expect(daysLeft('2026-10-15', new Date(2026, 9, 14, 0, 0, 1))).toBe(1);
    expect(daysLeft('2026-10-15', new Date(2026, 9, 14, 23, 59, 59))).toBe(1);
  });

  it('crosses a daylight saving change without an hour error', () => {
    expect(daysLeft('2026-11-02', new Date(2026, 10, 1, 23, 30))).toBe(1);
    expect(daysLeft('2026-03-09', new Date(2026, 2, 7, 12))).toBe(2);
  });

  it('is undefined without a readable date', () => {
    expect(daysLeft(null, noon)).toBeUndefined();
    expect(daysLeft('soon', noon)).toBeUndefined();
  });

  it('reads the date part of a timestamp as the calendar date', () => {
    expect(daysLeft('2026-10-16T00:00:00.000Z', noon)).toBe(2);
  });
});

describe('toBidCard', () => {
  const now = new Date(2026, 9, 14);

  it('maps the fields and turns nulls into missing values', () => {
    expect(toBidCard(bid({ agency: null, dueDate: null }), now)).toEqual({
      id: 'b1',
      name: 'Navy IT',
      agency: undefined,
      dueDate: undefined,
      daysLeft: undefined,
      status: 'planning',
      creditUsed: false,
    });
    expect(toBidCard(bid(), now)).toMatchObject({ agency: 'NAVWAR', dueDate: '2026-10-16', daysLeft: 2 });
  });

  it('marks a credit as used when it is reserved or consumed', () => {
    expect(toBidCard(bid({ creditStatus: 'reserved' }), now).creditUsed).toBe(true);
    expect(toBidCard(bid({ creditStatus: 'consumed' }), now).creditUsed).toBe(true);
    expect(toBidCard(bid({ creditStatus: 'released' }), now).creditUsed).toBe(false);
    expect(toBidCard(bid({ creditStatus: null }), now).creditUsed).toBe(false);
  });
});

describe('sortBidCards', () => {
  it('puts open bids by due date, no date last, and closed bids after them', () => {
    const sorted = sortBidCards([
      card({ id: 'closed-new', name: 'Z', status: 'closed', dueDate: '2026-09-30' }),
      card({ id: 'no-date', name: 'N' }),
      card({ id: 'late', name: 'L', dueDate: '2026-12-01', status: 'writing' }),
      card({ id: 'closed-old', name: 'Y', status: 'closed', dueDate: '2026-01-15' }),
      card({ id: 'soon', name: 'S', dueDate: '2026-10-16', status: 'submitted' }),
      card({ id: 'closed-none', name: 'X', status: 'closed' }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['soon', 'late', 'no-date', 'closed-new', 'closed-old', 'closed-none']);
  });

  it('breaks ties by name and does not change the input', () => {
    const input = [card({ id: 'b', name: 'B', dueDate: '2026-10-16' }), card({ id: 'a', name: 'A', dueDate: '2026-10-16' })];
    expect(sortBidCards(input).map((c) => c.id)).toEqual(['a', 'b']);
    expect(input.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('summarizeOrg', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');

  it('subtracts used and reserved credits and keeps the period end', () => {
    const credits = {
      id: 'c',
      orgId: 'o1',
      createdAt: '',
      updatedAt: '',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      allowed: 10,
      used: 3,
      reserved: 2,
    };
    expect(summarizeOrg(payload({ credits, mbCap: 300, org: organization({ plan: 'starter' }) }), now)).toEqual({
      creditsLeft: 5,
      creditsResetOn: '2026-11-01T00:00:00.000Z',
      plan: 'starter',
      mbCap: 300,
    });
  });

  it('never goes below zero', () => {
    const credits = { id: 'c', orgId: 'o', createdAt: '', updatedAt: '', periodStart: '', periodEnd: 'e', allowed: 1, used: 1, reserved: 1 };
    expect(summarizeOrg(payload({ credits }), now).creditsLeft).toBe(0);
  });

  it('shows the plan allowance, not zero, before the first credit of a period exists', () => {
    const summary = summarizeOrg(payload({ org: organization({ freeFirstMonthEnds: '2026-11-05T10:00:00.000Z' }) }), now);
    expect(summary.creditsLeft).toBe(2);
    expect(summary.creditsResetOn).toBe('2026-11-05T10:00:00.000Z');
    expect(summarizeOrg(payload({ org: organization({ freeFirstMonthEnds: '2026-10-01T00:00:00.000Z' }) }), now).creditsLeft).toBe(1);
    expect(summarizeOrg(payload({ org: organization({ plan: 'growth' }) }), now).creditsLeft).toBe(20);
  });

  it('uses the cached billing cycle of a paid plan', () => {
    const org = organization({ plan: 'starter', cycleStart: '2026-10-10T00:00:00.000Z', cycleEnd: '2026-11-10T00:00:00.000Z' });
    expect(summarizeOrg(payload({ org }), now)).toMatchObject({ creditsLeft: 10, creditsResetOn: '2026-11-10T00:00:00.000Z' });
  });

  it('has nothing to show without an organization', () => {
    expect(summarizeOrg(payload({ org: null }), now)).toEqual({ creditsLeft: 0, creditsResetOn: '', plan: 'free', mbCap: 50 });
  });
});

describe('periodEndFrom', () => {
  it('finds the month boundary after now, counted from the anchor day', () => {
    expect(periodEndFrom(new Date('2026-08-15T09:00:00.000Z'), new Date('2026-10-14T00:00:00.000Z')).toISOString()).toBe(
      '2026-10-15T09:00:00.000Z',
    );
    expect(periodEndFrom(new Date('2026-08-15T09:00:00.000Z'), new Date('2026-10-15T09:00:00.000Z')).toISOString()).toBe(
      '2026-11-15T09:00:00.000Z',
    );
  });

  it('clamps a 31st anchor to short months', () => {
    expect(periodEndFrom(new Date('2026-01-31T00:00:00.000Z'), new Date('2026-02-10T00:00:00.000Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
});

describe('loadBidsScreen', () => {
  const now = new Date(2026, 9, 14);

  it('returns sorted cards and the credit summary', async () => {
    const api = mockApi();
    api.listBids.mockResolvedValue([bid({ id: 'late', name: 'Late', dueDate: '2026-12-01' }), bid({ id: 'soon', name: 'Soon' })]);
    const data = await loadBidsScreen(api, now);
    expect(data.kind).toBe('ready');
    if (data.kind === 'ready') {
      expect(data.cards.map((c) => c.id)).toEqual(['soon', 'late']);
      expect(data.org.plan).toBe('free');
    }
  });

  it('reports a user with no organization', async () => {
    const api = mockApi();
    api.getOrg.mockRejectedValue(new ApiError('No organization', 403));
    expect(await loadBidsScreen(api, now)).toEqual({ kind: 'no_org' });
    api.getOrg.mockResolvedValue(payload());
    api.listBids.mockRejectedValue(new ApiError('No organization', 403));
    expect(await loadBidsScreen(api, now)).toEqual({ kind: 'no_org' });
  });

  it('lets other failures through', async () => {
    const api = mockApi();
    api.listBids.mockRejectedValue(new ApiError('The API is not reachable', 0));
    await expect(loadBidsScreen(api, now)).rejects.toThrow('The API is not reachable');
  });
});

describe('loadNewBidScreen', () => {
  it('returns credits, plan and the MB cap', async () => {
    const api = mockApi();
    api.getOrg.mockResolvedValue(payload({ mbCap: 300, org: organization({ plan: 'growth' }) }));
    const data = await loadNewBidScreen(api, new Date(2026, 9, 14));
    expect(data).toMatchObject({ kind: 'ready', org: { plan: 'growth', mbCap: 300, creditsLeft: 20 } });
  });

  it('reports a user with no organization', async () => {
    const api = mockApi();
    api.getOrg.mockRejectedValue(new ApiError('No organization', 403));
    expect(await loadNewBidScreen(api, new Date())).toEqual({ kind: 'no_org' });
  });
});

describe('planUploads', () => {
  it('makes the first PDF the solicitation and the rest attachments', () => {
    const plan = planUploads([file('sow.docx'), file('rfp.PDF'), file('pricing.xlsx'), file('other.pdf')]);
    expect(plan.map((p) => [p.file.name, p.kind])).toEqual([
      ['rfp.PDF', 'solicitation'],
      ['sow.docx', 'attachment'],
      ['pricing.xlsx', 'attachment'],
      ['other.pdf', 'attachment'],
    ]);
  });

  it('recognizes a PDF by its type when the name has no extension', () => {
    expect(planUploads([file('a.docx'), file('scan', 'application/pdf')])[0].file.name).toBe('scan');
  });

  it('falls back to the first file when there is no PDF', () => {
    expect(planUploads([file('a.docx'), file('b.xlsx')]).map((p) => p.kind)).toEqual(['solicitation', 'attachment']);
  });

  it('plans nothing for no files', () => {
    expect(planUploads([])).toEqual([]);
  });
});

describe('messageOf', () => {
  it.each([
    [402, 'out_of_credits', 'This organization has no RFP credits left this period.'],
    [409, 'key_mismatch', 'The solicitation number on this file does not match the bid.'],
    [409, 'key_locked', 'This bid already holds an RFP credit for its solicitation number.'],
    [413, 'bid_cap_exceeded', 'This file is larger than the space left on this bid.'],
  ])('shows the API text for %i %s as given', (status, code, text) => {
    expect(messageOf(new ApiError(text, status, code))).toBe(text);
  });

  it('hides anything that is not an API error', () => {
    expect(messageOf(new TypeError('x is undefined'))).toBe('Something went wrong. Try again.');
    expect(messageOf(new ApiError('', 500))).toBe('Something went wrong. Try again.');
  });
});

describe('createBidAction', () => {
  const input = (files: File[]) => ({ name: 'Navy IT', bidType: 'federal' as const, files });

  it('creates the bid, uploads the solicitation first, then the attachments in order', async () => {
    const api = mockApi();
    const files = [file('attach.docx'), file('rfp.pdf'), file('price.xlsx')];
    const seen: string[] = [];
    const result = await createBidAction(api, input(files), (p) => seen.push(`${p.index + 1}/${p.total} ${p.fileName}`));
    expect(result).toEqual({ ok: true, bidId: 'new-bid', notices: [] });
    expect(api.createBid).toHaveBeenCalledWith({ name: 'Navy IT', bidType: 'federal' });
    expect(api.uploadFile.mock.calls.map((c) => [c[1].name, c[2]])).toEqual([
      ['rfp.pdf', 'solicitation'],
      ['attach.docx', 'attachment'],
      ['price.xlsx', 'attachment'],
    ]);
    expect(seen).toEqual(['1/3 rfp.pdf', '2/3 attach.docx', '3/3 price.xlsx']);
  });

  it('uploads one file at a time', async () => {
    const api = mockApi();
    let running = 0;
    let peak = 0;
    api.uploadFile.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return { duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' };
    });
    await createBidAction(api, input([file('a.pdf'), file('b.pdf'), file('c.pdf')]));
    expect(peak).toBe(1);
  });

  it('stops when the bid cannot be created and uploads nothing', async () => {
    const api = mockApi();
    api.createBid.mockRejectedValue(new ApiError('Name is required', 400));
    expect(await createBidAction(api, input([file('a.pdf')]))).toEqual({ ok: false, message: 'Name is required' });
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps the bid and reports a refused solicitation, without trying the attachments', async () => {
    const api = mockApi();
    api.uploadFile.mockRejectedValue(new ApiError('This organization has no RFP credits left this period.', 402, 'out_of_credits'));
    const result = await createBidAction(api, input([file('rfp.pdf'), file('att.docx')]));
    expect(result).toEqual({
      ok: true,
      bidId: 'new-bid',
      notices: [
        { id: 'new-bid:0', fileName: 'rfp.pdf', tone: 'error', message: 'This organization has no RFP credits left this period.' },
      ],
    });
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a refused attachment', async () => {
    const api = mockApi();
    api.uploadFile
      .mockResolvedValueOnce({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' })
      .mockRejectedValueOnce(new ApiError('This file is larger than the space left on this bid.', 413, 'bid_cap_exceeded'))
      .mockResolvedValueOnce({ duplicate: false, sessionId: 's', documentId: 'd2', jobId: 'j2' });
    const result = await createBidAction(api, input([file('rfp.pdf'), file('big.xlsx'), file('ok.docx')]));
    expect(api.uploadFile).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: true,
      notices: [{ fileName: 'big.xlsx', tone: 'error', message: 'This file is larger than the space left on this bid.' }],
    });
  });

  it('says "Already uploaded." for a duplicate and carries on', async () => {
    const api = mockApi();
    api.uploadFile
      .mockResolvedValueOnce({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' })
      .mockResolvedValueOnce({ duplicate: true });
    const result = await createBidAction(api, input([file('rfp.pdf'), file('copy.pdf')]));
    expect(result).toEqual({
      ok: true,
      bidId: 'new-bid',
      notices: [{ id: 'new-bid:1', fileName: 'copy.pdf', tone: 'info', message: DUPLICATE_MESSAGE }],
    });
    expect(DUPLICATE_MESSAGE).toBe('Already uploaded.');
  });

  it('hides non-API upload failures behind a plain line', async () => {
    const api = mockApi();
    api.uploadFile.mockRejectedValue(new TypeError('boom'));
    const result = await createBidAction(api, input([file('rfp.pdf')]));
    expect(result).toMatchObject({ ok: true, notices: [{ message: 'Something went wrong. Try again.' }] });
  });
});

describe('upload notices and routes', () => {
  it('hands stashed notices to the next reader once', () => {
    const notice = { id: 'b:0', fileName: 'a.pdf', tone: 'error' as const, message: 'No' };
    stashUploadNotices('b', [notice]);
    stashUploadNotices('other', []);
    expect(takeUploadNotices('b')).toEqual([notice]);
    expect(takeUploadNotices('b')).toEqual([]);
    expect(takeUploadNotices('other')).toEqual([]);
  });

  it('builds the bid hashes', () => {
    expect(bidHash('abc')).toBe('#/bids/abc/overview');
    expect(bidDocumentsHash('abc')).toBe('#/bids/abc/documents');
  });
});
