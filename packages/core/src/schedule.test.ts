import { describe, expect, it } from 'vitest';
import {
  addIsoDays,
  addWorkdays,
  applyScheduleMoves,
  buildScheduleTemplate,
  countWorkdays,
  federalHolidayName,
  federalHolidays,
  federalHolidaysBetween,
  findScheduleTemplate,
  inferActivityKind,
  isIsoDate,
  isWorkday,
  nextWorkday,
  planScheduleAdjust,
  SCHEDULE_TEMPLATES,
  workdayDelta,
  type AdjustableActivity,
  type DayRules,
} from './schedule';

const WORKDAYS: DayRules = { workdaysOnly: true };
const CALENDAR: DayRules = { workdaysOnly: false };

describe('ISO days', () => {
  it('accepts only real YYYY-MM-DD days', () => {
    expect(isIsoDate('2026-10-16')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-10-16T00:00:00Z')).toBe(false);
    expect(isIsoDate('10/16/2026')).toBe(false);
    expect(isIsoDate(20261016)).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('federal holidays', () => {
  it('lists 2026 with observed dates', () => {
    expect(federalHolidays(2026)).toEqual([
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-01-19', name: 'Martin Luther King Jr. Day' },
      { date: '2026-02-16', name: "Washington's Birthday" },
      { date: '2026-05-25', name: 'Memorial Day' },
      { date: '2026-06-19', name: 'Juneteenth' },
      // 4 July 2026 is a Saturday.
      { date: '2026-07-03', name: 'Independence Day (observed)' },
      { date: '2026-09-07', name: 'Labor Day' },
      { date: '2026-10-12', name: 'Columbus Day' },
      { date: '2026-11-11', name: 'Veterans Day' },
      { date: '2026-11-26', name: 'Thanksgiving Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
    ]);
  });

  it('observes Sunday holidays on Monday, Saturday ones on Friday, and next New Year on 31 December', () => {
    const dates = federalHolidays(2027).map((holiday) => holiday.date);
    expect(dates).toContain('2027-06-18'); // Juneteenth, Saturday
    expect(dates).toContain('2027-07-05'); // Independence Day, Sunday
    expect(dates).toContain('2027-12-24'); // Christmas, Saturday
    expect(federalHolidayName('2027-12-31')).toBe("New Year's Day (observed)"); // 1 Jan 2028 is a Saturday
    expect(dates).toHaveLength(12);
    // ...so 2028 has no New Year's Day of its own.
    expect(federalHolidays(2028).some((holiday) => holiday.date.startsWith('2028-01-0'))).toBe(false);
    expect(federalHolidays(2028)[0]).toEqual({ date: '2028-01-17', name: 'Martin Luther King Jr. Day' });
  });

  it('has Juneteenth only from 2021', () => {
    expect(federalHolidays(2020).some((holiday) => holiday.name.startsWith('Juneteenth'))).toBe(false);
    expect(federalHolidays(2020)).toHaveLength(10);
    expect(federalHolidayName('2021-06-18')).toBe('Juneteenth (observed)');
  });

  it('computes any year, not a fixed list', () => {
    expect(federalHolidayName('2035-11-22')).toBe('Thanksgiving Day');
    expect(federalHolidayName('2040-05-28')).toBe('Memorial Day');
    expect(federalHolidayName('2026-11-27')).toBeNull();
  });

  it('lists the holidays in a range across years', () => {
    expect(federalHolidaysBetween('2026-12-20', '2027-01-20').map((holiday) => holiday.date))
      .toEqual(['2026-12-25', '2027-01-01', '2027-01-18']);
  });
});

describe('workdays', () => {
  it('skips weekends and federal holidays only when workdaysOnly is on', () => {
    expect(isWorkday('2026-11-26', WORKDAYS)).toBe(false); // Thanksgiving
    expect(isWorkday('2026-11-27', WORKDAYS)).toBe(true);
    expect(isWorkday('2026-11-28', WORKDAYS)).toBe(false); // Saturday
    expect(isWorkday('2026-11-28', CALENDAR)).toBe(true);
    expect(isWorkday('2026-11-26', CALENDAR)).toBe(true);
    expect(isWorkday('2026-11-27', { workdaysOnly: true, extraHolidays: new Set(['2026-11-27']) })).toBe(false);
  });

  it('adds workdays over weekends and holidays', () => {
    expect(addWorkdays('2026-11-20', 1, WORKDAYS)).toBe('2026-11-23'); // Friday to Monday
    expect(addWorkdays('2026-11-25', 1, WORKDAYS)).toBe('2026-11-27'); // over Thanksgiving
    expect(addWorkdays('2026-11-30', -1, WORKDAYS)).toBe('2026-11-27');
    expect(addWorkdays('2026-12-24', 1, WORKDAYS)).toBe('2026-12-28'); // over Christmas and a weekend
    expect(addWorkdays('2027-12-30', 1, WORKDAYS)).toBe('2028-01-03'); // over New Year's observed on 31 Dec
    expect(addWorkdays('2026-11-28', 0, WORKDAYS)).toBe('2026-11-28'); // 0 never moves
    expect(addWorkdays('2026-11-28', 1, WORKDAYS)).toBe('2026-11-30'); // Saturday + 1
    expect(addWorkdays('2026-11-25', 1, CALENDAR)).toBe('2026-11-26');
    expect(nextWorkday('2026-11-26', WORKDAYS)).toBe('2026-11-27');
    expect(nextWorkday('2026-11-26', CALENDAR)).toBe('2026-11-26');
  });

  it('counts workdays in an inclusive range', () => {
    expect(countWorkdays('2026-11-23', '2026-11-27', WORKDAYS)).toBe(4);
    expect(countWorkdays('2026-11-23', '2026-11-27', CALENDAR)).toBe(5);
    expect(countWorkdays('2026-11-27', '2026-11-23', WORKDAYS)).toBe(0);
    expect(countWorkdays('2026-11-27', '2026-11-23', CALENDAR)).toBe(0);
  });

  it('counts and adds the same as a day-by-day walk, with extra holidays too', () => {
    const extra = new Set(['2026-11-27', '2027-01-02', '2027-03-10']); // a Friday, a Saturday, a Wednesday
    const walk = (start: string, end: string, rules: DayRules) => {
      let total = 0;
      for (let cursor = start; cursor <= end; cursor = addIsoDays(cursor, 1)) if (isWorkday(cursor, rules)) total += 1;
      return total;
    };
    const step = (date: string, n: number, rules: DayRules) => {
      let cursor = date;
      for (let left = Math.abs(n); left > 0;) {
        cursor = addIsoDays(cursor, n < 0 ? -1 : 1);
        if (isWorkday(cursor, rules)) left -= 1;
      }
      return cursor;
    };
    for (const rules of [WORKDAYS, { workdaysOnly: true, extraHolidays: extra }]) {
      for (const start of ['2026-10-30', '2026-11-26', '2026-12-26', '2027-01-01']) {
        for (const days of [0, 1, 6, 7, 8, 30, 64, 200, 400]) {
          const end = addIsoDays(start, days);
          expect(countWorkdays(start, end, rules), `${start}+${days}`).toBe(walk(start, end, rules));
        }
        for (const n of [-300, -41, -9, -8, -1, 1, 8, 9, 23, 41, 300]) {
          expect(addWorkdays(start, n, rules), `${start} ${n}`).toBe(step(start, n, rules));
        }
      }
    }
  });

  it('stays fast over centuries', () => {
    // An adjust plans every activity; a day-by-day walk took about a second per 20 of these.
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) {
      expect(workdayDelta('1900-01-01', '2200-12-31', WORKDAYS)).toBeGreaterThan(70_000);
      expect(addWorkdays('1900-01-01', 70_000, WORKDAYS) > '2160-01-01').toBe(true);
      expect(addWorkdays('2200-12-31', -70_000, WORKDAYS) < '1940-12-31').toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('gives a delta that lands on the target whenever the target is a workday', () => {
    const days = Array.from({ length: 50 }, (_, index) => addIsoDays('2026-11-15', index));
    for (const from of days) {
      for (const to of days) {
        const delta = workdayDelta(from, to, WORKDAYS);
        if (isWorkday(to, WORKDAYS)) {
          expect(addWorkdays(from, delta, WORKDAYS), `${from} -> ${to}`).toBe(to);
        }
        expect(Math.sign(delta) === 0 || Math.sign(delta) === Math.sign(to.localeCompare(from)), `${from} -> ${to}`).toBe(true);
        expect(addWorkdays(from, workdayDelta(from, to, CALENDAR), CALENDAR)).toBe(to);
      }
    }
  });
});

describe('planScheduleAdjust', () => {
  const activities: AdjustableActivity[] = [
    { id: 'draft', start: '2026-11-16', end: '2026-11-18', locked: false },
    { id: 'pink', start: '2026-11-19', end: null, locked: false },
    { id: 'due', start: '2026-11-20', end: '2026-11-20', locked: true },
    { id: 'undated', start: null, end: null, locked: false },
  ];

  it('shifts unlocked activities by the due date move in workdays', () => {
    // Friday 20 Nov to Monday 30 Nov: 23, 24, 25, 27, 30 (Thanksgiving skipped) = 5 workdays.
    const plan = planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30', anchor: null, workdaysOnly: true,
    });
    expect(plan).toMatchObject({ requestedMode: 'shift', mode: 'shift', unit: 'workdays', delta: 5 });
    expect(plan.moves).toEqual([
      { id: 'draft', previousStart: '2026-11-16', previousEnd: '2026-11-18', start: '2026-11-23', end: '2026-11-25', followsDue: false },
      { id: 'pink', previousStart: '2026-11-19', previousEnd: '2026-11-19', start: '2026-11-27', end: '2026-11-27', followsDue: false },
    ]);
  });

  it('shifts by calendar days when workdaysOnly is off', () => {
    const plan = planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30', anchor: null, workdaysOnly: false,
    });
    expect(plan).toMatchObject({ unit: 'days', delta: 10 });
    expect(plan.moves.map((move) => [move.id, move.start, move.end])).toEqual([
      ['draft', '2026-11-26', '2026-11-28'],
      ['pink', '2026-11-29', '2026-11-29'],
    ]);
  });

  it('shifts earlier', () => {
    const plan = planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-30', nextDue: '2026-11-20', anchor: null, workdaysOnly: true,
    });
    expect(plan.delta).toBe(-5);
    expect(plan.moves[0]).toMatchObject({ id: 'draft', start: '2026-11-06', end: '2026-11-10' }); // over Veterans Day
  });

  it('never moves locked or undated activities, in any mode', () => {
    for (const mode of ['shift', 'scale', 'keep'] as const) {
      for (const workdaysOnly of [true, false]) {
        const plan = planScheduleAdjust(activities, {
          mode, previousDue: '2026-11-20', nextDue: '2026-12-04', anchor: '2026-11-02', workdaysOnly,
        });
        expect(plan.moves.map((move) => move.id)).not.toContain('due');
        expect(plan.moves.map((move) => move.id)).not.toContain('undated');
      }
    }
  });

  it('keeps everything on keep, and when the due date did not move', () => {
    expect(planScheduleAdjust(activities, {
      mode: 'keep', previousDue: '2026-11-20', nextDue: '2026-11-30', anchor: '2026-11-02', workdaysOnly: true,
    }).moves).toEqual([]);
    expect(planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-20', anchor: null, workdaysOnly: true,
    }).moves).toEqual([]);
    // Saturday to Sunday is no workday at all.
    expect(planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-21', nextDue: '2026-11-22', anchor: null, workdaysOnly: true,
    })).toMatchObject({ delta: 0, moves: [] });
  });

  it('scales calendar days from the anchor, rounding halves later', () => {
    const list: AdjustableActivity[] = [
      { id: 'a', start: '2026-01-04', end: '2026-01-06', locked: false },
      { id: 'before', start: '2025-12-30', end: '2026-01-02', locked: false },
      { id: 'anchor', start: '2026-01-01', end: '2026-01-01', locked: false },
    ];
    const options = { mode: 'scale' as const, previousDue: '2026-01-11', anchor: '2026-01-01', workdaysOnly: false };
    // Span 10 -> 20: offsets 3 and 5 double.
    expect(planScheduleAdjust(list, { ...options, nextDue: '2026-01-21' }).moves).toEqual([
      { id: 'a', previousStart: '2026-01-04', previousEnd: '2026-01-06', start: '2026-01-07', end: '2026-01-11', followsDue: false },
    ]);
    // Span 10 -> 15: 4.5 rounds to 5, 7.5 to 8.
    expect(planScheduleAdjust(list, { ...options, nextDue: '2026-01-16' }).moves[0]).toMatchObject({ start: '2026-01-06', end: '2026-01-09' });
    // Span 10 -> 5: 1.5 rounds to 2, 2.5 to 3.
    expect(planScheduleAdjust(list, { ...options, nextDue: '2026-01-06' }).moves[0]).toMatchObject({ start: '2026-01-03', end: '2026-01-04' });
  });

  it('scales workdays from the anchor', () => {
    // Anchor Monday 2 Mar 2026; due Fri 13 Mar (9 workdays after) moves to Fri 27 Mar (19).
    const plan = planScheduleAdjust([{ id: 'a', start: '2026-03-05', end: '2026-03-06', locked: false }], {
      mode: 'scale', previousDue: '2026-03-13', nextDue: '2026-03-27', anchor: '2026-03-02', workdaysOnly: true,
    });
    expect(plan.mode).toBe('scale');
    // Offsets 3 and 4 become 3*19/9 = 6.33 -> 6 and 4*19/9 = 8.44 -> 8.
    expect(plan.moves[0]).toMatchObject({ start: '2026-03-10', end: '2026-03-12' });
  });

  it('keeps a one-day activity one day long when scaling', () => {
    const plan = planScheduleAdjust([{ id: 'a', start: '2026-03-09', end: '2026-03-09', locked: false }], {
      mode: 'scale', previousDue: '2026-03-13', nextDue: '2026-03-09', anchor: '2026-03-02', workdaysOnly: true,
    });
    expect(plan.moves[0].start).toBe(plan.moves[0].end);
  });

  it('shifts instead of scaling without a usable anchor', () => {
    for (const anchor of [null, '2026-11-20', '2026-12-01']) {
      const plan = planScheduleAdjust(activities, {
        mode: 'scale', previousDue: '2026-11-20', nextDue: '2026-11-30', anchor, workdaysOnly: true,
      });
      expect(plan).toMatchObject({ requestedMode: 'scale', mode: 'shift', delta: 5 });
      expect(plan.moves[0]).toMatchObject({ id: 'draft', start: '2026-11-23' });
    }
  });

  it('moves the locked submission on the old due date to the new one, in every mode', () => {
    const list: AdjustableActivity[] = [
      { id: 'due', start: '2026-11-20', end: '2026-11-20', locked: true, kind: 'submission' },
      { id: 'earlier', start: '2026-11-13', end: null, locked: true, kind: 'submission' },
      { id: 'questions', start: '2026-11-20', end: null, locked: true, kind: 'milestone' },
      { id: 'draft', start: '2026-11-16', end: '2026-11-18', locked: false, kind: 'writing' },
    ];
    for (const workdaysOnly of [true, false]) {
      for (const [mode, anchor] of [['shift', null], ['scale', '2026-11-02'], ['scale', null]] as const) {
        const plan = planScheduleAdjust(list, { mode, previousDue: '2026-11-20', nextDue: '2026-11-28', anchor, workdaysOnly });
        // Saturday 28 Nov: the due date goes exactly where it was set, workday or not.
        expect(plan.moves.find((move) => move.id === 'due')).toEqual({
          id: 'due', previousStart: '2026-11-20', previousEnd: '2026-11-20', start: '2026-11-28', end: '2026-11-28', followsDue: true,
        });
        expect(plan.moves.map((move) => move.id).sort()).toEqual(['draft', 'due']);
        expect(plan.moves.find((move) => move.id === 'draft')?.followsDue).toBe(false);
      }
    }
    // On keep only the due date itself moves.
    expect(planScheduleAdjust(list, {
      mode: 'keep', previousDue: '2026-11-20', nextDue: '2026-11-28', anchor: null, workdaysOnly: true,
    }).moves).toEqual([
      { id: 'due', previousStart: '2026-11-20', previousEnd: '2026-11-20', start: '2026-11-28', end: '2026-11-28', followsDue: true },
    ]);
    // A multi-day submission keeps its length.
    const long = planScheduleAdjust([{ id: 'window', start: '2026-11-20', end: '2026-11-23', locked: true, kind: 'submission' }], {
      mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-25', anchor: null, workdaysOnly: true,
    });
    expect(long.moves[0]).toMatchObject({ start: '2026-11-25', end: '2026-11-28' });
  });

  it('applies moves for a preview', () => {
    const plan = planScheduleAdjust(activities, {
      mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-23', anchor: null, workdaysOnly: true,
    });
    const next = applyScheduleMoves(activities, plan.moves);
    expect(next.map((activity) => activity.start)).toEqual(['2026-11-17', '2026-11-20', '2026-11-20', null]);
    expect(next[2]).toBe(activities[2]);
  });
});

