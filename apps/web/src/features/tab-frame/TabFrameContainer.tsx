import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Tab } from '@/types';
import { AmendmentConfirm } from '@/ui/common/AmendmentConfirm';
import { MarkingPrompt } from '@/ui/common/MarkingPrompt';
import { TabFrame } from '@/ui/common/TabFrame';
import { useRequiredShell } from '@/features/shell/bid-context';
import { tabHref } from '@/features/shell/routes';
import { decideLink, runAction, tabFrameApi, upgradeReasonFor, type ActionResult, type TabFrameApi } from './actions';
import { deriveTabFrame } from './derive';

interface Props {
  tab: Tab;
  title: string;
  /** The tab has AI-extracted rows: shows the draft notice when nothing is processing. */
  hasAiRows?: boolean;
  /** Draw the marking prompts of blocked files in the waiting slot (default). Documents turns it off: its panel draws one under each file. */
  markings?: boolean;
  children: ReactNode;
  /** Test seam; defaults to the typed client. */
  api?: TabFrameApi;
}

/**
 * Draws the 05 s4 states around a tab (v0's TabFrame) from the shell's bid state, and wires its actions:
 * retry, confirm or remove a marked file, confirm or reject amendment changes, upload, upgrade. Every
 * action waits for the server, then refreshes the shell.
 */
export function TabFrameContainer({ tab, title, hasAiRows = false, markings = true, children, api = tabFrameApi }: Props) {
  const shell = useRequiredShell();
  const [busy, setBusy] = useState<string[]>([]);
  const model = deriveTabFrame(
    {
      plan: shell.summary.plan,
      creditsLeft: shell.summary.creditsLeft,
      creditsResetOn: shell.summary.creditsResetOn,
      mbCap: shell.summary.mbCap,
      bid: shell.bid,
      docs: shell.docs,
      jobs: shell.jobs,
      links: shell.links,
    },
    tab,
    { hasAiRows },
  );

  async function run(id: string, call: () => Promise<ActionResult>) {
    setBusy((ids) => [...ids, id]);
    const result = await call();
    setBusy((ids) => ids.filter((x) => x !== id));
    if (!result.ok) toast.error(result.message);
    shell.refresh();
  }

  async function removeFile(documentId: string, fileName: string) {
    const ok = await shell.confirm({
      title: `Remove ${fileName}?`,
      body: 'The file is deleted from this bid. Rows it already produced stay.',
      confirmLabel: 'Remove file',
    });
    if (ok) await run(documentId, () => runAction(() => api.deleteDocument(documentId)));
  }

  const shownMarkings = markings ? model.markings : [];
  const waiting =
    shownMarkings.length > 0 || model.proposals.length > 0 ? (
      <div className="flex flex-col gap-4">
        {shownMarkings.map((request) => (
          <MarkingPrompt
            key={request.documentId}
            fileName={request.fileName}
            markings={request.markings}
            page={request.page}
            busy={busy.includes(request.documentId)}
            onConfirm={() => void run(request.documentId, () => runAction(() => api.confirmMarking(request.documentId)))}
            onRemoveFile={() => void removeFile(request.documentId, request.fileName)}
          />
        ))}
        {model.proposals.length > 0 ? (
          <AmendmentConfirm
            proposals={model.proposals}
            busyIds={busy}
            onConfirm={(id) => void run(id, () => decideLink(api, id, 'confirm'))}
            onReject={(id) => void run(id, () => decideLink(api, id, 'reject'))}
            onOpenSource={(rowId) => shell.openRow(rowId)}
          />
        ) : null}
      </div>
    ) : null;

  const retryJobId = model.retryJobId;
  return (
    <TabFrame
      tab={tab}
      title={title}
      plan={shell.summary.plan}
      block={model.block}
      processing={model.processing}
      waiting={waiting}
      overCap={model.overCap}
      draftNotice={model.draftNotice}
      onUploadSolicitation={() => {
        if (shell.bidId) window.location.hash = tabHref(shell.bidId, 'documents');
      }}
      onRetry={() => {
        if (retryJobId) void run(retryJobId, () => runAction(() => api.retryJob(retryJobId)));
      }}
      onUpgrade={() => shell.openUpgrade(upgradeReasonFor(model.block, model.overCap !== null))}
    >
      {children}
    </TabFrame>
  );
}
