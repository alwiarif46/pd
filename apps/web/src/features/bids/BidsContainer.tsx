import { useEffect, useState } from 'react';
import { isAbortError } from '@/api';
import { Button } from '@/components/ui/button';
import { BidsList } from '@/ui/bids/BidsList';
import { bidsApi, loadBidsScreen, messageOf, type BidsApi, type BidsScreenData } from './controller';
import { bidHash, NEW_BID_HASH, UPGRADE_HASH } from './routes';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | BidsScreenData;

interface Props {
  /** Test seam; defaults to the typed client. */
  api?: BidsApi;
}

function go(hash: string) {
  window.location.hash = hash;
}

/** Loads the bids and the credit count, and renders the v0 list. */
export function BidsContainer({ api = bidsApi }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    loadBidsScreen(api, new Date(), abort.signal).then(setState, (error: unknown) => {
      if (!isAbortError(error)) setState({ kind: 'error', message: messageOf(error) });
    });
    return () => abort.abort();
  }, [api, attempt]);

  if (state.kind === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading bids...
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div role="alert" className="flex max-w-md flex-col items-start gap-3 text-ink">
        <p className="text-sm text-due">{state.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setState({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (state.kind === 'no_org') {
    return (
      <p className="text-sm text-ink">
        You need an organization before you can create bids.{' '}
        <a className="underline underline-offset-4" href={UPGRADE_HASH}>
          Create an organization
        </a>
      </p>
    );
  }
  return (
    <BidsList
      bids={state.cards}
      creditsLeft={state.org.creditsLeft}
      creditsResetOn={state.org.creditsResetOn}
      onOpen={(id) => go(bidHash(id))}
      onCreate={() => go(NEW_BID_HASH)}
      onUpgrade={() => go(UPGRADE_HASH)}
    />
  );
}