describe('templates', () => {
  it('has the three prototype templates', () => {
    expect(SCHEDULE_TEMPLATES.map((template) => template.id)).toEqual(['federal-standard', 'federal-fast', 'task-order']);
    expect(findScheduleTemplate('task-order')?.items).toHaveLength(4);
    expect(findScheduleTemplate('standard')).toBeNull();
  });

  it('counts back from the due date in workdays', () => {
    const built = buildScheduleTemplate(findScheduleTemplate('federal-standard')!, '2026-11-25', WORKDAYS);
    const byLabel = new Map(built.map((entry) => [entry.label, entry]));
    // 29 workdays before Wed 25 Nov 2026, skipping Veterans Day.
    expect(byLabel.get('Kickoff meeting')).toEqual({ label: 'Kickoff meeting', kind: 'milestone', reviewColor: null, start: '2026-10-14', end: '2026-10-14' });
    expect(byLabel.get('Outline and compliance matrix')).toMatchObject({ start: '2026-10-15', end: '2026-10-20' });
    expect(byLabel.get('Gold team review')).toMatchObject({ kind: 'review', reviewColor: 'gold', start: '2026-11-18', end: '2026-11-18' });
    expect(byLabel.get('Production and packaging')).toMatchObject({ start: '2026-11-19', end: '2026-11-20' });
    expect(byLabel.get('White glove review')).toMatchObject({ reviewColor: 'white_glove', start: '2026-11-23', end: '2026-11-23' });
    for (const entry of built) {
      expect(isWorkday(entry.start, WORKDAYS)).toBe(true);
      expect(isWorkday(entry.end, WORKDAYS)).toBe(true);
      expect(entry.end >= entry.start).toBe(true);
    }
  });

  it('counts calendar days when workdaysOnly is off', () => {
    const built = buildScheduleTemplate(findScheduleTemplate('federal-standard')!, '2026-11-25', CALENDAR);
    expect(built[0]).toMatchObject({ start: '2026-10-27', end: '2026-10-27' });
    expect(built[1]).toMatchObject({ start: '2026-10-28', end: '2026-10-31' });
  });
});

describe('inferActivityKind', () => {
  it.each([
    ['Pink team', 'review', 'pink'],
    ['Red team review', 'review', 'red'],
    ['gold-team', 'review', 'gold'],
    ['White glove review', 'review', 'white_glove'],
    ['Reduce page count', 'custom', null],
    ['Proposal due', 'submission', null],
    ['Submit', 'submission', null],
    ['Questions due', 'milestone', null],
    ['Kickoff', 'milestone', null],
    ['Date from solicitation', 'custom', null],
    ['Production', 'production', null],
    ['Print and package', 'production', null],
    ['Storyboard', 'writing', null],
    ['Draft', 'writing', null],
    ['Final revisions', 'writing', null],
    ['Lunch', 'custom', null],
    ['Proposal submission', 'submission', null],
    ['Due date', 'submission', null],
    ['Questions due date', 'milestone', null],
  ])('%s is %s', (label, kind, reviewColor) => {
    expect(inferActivityKind(label)).toEqual({ kind, reviewColor });
  });
});
