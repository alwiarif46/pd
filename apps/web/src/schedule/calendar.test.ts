import { describe, expect, it } from 'vitest';
import { scheduleActivity } from '@/test/fixtures';
import { layoutWeek, monthWeeks } from './calendar';

describe('monthWeeks', () => {
  it('covers November 2026 in five Sunday-to-Saturday weeks', () => {
    const weeks = monthWeeks('2026-11-01');
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]).toBe('2026-11-01');
    expect(weeks[4]![6]).toBe('2026-12-05');
  });

  it('starts October 2026 on the Sunday before the 1st', () => {
    expect(monthWeeks('2026-10-01')[0]![0]).toBe('2026-09-27');
  });
});

describe('layoutWeek', () => {
  const week = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];

  it('puts overlapping activities in different lanes and reuses a free lane', () => {
    const a = scheduleActivity({ id: 'a', label: 'A', start: '2026-11-16', end: '2026-11-18' });
    const b = scheduleActivity({ id: 'b', label: 'B', start: '2026-11-17', end: '2026-11-19' });
    const c = scheduleActivity({ id: 'c', label: 'C', start: '2026-11-20', end: '2026-11-20' });
    const segments = layoutWeek(week, [c, b, a]);
    const lane = (id: string) => segments.find((s) => s.activity.id === id)!.lane;
    expect(lane('a')).toBe(0);
    expect(lane('b')).toBe(1);
    expect(lane('c')).toBe(0);
    expect(segments.find((s) => s.activity.id === 'a')).toMatchObject({ colStart: 1, colEnd: 3 });
  });

  it('marks a span that crosses weeks', () => {
    const long = scheduleActivity({ id: 'l', start: '2026-11-19', end: '2026-11-24' });
    const first = layoutWeek(week, [long])[0]!;
    expect(first).toMatchObject({ continuesLeft: false, continuesRight: true, colEnd: 6, primary: true });
    const nextWeek = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'];
    const second = layoutWeek(nextWeek, [long])[0]!;
    expect(second).toMatchObject({ continuesLeft: true, continuesRight: false, colStart: 0, colEnd: 2, primary: false });
    expect(layoutWeek(nextWeek, [long], true)[0]!.primary).toBe(true);
  });

  it('leaves out undated activities and ones outside the week', () => {
    const undated = scheduleActivity({ id: 'u', start: null, end: null });
    const far = scheduleActivity({ id: 'f', start: '2026-12-10', end: '2026-12-11' });
    expect(layoutWeek(week, [undated, far])).toEqual([]);
  });
});
