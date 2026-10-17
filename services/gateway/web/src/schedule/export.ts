import { addIsoDays, countWorkdays } from '@pd/core/schedule';
import { download, downloadCsv, downloadXlsx } from '@/export';
import type { ScheduleActivity } from '@/types';
import { formatDay, pageText } from './format';
import { amendmentText, kindText, ORIGIN_LABELS } from './labels';

/** The browser side of the four exports; the container takes one so tests can swap it. */
export interface ScheduleExporter {
  csv(name: string, rows: string[][]): void;
  xlsx(name: string, rows: string[][]): void;
  ics(name: string, text: string): void;
  print(html: string): void;
}

/** Prints an HTML document through a hidden iframe, so the app shell is not on the page. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  });
  document.body.appendChild(frame);
}

export const scheduleExporter: ScheduleExporter = {
  csv: downloadCsv,
  xlsx: downloadXlsx,
  ics: (name, text) => download(name, new Blob([text], { type: 'text/calendar;charset=utf-8' })),
  print: printHtml,
};

/** Header and one row per activity, in the order given. */
export function scheduleSheet(activities: ScheduleActivity[], opts: { workdaysOnly: boolean }): string[][] {
  const header = [
    'Activity',
    'Kind',
    'Start',
    'End',
    opts.workdaysOnly ? 'Workdays' : 'Days',
    'Owner',
    'Locked',
    'Origin',
    'Amendment',
    'Source page',
    'Source quote',
  ];
  const rows = activities.map((a) => {
    const end = a.end ?? a.start;
    const count =
      a.start === null || end === null ? '' : String(countWorkdays(a.start, end, { workdaysOnly: opts.workdaysOnly }));
    return [
      a.label,
      kindText(a),
      a.start ?? '',
      a.end ?? a.start ?? '',
      count,
      a.owner ?? '',
      a.locked ? 'Yes' : 'No',
      ORIGIN_LABELS[a.origin],
      amendmentText(a.amendment) ?? '',
      pageText(a.sourcePage, a.sourcePageEnd),
      a.sourceQuote ?? '',
    ];
  });
  return [header, ...rows];
}

/** Stops a spreadsheet from running a cell as a formula (CSV only). */
export function csvSafe(rows: string[][]): string[][] {
  return rows.map((row) => row.map((cell) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell)));
}

function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function icsStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Folds a line at 75 octets without splitting a character; continuations start with a space. */
function fold(line: string): string[] {
  if (encoder.encode(line).length <= 75) return [line];
  const out: string[] = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      out.push(current);
      current = ' ';
      size = 1;
      limit = 75;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out;
}

export function scheduleIcs(activities: ScheduleActivity[], opts: { calendarName: string; now: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shaavir PD//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.calendarName)}`,
  ];
  const stamp = icsStamp(opts.now);
  for (const a of activities) {
    if (a.start === null) continue;
    if (a.amendment.kind === 'superseded' || a.amendment.kind === 'withdrawn') continue;
    const end = a.end ?? a.start;
    const description = [
      a.owner ? `Owner: ${a.owner}` : null,
      a.sourcePage !== null ? `Source: p. ${pageText(a.sourcePage, a.sourcePageEnd)}` : null,
    ].filter((part): part is string => part !== null);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.id}@pd.shaavir`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(a.start)}`,
      `DTEND;VALUE=DATE:${icsDate(addIsoDays(end, 1))}`,
      `SUMMARY:${icsEscape(a.label)}`,
    );
    if (description.length > 0) lines.push(`DESCRIPTION:${icsEscape(description.join('\n'))}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(fold).join('\r\n');
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function schedulePrintHtml(opts: {
  title: string;
  dueLabel: string | null;
  activities: ScheduleActivity[];
  workdaysOnly: boolean;
}): string {
  const day = (iso: string | null) => (iso === null ? 'No date' : formatDay(iso));
  const body = opts.activities
    .map((a) => {
      const source = a.sourcePage !== null ? `p. ${pageText(a.sourcePage, a.sourcePageEnd)}` : ORIGIN_LABELS[a.origin];
      const cells = [
        a.label,
        kindText(a),
        day(a.start),
        day(a.end ?? a.start),
        a.owner ?? '',
        a.locked ? 'Yes' : 'No',
        source,
      ];
      return `<tr>${cells.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`;
    })
    .join('');
  const head = ['Activity', 'Kind', 'Start', 'End', 'Owner', 'Locked', 'Source']
    .map((cell) => `<th>${cell}</th>`)
    .join('');
  const due = opts.dueLabel ? `Due ${opts.dueLabel}` : 'No due date yet';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${esc(opts.title)}</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:12px}',
    'h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px}',
    'table{border-collapse:collapse;width:100%}',
    'th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}',
    'th{background:#eee}',
    '@page{margin:12mm}',
    '</style></head><body>',
    `<h1>${esc(opts.title)}</h1>`,
    `<p>${esc(due)}</p>`,
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    '</body></html>',
  ].join('');
}

/** "va-ehr-support-schedule.xlsx"; an empty name gives "schedule.xlsx". */
export function exportFileName(bidName: string, ext: string): string {
  const slug = bidName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug ? `${slug}-schedule.${ext}` : `schedule.${ext}`;
}
