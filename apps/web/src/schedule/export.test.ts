import { describe, expect, it } from 'vitest';
import { scheduleActivity } from '@/test/fixtures';
import { csvSafe, exportFileName, scheduleIcs, schedulePrintHtml, scheduleSheet } from './export';

const now = new Date('2026-10-16T12:30:45Z');

describe('scheduleSheet', () => {
  const ai = scheduleActivity({
    id: 'ai',
    label: 'Proposal due',
    kind: 'submission',
    origin: 'ai',
    locked: true,
    start: '2026-11-25',
    end: '2026-11-25',
    sourcePage: 12,
    sourcePageEnd: 13,
    sourceQuote: 'Proposals are due Nov 25.',
    amendment: { kind: 'superseded', amendmentNo: 2, replacedById: null },
  });
  const user = scheduleActivity({ id: 'user', label: 'Kickoff', owner: 'Sam', origin: 'user' });
  const undated = scheduleActivity({ id: 'u', label: 'TBD', start: null, end: null, origin: 'template' });

  it('has a header and a row per activity', () => {
    const rows = scheduleSheet([ai, user, undated], { workdaysOnly: true });
    expect(rows[0]).toEqual([
      'Activity', 'Kind', 'Start', 'End', 'Workdays', 'Owner', 'Locked', 'Origin', 'Amendment', 'Source page', 'Source quote',
    ]);
    expect(rows[1]).toEqual([
      'Proposal due', 'Submission', '2026-11-25', '2026-11-25', '1', '', 'Yes', 'From the solicitation',
      'Superseded by Amd 2', '12–13', 'Proposals are due Nov 25.',
    ]);
    expect(rows[2]).toEqual([
      'Kickoff', 'Writing', '2026-11-16', '2026-11-18', '3', 'Sam', 'No', 'Added by user', '', '', '',
    ]);
    expect(rows[3]).toEqual(['TBD', 'Writing', '', '', '', '', 'No', 'From template', '', '', '']);
  });

  it('uses the review color as the kind of a review', () => {
    const review = scheduleActivity({ kind: 'review', reviewColor: 'pink' });
    expect(scheduleSheet([review], { workdaysOnly: false })[1]![1]).toBe('Pink team');
  });

  it('says Days when workdays only is off', () => {
    expect(scheduleSheet([], { workdaysOnly: false })[0]![4]).toBe('Days');
    const rows = scheduleSheet([user], { workdaysOnly: false });
    expect(rows[1]![4]).toBe('3');
  });
});

describe('csvSafe', () => {
  it('prefixes cells that would run as formulas', () => {
    const rows = csvSafe([['=SUM(1)', '+1', '-1', '@x', '\tx', 'plain', '2026-11-25']]);
    expect(rows[0]).toEqual(["'=SUM(1)", "'+1", "'-1", "'@x", "'\tx", 'plain', '2026-11-25']);
  });
});

describe('scheduleIcs', () => {
  it('writes an all-day event with an exclusive end', () => {
    const text = scheduleIcs([scheduleActivity({ id: 'act-1' })], { calendarName: 'VA schedule', now });
    expect(text).toContain('DTSTART;VALUE=DATE:20261116');
    expect(text).toContain('DTEND;VALUE=DATE:20261119');
    expect(text).toContain('UID:act-1@pd.shaavir');
    expect(text).toContain('DTSTAMP:20261016T123045Z');
    expect(text).toContain('X-WR-CALNAME:VA schedule');
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR')).toBe(true);
  });

  it('ends a span on the day after its last day', () => {
    const text = scheduleIcs([scheduleActivity({ start: '2026-11-25', end: '2026-11-30' })], { calendarName: 'x', now });
    expect(text).toContain('DTEND;VALUE=DATE:20261201');
  });

  it('escapes a lone carriage return as a line break', () => {
    const text = scheduleIcs([scheduleActivity({ label: 'One\rTwo\r\nThree' })], { calendarName: 'x', now });
    expect(text).toContain('SUMMARY:One\\nTwo\\nThree');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\r/);
  });

  it('escapes text and uses CRLF only', () => {
    const text = scheduleIcs([scheduleActivity({ label: 'Kickoff, phase 1; part A' })], { calendarName: 'x', now });
    expect(text).toContain('SUMMARY:Kickoff\\, phase 1\\; part A');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('leaves out undated, superseded and withdrawn activities', () => {
    const text = scheduleIcs(
      [
        scheduleActivity({ id: 'u', start: null, end: null }),
        scheduleActivity({ id: 's', amendment: { kind: 'superseded', amendmentNo: 1, replacedById: null } }),
        scheduleActivity({ id: 'w', amendment: { kind: 'withdrawn', amendmentNo: 1 } }),
        scheduleActivity({ id: 'ok' }),
      ],
      { calendarName: 'x', now },
    );
    expect(text).toContain('UID:ok@pd.shaavir');
    expect(text).not.toContain('UID:u@');
    expect(text).not.toContain('UID:s@');
    expect(text).not.toContain('UID:w@');
  });

  it('adds owner and source to the description', () => {
    const text = scheduleIcs([scheduleActivity({ owner: 'Sam', sourcePage: 12 })], { calendarName: 'x', now });
    expect(text).toContain('DESCRIPTION:Owner: Sam\\nSource: p. 12');
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const label = 'Évaluation des propositions '.repeat(8);
    const text = scheduleIcs([scheduleActivity({ label })], { calendarName: 'x', now });
    const lines = text.split('\r\n');
    const encoder = new TextEncoder();
    for (const line of lines) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    const summary = lines.findIndex((line) => line.startsWith('SUMMARY:'));
    expect(lines[summary + 1]!.startsWith(' ')).toBe(true);
    const unfolded = text.replace(/\r\n /g, '');
    expect(unfolded).toContain(`SUMMARY:${label}`);
  });
});

describe('schedulePrintHtml', () => {
  it('escapes values and shows the due label', () => {
    const html = schedulePrintHtml({
      title: 'VA <b> schedule',
      dueLabel: 'Wed, Nov 25, 2026',
      activities: [scheduleActivity({ label: '<script>alert(1)</script>' })],
      workdaysOnly: true,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Due Wed, Nov 25, 2026');
  });

  it('says so without a due date', () => {
    const html = schedulePrintHtml({ title: 't', dueLabel: null, activities: [], workdaysOnly: false });
    expect(html).toContain('No due date yet');
  });
});

describe('exportFileName', () => {
  it('slugs the bid name', () => {
    expect(exportFileName('VA EHR Support!', 'xlsx')).toBe('va-ehr-support-schedule.xlsx');
    expect(exportFileName('***', 'csv')).toBe('schedule.csv');
    expect(exportFileName('a'.repeat(100), 'ics')).toBe(`${'a'.repeat(60)}-schedule.ics`);
  });
});
