import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as client from '@/api';
import type { BidFactDto, TabProposalDto } from '@/api';
import { SourceViewer } from '@/components/SourceViewer';
import { Workspace } from '@/screens/Workspace';
import type { ProposalApi, ProposalDecision } from '@/features/proposals/controller';
import { factProposals, proposalSource, type ProposalSourceRef } from '@/features/proposals/derive';
import { TabProposals } from '@/features/proposals/ui/TabProposals';
import { useProposalDecisions } from '@/features/proposals/useProposalDecisions';
import { useRequiredShell } from '@/features/shell/bid-context';
import { jobsKey } from '@/features/shell/controller';
import { LegacyFrame } from '@/features/shell/LegacyFrame';
import type { TabScreenProps } from '@/features/shell/registry';
import { tabHref } from '@/features/shell/routes';

/** The calls the Overview container makes; tests pass fakes. */
export interface OverviewApi extends ProposalApi {
  getTab: typeof client.getTab;
}

const overviewApi: OverviewApi = client;

interface Props extends TabScreenProps {
  /** Test seams: the typed client, and the legacy Overview screen. */
  api?: OverviewApi;
  Legacy?: typeof Workspace;
}

interface Loaded {
  bidId: string;
  facts: BidFactDto[];
  proposals: TabProposalDto<BidFactDto>[];
}

function go(hash: string) {
  window.location.hash = hash;
}

/**
 * The Overview tab until v0's Overview is integrated: the amendment proposals panel (Tailwind, outside
 * `.app-shell`) above the legacy Overview in a LegacyFrame. Not wrapped in TabFrameContainer: the legacy
 * screen draws its own processing, marking, failed and amendment banners.
 */
export function OverviewContainer({ bidId, api = overviewApi, Legacy = Workspace }: Props) {
  const shell = useRequiredShell();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [version, setVersion] = useState(0);
  /**
   * Per bid, counted only after an Insert or Dismiss, to reload the legacy screen (see refreshKey):
   * `decisions` all of them, `blind` those settled while the shell's job key was empty.
   */
  const [legacy, setLegacy] = useState<{ bidId: string; decisions: number; blind: number } | null>(null);
  const [sourceState, setSourceState] = useState<(ProposalSourceRef & { bidId: string }) | null>(null);
  const source = sourceState?.bidId === bidId ? sourceState : null;
  // The same key ShellContainer passes a legacy tab.
  const jobKey = jobsKey(shell.bidLoaded ? { jobs: shell.jobs } : null);

  useEffect(() => {
    const abort = new AbortController();
    api.getTab(bidId, 'overview', { signal: abort.signal }).then(
      (payload) => setLoaded({ bidId, facts: payload.facts, proposals: payload.proposals }),
      // An abort, or a failed load: keep what is shown (or no panel). The legacy screen reports its own errors.
      () => undefined,
    );
    return () => abort.abort();
  }, [api, bidId, version, jobKey]);

  const data = loaded?.bidId === bidId ? loaded : null;
  const proposals = useMemo(() => (data ? factProposals(data.proposals, data.facts) : []), [data]);

  // OPUS STEP: reload keys. A decision changes the facts the legacy screen shows, and it cannot see the
  // decision, so the key it reloads on gets a suffix after each one. Until the first decision the key is
  // exactly the shell's, so Workspace's skip-the-first-key rule behaves as it does on every legacy tab.
  // Workspace takes the first non-empty key after an empty one as describing its mount load, so no '#N'
  // is sent while the job key is empty: a decision settled then (no jobs, or the shell bid not loaded)
  // remounts the legacy screen instead, once the shell bid is loaded, which is one fresh load.
  // The legacy screen's own changes bump only `version` (this panel): Workspace already reloaded itself,
  // and bumping its key too would reload it twice. All of it is per bid, so a bid switch starts over.
  const counts = legacy?.bidId === bidId ? legacy : { decisions: 0, blind: 0 };
  const refreshKey = jobKey === '' ? '' : counts.decisions === 0 ? jobKey : `${jobKey}#${counts.decisions}`;
  const legacyKey = counts.blind > 0 && shell.bidLoaded ? `reload-${counts.blind}` : 'mount';
  const { busyIds, decide } = useProposalDecisions({
    api,
    // The hook calls the latest onSettled, so jobKey is the one in force when the decision settles.
    onSettled: () => {
      const blind = jobKey === '' ? 1 : 0;
      setLegacy((prev) => {
        const base = prev?.bidId === bidId ? prev : { bidId, decisions: 0, blind: 0 };
        return { bidId, decisions: base.decisions + 1, blind: base.blind + blind };
      });
      setVersion((n) => n + 1);
      shell.refresh();
    },
  });
  const onChanged = () => {
    setVersion((n) => n + 1);
    shell.refresh();
  };

  const onDecide = (id: string, decision: ProposalDecision) => {
    const p = proposals.find((x) => x.id === id);
    if (p) decide(p, decision);
  };

  const onOpenSource = (rowId: string) => {
    const ref = data ? proposalSource(data.proposals, data.facts, rowId) : null;
    if (!ref) {
      toast.info('No source page for this row.');
      return;
    }
    setSourceState({ ...ref, bidId });
  };

  return (
    <>
      {proposals.length > 0 && (
        <div className="p-6 pb-0">
          <TabProposals
            subject="facts"
            proposals={proposals}
            busyIds={busyIds}
            onInsert={(id) => onDecide(id, 'insert')}
            onDismiss={(id) => onDecide(id, 'dismiss')}
            onOpenSource={onOpenSource}
          />
        </div>
      )}
      <LegacyFrame>
        <Legacy
          key={legacyKey}
          embedded
          bidId={bidId}
          tab="overview"
          bids={[]}
          org={shell.org}
          onTab={(next) => go(tabHref(bidId, next))}
          onSwitch={(id) => go(tabHref(id, 'overview'))}
          onChanged={onChanged}
          refreshKey={refreshKey}
        />
      </LegacyFrame>
      {source && (
        <LegacyFrame>
          <SourceViewer
            documentId={source.documentId}
            page={source.page}
            pageEnd={source.pageEnd}
            quote={source.quote}
            onClose={() => setSourceState(null)}
          />
        </LegacyFrame>
      )}
    </>
  );
}
