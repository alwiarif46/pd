import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { TabProposal } from '@/types';
import { decideProposal, type ProposalApi, type ProposalDecision } from './controller';

/**
 * Sends Insert and Dismiss for a tab's proposals, one decision per proposal at a time.
 * OPUS STEP: double-click guard. The ref is checked and set in the click handler before any await, so a
 * second click (or Dismiss right after Insert) on the same proposal is dropped even before React redraws
 * the disabled buttons; `busyIds` only draws it. After every outcome `onSettled` runs (the caller reloads
 * the tab and refreshes the shell), so a refused decision shows the tab as the server has it.
 */
export function useProposalDecisions(opts: { api: ProposalApi; onSettled: () => void }): {
  busyIds: readonly string[];
  decide: (p: TabProposal, decision: ProposalDecision) => void;
} {
  const busyRef = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);
  const { api, onSettled } = opts;
  // The latest onSettled runs when a decision settles, so it sees the state of that moment (the shell's
  // job key for Overview), not the state of the click.
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  });

  const decide = (p: TabProposal, decision: ProposalDecision) => {
    const id = p.id;
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds((ids) => [...ids, id]);
    void decideProposal(api, p, decision)
      .then((outcome) => {
        if (outcome.kind === 'done') toast.success(outcome.message);
        else toast.error(outcome.message);
      })
      .finally(() => {
        busyRef.current.delete(id);
        setBusyIds((ids) => ids.filter((x) => x !== id));
        settledRef.current();
      });
  };

  return { busyIds, decide };
}
