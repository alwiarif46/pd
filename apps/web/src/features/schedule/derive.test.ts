import { afterEach, describe, expect, it } from 'vitest';
import { bidDto, scheduleActivity, scheduleActivityDto } from '@/test/fixtures';
import {
  ACTIVITY_OPTIONS,
  amendmentChangeKey,
  dateChangeSummary,
  dayOf,
  dueLabelOf,
  holidaysFor,
  localToday,
  sortActivities,
  templateOptions,
  toCreateBody,
  toRowPatch,
  toAmendmentDateChange,
  toScheduleActivity,
} from './derive';

describe('dayOf and localToday', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('takes the local day, not the UTC day', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 03:00 UTC on Nov 25 is the evening of Nov 24 in Los Angeles.
    expect(localToday(new Date('2026-11-25T03:00:00.000Z'))).toBe('2026-11-24');
    process.env.TZ = 'Asia/Tokyo';
    expect(localToday(new Date('2026-11-24T20:00:00.000Z'))).toBe('2026-11-25');
  });

  it('takes the stored day and the local day', () => {
    expect(dayOf('2026-11-25T00:00:00.000Z')).toBe('2026-11-25');
    expect(dayOf(null)).toBeNull();
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('toScheduleActivity', () => {
  it('maps the timestamps to days, and a missing end to the start', () => {
    const a = toScheduleActivity(scheduleActivityDto({ endDate: null }), new Set());
    expect(a.start).toBe('2026-11-16');
    expect(a.end).toBe('2026-11-16');
    expect(a.origin).toBe('user');
    expect(a.amendment).toEqual({ kind: 'original' });
  });

  it('treats a row with a source and no origin as from the solicitation', () => {
    expect(toScheduleActivity(scheduleActivityDto({ origin: null, sourcePage: 4 }), new Set()).origin).toBe('ai');
    expect(toScheduleActivity(scheduleActivityDto({ origin: null }), new Set()).origin).toBe('user');
  });

  it('marks a superseded row', () => {
    const dto = scheduleActivityDto({ supersedeStatus: 'superseded', changedByAmendment: 2, supersededByRowId: 'act-2' });
    expect(toScheduleActivity(dto, new Set(['act-1', 'act-2'])).amendment).toEqual({
      kind: 'superseded',
      amendmentNo: 2,
      replacedById: 'act-2',
    });
  });
});

describe('sortActivities', () => {
  it('sorts by start, then label, with undated last', () => {
    const list = [
      scheduleActivity({ id: 'u', label: 'A', start: null, end: null }),
      scheduleActivity({ id: 'b', label: 'B', start: '2026-11-10' }),
      scheduleActivity({ id: 'a', label: 'A', start: '2026-11-10' }),
      scheduleActivity({ id: 'e', label: 'E', start: '2026-11-01' }),
    ];
    expect(sortActivities(list).map((a) => a.id)).toEqual(['e', 'a', 'b', 'u']);
  });
});

describe('holidaysFor', () => {
  it('covers the year before and after the data', () => {
    const days = holidaysFor({ today: '2026-10-16', startDate: null, dueDate: '2026-11-25', activities: [scheduleActivity()] }).map(
      (h) => h.date,
    );
    expect(days[0]?.startsWith('2025-01')).toBe(true);
    expect(days.at(-1)?.startsWith('2027-12')).toBe(true);
    expect(days).toContain('2026-11-26');
  });
});

describe('dueLabelOf', () => {
  it('writes the day, time, and zone', () => {
    const bid = bidDto({ dueDate: '2026-11-25T00:00:00.000Z', dueTime: '17:00', timeZone: 'America/New_York' });
    expect(dueLabelOf(bid)).toBe('Wed, Nov 25, 2026 at 5:00 PM (America/New_York)');
    expect(dueLabelOf({ ...bid, dueTime: null, timeZone: null })).toBe('Wed, Nov 25, 2026');
    expect(dueLabelOf({ ...bid, dueTime: '00:30', timeZone: null })).toBe('Wed, Nov 25, 2026 at 12:30 AM');
    expect(dueLabelOf({ ...bid, dueDate: null })).toBeNull();
    expect(dueLabelOf(null)).toBeNull();
  });
});

describe('templateOptions and ACTIVITY_OPTIONS', () => {
  it('lists the core templates and each standard name once', () => {
    expect(templateOptions().map((t) => t.id)).toEqual(['federal-standard', 'federal-fast', 'task-order']);
    expect(new Set(ACTIVITY_OPTIONS).size).toBe(ACTIVITY_OPTIONS.length);
    expect(ACTIVITY_OPTIONS.at(-1)).toBe('Proposal due');
  });
});

describe('dateChangeSummary', () => {
  const three = [
    scheduleActivity({ id: 'a', start: '2026-11-02', end: '2026-11-04' }),
    scheduleActivity({ id: 'b', start: '2026-11-09', end: '2026-11-10' }),
    scheduleActivity({ id: 'c', start: '2026-11-16', end: '2026-11-18' }),
  ];
  const submission = scheduleActivity({ id: 's', kind: 'submission', label: 'Proposal due', locked: true, start: '2026-11-27', end: '2026-11-27' });

  it('says how far shift moves the unlocked activities', () => {
    const s = dateChangeSummary(three, { previousDue: '2026-11-25', nextDue: '2026-12-02' }, { anchor: null, workdaysOnly: true });
    expect(s.shift).toBe('Moves 3 unlocked activities 4 workdays later.');
    expect(s.keep).toBe('Every activity stays where it is.');
  });

  it('says a move of 0 workdays moves nothing, and the submission follows the due date', () => {
    const s = dateChangeSummary([...three, submission], { previousDue: '2026-11-27', nextDue: '2026-11-28' }, { anchor: null, workdaysOnly: true });
    expect(s.shift).toBe('The due date moves 0 workdays, so no unlocked activity moves. The submission moves to the new due date.');
    expect(s.keep).toBe('The submission moves to the new due date. Every other activity stays where it is.');
  });

  it('falls back to shift for scale without a start date, and stretches or squeezes with one', () => {
    const change = { previousDue: '2026-11-25', nextDue: '2026-12-02' };
    expect(dateChangeSummary(three, change, { anchor: null, workdaysOnly: true }).scale).toBe(
      'The bid has no start date before both due dates, so this shifts instead. Moves 3 unlocked activities 4 workdays later.',
    );
    expect(dateChangeSummary(three, change, { anchor: '2026-10-01', workdaysOnly: true }).scale).toBe(
      'Stretches 3 unlocked activities between the start date and the new due date.',
    );
    expect(
      dateChangeSummary(three, { previousDue: '2026-12-02', nextDue: '2026-11-25' }, { anchor: '2026-10-01', workdaysOnly: true }).scale,
    ).toBe('Squeezes 3 unlocked activities between the start date and the new due date.');
  });

  it('counts days when Workdays only is off, and says locked activities stay', () => {
    const locked = scheduleActivity({ id: 'l', locked: true, start: '2026-11-05', end: '2026-11-05' });
    const s = dateChangeSummary([three[0]!, locked], { previousDue: '2026-11-25', nextDue: '2026-11-24' }, { anchor: null, workdaysOnly: false });
    expect(s.shift).toBe('Moves 1 unlocked activity 1 day earlier. Locked activities stay.');
  });

  it('says when nothing has a date to move', () => {
    const s = dateChangeSummary([], { previousDue: '2026-11-25', nextDue: '2026-12-02' }, { anchor: null, workdaysOnly: true });
    expect(s.shift).toBe('No unlocked activity has a date to move.');
  });
});

describe('toCreateBody and toRowPatch', () => {
  it('renames start and end, and copies only the keys present', () => {
    expect(
      toCreateBody({ label: 'Kickoff', kind: 'milestone', reviewColor: null, start: '2026-11-02', end: '2026-11-02', owner: null, locked: false }),
    ).toEqual({ label: 'Kickoff', kind: 'milestone', reviewColor: null, startDate: '2026-11-02', endDate: '2026-11-02', owner: null, locked: false });
    expect(toRowPatch({ owner: 'Sam' })).toEqual({ owner: 'Sam' });
    expect(toRowPatch({ start: '2026-11-03', end: null })).toEqual({ startDate: '2026-11-03', endDate: null });
  });
});

describe('toAmendmentDateChange and amendmentChangeKey', () => {
  const dto = {
    amendmentId: 'amd-3',
    amendmentNo: 3,
    previousDue: null,
    nextDue: '2026-12-02',
    sourcePage: 4,
    sourceQuote: 'Proposals are now due December 2.',
  };

  it('copies the change with origin amendment', () => {
    expect(toAmendmentDateChange(dto)).toEqual({
      origin: 'amendment',
      previousDue: null,
      nextDue: '2026-12-02',
      amendmentNo: 3,
      sourcePage: 4,
      sourceQuote: 'Proposals are now due December 2.',
    });
  });

  it('keys by bid, amendment, and next due date', () => {
    expect(amendmentChangeKey('bid-1', dto)).toBe('bid-1/amd-3/2026-12-02');
    expect(amendmentChangeKey('bid-1', { ...dto, nextDue: '2026-12-09' })).not.toBe(amendmentChangeKey('bid-1', dto));
    expect(amendmentChangeKey('bid-2', dto)).not.toBe(amendmentChangeKey('bid-1', dto));
  });
});
