import { useEffect, useMemo, useRef } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { addIsoDays, diffIsoDays } from '@pd/core/schedule';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ScheduleActivity } from '@/types';
import { layoutWeek, monthWeeks } from './calendar';
import type { Segment } from './calendar';
import { addMonths, formatMonth, formatRange, monthOf } from './format';
import { amendmentText, BAR_CLASSES, kindText, toneOf } from './labels';

interface Props {
  activities: ScheduleActivity[];
  holidays: Map<string, string>;
  today: string;
  dueDate: string | null;
  /** Any day of the month shown, 'YYYY-MM-01'. */
  month: string;
  selectedRowId: string | null;
  onMonthChange: (month: string) => void;
  onSelect: (id: string) => void;
  onMove: (id: string, start: string, end: string) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isOff(mark: ScheduleActivity['amendment']): boolean {
  return mark.kind === 'superseded' || mark.kind === 'withdrawn';
}

export function ScheduleCalendar(p: Props) {
  const weeks = useMemo(() => monthWeeks(p.month), [p.month]);
  const monthKey = p.month.slice(0, 7);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; grabbedDay: string } | null>(null);
  const refocus = useRef<string | null>(null);
  const undated = p.activities.filter((a) => a.start === null);

  // After a keyboard move the bar may have been re-created in another week: put focus back on it.
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-activity="${id}"]`)?.focus();
  });

  const shiftBy = (a: ScheduleActivity, days: number) => {
    if (a.start === null || a.locked) return;
    refocus.current = a.id;
    p.onMove(a.id, addIsoDays(a.start, days), addIsoDays(a.end ?? a.start, days));
  };

  const onKeyDown = (event: KeyboardEvent, a: ScheduleActivity) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 7 : 1;
    shiftBy(a, event.key === 'ArrowRight' ? step : -step);
  };

  const onDragStart = (event: DragEvent<HTMLButtonElement>, seg: Segment, week: string[]) => {
    const width = event.currentTarget.getBoundingClientRect().width;
    const spanDays = seg.colEnd - seg.colStart + 1;
    let col = seg.colStart;
    if (width > 0 && Number.isFinite(event.nativeEvent.offsetX)) {
      col = seg.colStart + Math.min(spanDays - 1, Math.max(0, Math.floor(event.nativeEvent.offsetX / (width / spanDays))));
    }
    drag.current = { id: seg.activity.id, grabbedDay: week[col]! };
    event.dataTransfer.setData('text/plain', seg.activity.id);
  };

  /**
   * The day under the pointer in a week row. Bars cover the day cells, so the row takes the drop and
   * finds the column from the pointer; without a layout (no width), the day cell that was hit.
   */
  const dayAt = (event: DragEvent<HTMLElement>, week: string[]): string | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && Number.isFinite(event.clientX)) {
      const col = Math.min(6, Math.max(0, Math.floor(((event.clientX - rect.left) * 7) / rect.width)));
      return week[col] ?? null;
    }
    return (event.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset.date ?? null;
  };

  const onDrop = (event: DragEvent<HTMLElement>, week: string[]) => {
    const current = drag.current;
    if (current === null) return;
    event.preventDefault();
    drag.current = null;
    const day = dayAt(event, week);
    if (day === null) return;
    const a = p.activities.find((item) => item.id === current.id);
    if (!a || a.start === null || a.locked) return;
    const offset = diffIsoDays(current.grabbedDay, day);
    if (offset === 0) return;
    p.onMove(a.id, addIsoDays(a.start, offset), addIsoDays(a.end ?? a.start, offset));
  };

  return (
    <div ref={root} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => p.onMonthChange(addMonths(p.month, -1))}
        >
          <ChevronLeft />
        </Button>
        <h3 className="min-w-36 text-center text-lg font-semibold">{formatMonth(p.month)}</h3>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Next month"
          onClick={() => p.onMonthChange(addMonths(p.month, 1))}
        >
          <ChevronRight />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => p.onMonthChange(monthOf(p.today))}>
          Today
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={p.dueDate === null}
          onClick={() => p.dueDate && p.onMonthChange(monthOf(p.dueDate))}
        >
          Due date
        </Button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground" aria-hidden="true">
        {WEEKDAYS.map((name) => (
          <div key={name}>{name}</div>
        ))}
      </div>
      <div className="grid gap-px">
        {weeks.map((week, weekIndex) => {
          const segments = layoutWeek(week, p.activities, weekIndex === 0);
          const lanes = segments.reduce((max, seg) => Math.max(max, seg.lane + 1), 0);
          return (
            <div
              key={week[0]}
              className="grid grid-cols-7"
              style={{ gridTemplateRows: `minmax(2.5rem, auto) repeat(${lanes}, 1.625rem)` }}
              onDragOver={(event) => {
                if (drag.current !== null) event.preventDefault();
              }}
              onDrop={(event) => onDrop(event, week)}
            >
              {week.map((day, col) => {
                const holiday = p.holidays.get(day);
                const weekend = col === 0 || col === 6;
                const outside = day.slice(0, 7) !== monthKey;
                const isToday = day === p.today;
                const isDue = day === p.dueDate;
                const classes = [
                  'min-h-24 border border-line p-1 text-xs',
                  weekend ? 'bg-weekend' : '',
                  holiday ? 'bg-holiday' : '',
                  outside ? 'text-muted-foreground' : '',
                  isToday ? 'text-today ring-1 ring-today' : '',
                ];
                return (
                  <div
                    key={day}
                    data-date={day}
                    aria-current={isToday ? 'date' : undefined}
                    className={classes.filter(Boolean).join(' ')}
                    style={{ gridColumn: col + 1, gridRow: `1 / span ${lanes + 1}` }}
                  >
                    <span className="font-numeric tabular-nums">{Number(day.slice(8, 10))}</span>
                    {isDue && <span className="ml-1 font-medium text-due">Due</span>}
                    {holiday && <span className="block text-xs">{holiday}</span>}
                  </div>
                );
              })}
              {segments.map((seg) => {
                const a = seg.activity;
                const off = isOff(a.amendment);
                const mark = amendmentText(a.amendment);
                const selected = a.id === p.selectedRowId;
                const barClasses = [
                  'z-10 mx-0.5 flex items-center gap-1 overflow-hidden px-1.5 text-left text-xs',
                  BAR_CLASSES[toneOf(a)] ?? '',
                  seg.continuesLeft ? 'rounded-l-none' : 'rounded-l-md',
                  seg.continuesRight ? 'rounded-r-none' : 'rounded-r-md',
                  off ? 'line-through opacity-60' : '',
                  selected ? 'ring-2 ring-today' : '',
                  a.locked ? '' : 'cursor-grab',
                ];
                const hint = a.locked ? ', locked' : ', use the arrow keys to move by a day, Shift for a week';
                return (
                  <button
                    key={`${a.id}-${week[0]}`}
                    type="button"
                    data-activity={a.id}
                    draggable={!a.locked}
                    aria-label={`${a.label}, ${formatRange(a.start ?? '', a.end)}, ${kindText(a)}${hint}`}
                    className={barClasses.filter(Boolean).join(' ')}
                    style={{ gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 2}`, gridRow: seg.lane + 2 }}
                    onClick={() => p.onSelect(a.id)}
                    onKeyDown={(event) => onKeyDown(event, a)}
                    onDragStart={(event) => onDragStart(event, seg, week)}
                    onDragEnd={() => {
                      drag.current = null;
                    }}
                  >
                    {seg.primary && a.locked && <Lock className="size-3 shrink-0" aria-hidden="true" />}
                    {seg.primary && <span className="truncate">{mark ? `${a.label} (${mark})` : a.label}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {undated.length > 0 && (
        <div className="grid gap-2">
          <h4 className="text-sm font-semibold">{`Not on the calendar yet (${undated.length})`}</h4>
          <ul className="flex flex-wrap gap-2">
            {undated.map((a) => (
              <li key={a.id}>
                <Button type="button" variant="outline" size="sm" onClick={() => p.onSelect(a.id)}>
                  {a.label}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
