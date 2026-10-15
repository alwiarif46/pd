import { afterEach, describe, expect, it } from 'vitest';
import { addMonths, formatDay, formatMonth, formatRange, formatShort, monthOf, pageText, plural } from './format';

describe('schedule formatting', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('formats a day without a time zone shift', () => {
    expect(formatDay('2026-11-25')).toBe('Wed, Nov 25, 2026');
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDay('2026-11-25')).toBe('Wed, Nov 25, 2026');
    expect(formatShort('2026-11-25')).toBe('Nov 25');
  });

  it('formats one day and a span', () => {
    expect(formatRange('2026-11-25', '2026-11-25')).toBe('Nov 25');
    expect(formatRange('2026-11-25', null)).toBe('Nov 25');
    expect(formatRange('2026-11-25', '2026-11-27')).toBe('Nov 25 – Nov 27');
  });

  it('formats and moves months', () => {
    expect(formatMonth('2026-11-01')).toBe('November 2026');
    expect(monthOf('2026-11-25')).toBe('2026-11-01');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('writes plurals and page ranges', () => {
    expect(plural(1, '1 activity', '3 activities')).toBe('1 activity');
    expect(plural(3, '1 activity', '3 activities')).toBe('3 activities');
    expect(pageText(12, 13)).toBe('12–13');
    expect(pageText(12, null)).toBe('12');
    expect(pageText(null, null)).toBe('');
  });
});
