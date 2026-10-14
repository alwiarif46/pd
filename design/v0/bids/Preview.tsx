import { useState } from 'react';
import { BidsList } from './BidsList';
import { formatFileSize } from './format';
import { NewBid, NewBidForm } from './NewBid';
import {
  SAMPLE_BIDS,
  SAMPLE_CREDITS_RESET_ON,
  sampleFilesOverFreeCap,
  sampleFilesWithinCap,
} from './sample-data';
import type { BidType } from './types';

const STATES = [
  { id: 'list', label: 'List with bids' },
  { id: 'list-empty', label: 'Empty list' },
  { id: 'list-out', label: 'List, out of credits' },
  { id: 'new-empty', label: 'New bid, empty' },
  { id: 'new-files', label: 'New bid, with files' },
  { id: 'new-over-cap', label: 'New bid, over cap (free)' },
  { id: 'new-out', label: 'New bid, out of credits' },
] as const;

type PreviewState = (typeof STATES)[number]['id'];

export default function Preview() {
  const [state, setState] = useState<PreviewState>('list');
  const [lastAction, setLastAction] = useState('None yet');

  const listCallbacks = {
    onOpen: (id: string) => setLastAction(`onOpen("${id}")`),
    onCreate: () => setLastAction('onCreate()'),
    onUpgrade: () => setLastAction('onUpgrade()'),
  };
  const newBidCallbacks = {
    onCreate: (name: string, bidType: BidType, files: File[]) =>
      setLastAction(
        `onCreate("${name}", "${bidType}", [${files.map((f) => `${f.name} (${formatFileSize(f.size)})`).join(', ')}])`,
      ),
    onCancel: () => setLastAction('onCancel()'),
    onUpgrade: () => setLastAction('onUpgrade()'),
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas font-sans text-ink">
      <div className="flex flex-col gap-3 border-b border-line bg-paper px-4 py-3 sm:px-8">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview state</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Preview state">
          {STATES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={state === option.id}
              onClick={() => {
                setState(option.id);
                setLastAction('None yet');
              }}
              className={
                state === option.id
                  ? 'rounded-md border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground'
                  : 'rounded-md border border-line bg-paper px-3 py-1.5 text-sm text-ink hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="break-all text-sm text-muted-foreground" aria-live="polite">
          Last callback: <code className="font-numeric text-ink">{lastAction}</code>
        </p>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 justify-center px-4 py-8 sm:px-8">
        {state === 'list' && (
          <BidsList bids={SAMPLE_BIDS} creditsLeft={7} creditsResetOn={SAMPLE_CREDITS_RESET_ON} {...listCallbacks} />
        )}
        {state === 'list-empty' && (
          <BidsList bids={[]} creditsLeft={2} creditsResetOn={SAMPLE_CREDITS_RESET_ON} {...listCallbacks} />
        )}
        {state === 'list-out' && (
          <BidsList bids={SAMPLE_BIDS} creditsLeft={0} creditsResetOn={SAMPLE_CREDITS_RESET_ON} {...listCallbacks} />
        )}
        {state === 'new-empty' && (
          <NewBid
            key="new-empty"
            creditsLeft={7}
            creditsResetOn={SAMPLE_CREDITS_RESET_ON}
            plan="starter"
            mbCap={300}
            {...newBidCallbacks}
          />
        )}
        {state === 'new-files' && (
          <NewBidForm
            key="new-files"
            creditsLeft={7}
            creditsResetOn={SAMPLE_CREDITS_RESET_ON}
            plan="starter"
            mbCap={300}
            initialFiles={sampleFilesWithinCap()}
            {...newBidCallbacks}
          />
        )}
        {state === 'new-over-cap' && (
          <NewBidForm
            key="new-over-cap"
            creditsLeft={1}
            creditsResetOn={SAMPLE_CREDITS_RESET_ON}
            plan="free"
            mbCap={50}
            initialFiles={sampleFilesOverFreeCap()}
            {...newBidCallbacks}
          />
        )}
        {state === 'new-out' && (
          <NewBid
            key="new-out"
            creditsLeft={0}
            creditsResetOn={SAMPLE_CREDITS_RESET_ON}
            plan="free"
            mbCap={50}
            {...newBidCallbacks}
          />
        )}
      </div>
    </div>
  );
}
