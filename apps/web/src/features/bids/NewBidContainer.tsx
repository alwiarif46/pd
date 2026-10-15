import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAbortError } from '@/api';
import { Button } from '@/components/ui/button';
import type { FormStatus } from '@/types';
import { NewBid } from '@/ui/bids/NewBid';
import {
  bidsApi,
  createBidAction,
  loadNewBidScreen,
  messageOf,
  type BidsApi,
  type NewBidScreenData,
} from './controller';
import { stashUploadNotices } from './notices';
import { bidDocumentsHash, BIDS_HASH, UPGRADE_HASH } from './routes';
import { useUpgrade } from './use-upgrade';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | NewBidScreenData;

interface Props {
  /** Test seam; defaults to the typed client. */
  api?: BidsApi;
}

function go(hash: string) {
  window.location.hash = hash;
}

/**
 * Creates the bid, uploads its files, and opens the bid's documents. v0's NewBid has no `status` prop yet
 * (follow-up), so while this runs the form is not disabled; a ref blocks a second submit, and progress and
 * refusals show as toasts.
 */
export function NewBidContainer({ api = bidsApi }: Props) {
  const upgrade = useUpgrade();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<FormStatus>({ state: 'idle' });
  const busy = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    loadNewBidScreen(api, new Date(), abort.signal).then(setState, (error: unknown) => {
      if (!isAbortError(error)) setState({ kind: 'error', message: messageOf(error) });
    });
    return () => abort.abort();
  }, [api, attempt]);

  if (state.kind === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading...
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

  const { org } = state;

  function create(name: string, bidType: 'federal' | 'sled', files: File[]) {
    if (busy.current) return;
    busy.current = true;
    setStatus({ state: 'submitting' });
    const toastId = toast.loading('Creating bid...');
    void createBidAction(api, { name, bidType, files }, ({ index, total, fileName }) => {
      toast.loading(`Uploading file ${index + 1} of ${total}: ${fileName}`, { id: toastId });
    }).then((result) => {
      if (!result.ok) {
        busy.current = false;
        setStatus({ state: 'error', message: result.message });
        toast.error(result.message, { id: toastId });
        return;
      }
      toast.dismiss(toastId);
      stashUploadNotices(result.bidId, result.notices);
      for (const notice of result.notices) {
        const text = `${notice.fileName}: ${notice.message}`;
        if (notice.tone === 'error') toast.error(text);
        else toast.info(text);
      }
      setStatus({ state: 'done', message: '' });
      go(bidDocumentsHash(result.bidId));
    });
  }

  return (
    <NewBid
      creditsLeft={org.creditsLeft}
      creditsResetOn={org.creditsResetOn}
      plan={org.plan}
      mbCap={org.mbCap}
      status={status}
      onCreate={create}
      onCancel={() => go(BIDS_HASH)}
      onUpgrade={() => upgrade(org.creditsLeft)}
    />
  );
}
