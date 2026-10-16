import { useEffect, useRef } from 'react';
import { countWorkdays } from '@pd/core/schedule';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ScheduleActivity } from '@/types';
import { SourceLink } from '@/ui/common/SourceLink';
import { formatDay } from './format';
import { amendmentText, kindText, ORIGIN_LABELS } from './labels';

interface Props {
  activities: ScheduleActivity[];
  today: string;
  workdaysOnly: boolean;
  selectedRowId: string | null;
  onSelect: (id: string) => void;
  onOpenRow: (id: string) => void;
  onToggleLock: (id: string, locked: boolean) => void;
  onOpenSource: (id: string) => void;
}

export function MilestoneList(p: Props) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.selectedRowId === null) return;
    root.current?.querySelector<HTMLElement>(`[data-row="${p.selectedRowId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [p.selectedRowId]);

  return (
    <div ref={root} className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Activity</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>End</TableHead>
            <TableHead>{p.workdaysOnly ? 'Workdays' : 'Days'}</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Lock</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {p.activities.map((a) => {
            const mark = amendmentText(a.amendment);
            const off = a.amendment.kind === 'superseded' || a.amendment.kind === 'withdrawn';
            const end = a.end ?? a.start;
            const selected = a.id === p.selectedRowId;
            return (
              <TableRow
                key={a.id}
                data-row={a.id}
                aria-selected={selected ? 'true' : undefined}
                className={selected ? 'bg-accent' : undefined}
              >
                <TableCell className="whitespace-normal">
                  <Button
                    type="button"
                    variant="link"
                    className={off ? 'h-auto p-0 line-through' : 'h-auto p-0'}
                    onClick={() => p.onSelect(a.id)}
                  >
                    {a.label}
                  </Button>
                  {mark && (
                    <Badge variant="outline" className="ml-2">
                      {mark}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{kindText(a)}</TableCell>
                <TableCell className="font-numeric tabular-nums">{a.start ? formatDay(a.start) : 'No date'}</TableCell>
                <TableCell className="font-numeric tabular-nums">{end ? formatDay(end) : 'No date'}</TableCell>
                <TableCell className="font-numeric tabular-nums">
                  {a.start && end ? countWorkdays(a.start, end, { workdaysOnly: p.workdaysOnly }) : '—'}
                </TableCell>
                <TableCell>{a.owner ?? ''}</TableCell>
                <TableCell>
                  <Checkbox
                    checked={a.locked}
                    aria-label={`Lock ${a.label}`}
                    onCheckedChange={(checked) => p.onToggleLock(a.id, checked === true)}
                  />
                </TableCell>
                <TableCell>
                  {a.origin === 'ai' ? (
                    <SourceLink
                      page={a.sourcePage}
                      pageEnd={a.sourcePageEnd}
                      rowLabel={a.label}
                      onOpen={() => p.onOpenSource(a.id)}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">{ORIGIN_LABELS[a.origin]}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button type="button" variant="outline" size="sm" aria-label={`Details for ${a.label}`} onClick={() => p.onOpenRow(a.id)}>
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
