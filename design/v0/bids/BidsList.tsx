import { useState } from 'react';
import { Check, FolderOpen, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { creditsLine, cx, formatDate, outOfCreditsCopy } from './format';
import type { BidCard, BidsListProps } from './types';

const STATUS_LABEL: Record<BidCard['status'], string> = {
  planning: 'Planning',
  writing: 'Writing',
  submitted: 'Submitted',
  closed: 'Closed',
};

const STATUS_CLASS: Record<BidCard['status'], string> = {
  planning: 'border-line bg-paper text-ink',
  writing: 'border-primary bg-paper text-primary',
  submitted: 'border-primary bg-primary text-primary-foreground',
  closed: 'border-line bg-weekend text-muted-foreground',
};

export function BidsList({ bids, creditsLeft, creditsResetOn, onOpen, onCreate, onUpgrade }: BidsListProps) {
  const [outOfCreditsOpen, setOutOfCreditsOpen] = useState(false);
  const outOfCredits = creditsLeft <= 0;

  function handleCreate() {
    if (outOfCredits) {
      setOutOfCreditsOpen(true);
      return;
    }
    onCreate();
  }

  return (
    <main className="flex w-full flex-col gap-6 font-sans text-ink">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-ink">Bids</h1>
          <p className={cx('text-sm', outOfCredits ? 'font-medium text-due' : 'text-muted-foreground')}>
            <span className="font-numeric tabular-nums">{creditsLine(creditsLeft, creditsResetOn)}</span>
          </p>
        </div>
        {bids.length > 0 && (
          <Button type="button" onClick={handleCreate} className="self-start sm:self-auto">
            <Plus className="size-4" aria-hidden="true" />
            Create new bid
          </Button>
        )}
      </header>

      {bids.length === 0 ? (
        <EmptyBids onCreate={handleCreate} />
      ) : (
        <>
          <div className="hidden rounded-md border border-line bg-paper md:block">
            <BidsTable bids={bids} onOpen={onOpen} />
          </div>
          <ul className="flex flex-col gap-3 md:hidden" aria-label="Bids">
            {bids.map((bid) => (
              <li key={bid.id}>
                <BidMobileCard bid={bid} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={outOfCreditsOpen} onOpenChange={setOutOfCreditsOpen}>
        <DialogContent className="bg-paper text-ink">
          <DialogHeader>
            <DialogTitle>{outOfCreditsCopy.title}</DialogTitle>
            <DialogDescription className="leading-relaxed">{outOfCreditsCopy.body(creditsResetOn)}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setOutOfCreditsOpen(false)}>
              Close
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOutOfCreditsOpen(false);
                onUpgrade();
              }}
            >
              Upgrade plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function BidsTable({ bids, onOpen }: { bids: BidCard[]; onOpen: (id: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-line hover:bg-transparent">
          <TableHead className="text-muted-foreground">Bid name</TableHead>
          <TableHead className="text-muted-foreground">Agency</TableHead>
          <TableHead className="text-muted-foreground">Due date</TableHead>
          <TableHead className="text-right text-muted-foreground">Days left</TableHead>
          <TableHead className="text-muted-foreground">Status</TableHead>
          <TableHead className="text-muted-foreground">Credit used</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bids.map((bid) => (
          <TableRow
            key={bid.id}
            onClick={() => onOpen(bid.id)}
            className="cursor-pointer border-line hover:bg-weekend has-[button:focus-visible]:bg-weekend"
          >
            <TableCell className="max-w-72 font-medium">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(bid.id);
                }}
                className="rounded-sm text-left text-ink underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <span className="sr-only">Open bid </span>
                {bid.name}
              </button>
            </TableCell>
            <TableCell className="text-ink">{bid.agency ?? <NotSet />}</TableCell>
            <TableCell className="whitespace-nowrap">
              {bid.dueDate ? (
                <span className="font-numeric tabular-nums text-ink">{formatDate(bid.dueDate)}</span>
              ) : (
                <NotSet />
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-right">
              <DaysLeft days={bid.daysLeft} />
            </TableCell>
            <TableCell>
              <StatusBadge status={bid.status} />
            </TableCell>
            <TableCell>
              <CreditUsed used={bid.creditUsed} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BidMobileCard({ bid, onOpen }: { bid: BidCard; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(bid.id)}
      className="flex w-full flex-col gap-3 rounded-md border border-line bg-paper p-4 text-left hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="sr-only">Open bid </span>
          <span className="text-pretty font-medium text-ink">{bid.name}</span>
          <span className="text-sm text-muted-foreground">{bid.agency ?? 'No agency yet'}</span>
        </div>
        <StatusBadge status={bid.status} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Due date</dt>
          <dd>
            {bid.dueDate ? (
              <span className="font-numeric tabular-nums text-ink">{formatDate(bid.dueDate)}</span>
            ) : (
              <NotSet />
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Days left</dt>
          <dd>
            <DaysLeft days={bid.daysLeft} />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Credit used</dt>
          <dd>
            <CreditUsed used={bid.creditUsed} />
          </dd>
        </div>
      </dl>
    </button>
  );
}

function EmptyBids({ onCreate }: { onCreate: () => void }) {
  return (
    <section
      aria-labelledby="no-bids-title"
      className="flex flex-col items-center gap-4 rounded-md border border-dashed border-line bg-paper px-6 py-16 text-center"
    >
      <FolderOpen className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex max-w-md flex-col gap-1">
        <h2 id="no-bids-title" className="text-lg font-semibold text-ink">
          No bids yet
        </h2>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          Create a bid and upload its solicitation. The app builds the schedule and compliance matrix from it.
        </p>
      </div>
      <Button type="button" onClick={onCreate}>
        <Plus className="size-4" aria-hidden="true" />
        Create your first bid
      </Button>
    </section>
  );
}

function DaysLeft({ days }: { days?: number }) {
  if (days === undefined) return <NotSet />;
  if (days < 0) return <span className="font-medium text-due">Past due</span>;
  const urgent = days <= 3;
  return (
    <span className={cx('font-numeric tabular-nums', urgent ? 'font-semibold text-due' : 'text-ink')}>
      {days}
      <span className={cx('font-sans', urgent ? 'text-due' : 'text-muted-foreground')}>
        {days === 1 ? ' day' : ' days'}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: BidCard['status'] }) {
  return (
    <Badge variant="outline" className={cx('shrink-0 font-medium', STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function CreditUsed({ used }: { used: boolean }) {
  if (!used) return <span className="text-muted-foreground">Not used</span>;
  return (
    <span className="inline-flex items-center gap-1 text-ink">
      <Check className="size-4 text-primary" aria-hidden="true" />
      Used
    </span>
  );
}

function NotSet() {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">{'\u2014'}</span>
      <span className="sr-only">Not set</span>
    </span>
  );
}
