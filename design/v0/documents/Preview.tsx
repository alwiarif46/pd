import { useState } from 'react'
import { DocumentsPanel } from './DocumentsPanel'
import { documentNotices, documentSamples, documentUploads } from './sample-data'

export function Preview() {
  const [noticeIds, setNoticeIds] = useState(documentNotices.map((notice) => notice.id))
  const [empty, setEmpty] = useState(false)
  const [member, setMember] = useState(false)
  const [overridesLeft, setOverridesLeft] = useState(2)
  const [amendmentNoAssumed, setAmendmentNoAssumed] = useState<number | null>(2)
  return <div className="min-h-screen bg-canvas p-4 md:p-8"><div className="mx-auto flex max-w-[1500px] flex-col gap-4"><div className="flex flex-wrap gap-2"><button className="rounded-md border border-line bg-paper px-3 py-2 text-sm" onClick={() => setEmpty((value) => !value)}>Toggle empty state</button><button className="rounded-md border border-line bg-paper px-3 py-2 text-sm" onClick={() => setMember((value) => !value)}>{member ? 'Show owner' : 'Show member'}</button><button className="rounded-md border border-line bg-paper px-3 py-2 text-sm" onClick={() => setOverridesLeft((value) => value === 2 ? 0 : 2)}>Toggle override count</button></div><DocumentsPanel docs={empty ? [] : documentSamples} usedBytes={47_000_000} capMb={50} plan="free" isOwner={!member} overridesLeft={overridesLeft} notices={documentNotices.filter((notice) => noticeIds.includes(notice.id))} uploads={documentUploads} amendmentNoAssumed={amendmentNoAssumed} amendmentNoFound={3} needsNumber={false} onSetAmendmentNo={(value) => setAmendmentNoAssumed(value)} onUpload={(files, kind, amendmentNo) => console.log('[v0] upload', files.length, kind, amendmentNo)} onDismissNotice={(id) => setNoticeIds((current) => current.filter((item) => item !== id))} onOpen={(id) => console.log('[v0] open', id)} onDelete={(id) => console.log('[v0] delete', id)} onRestore={(id) => console.log('[v0] restore', id)} onConfirmMarking={(id) => console.log('[v0] confirm marking', id)} onOverrideKey={(id, reason) => { console.log('[v0] override', id, reason); setOverridesLeft((value) => Math.max(0, value - 1)) }} onUpgrade={() => console.log('[v0] upgrade')} /></div></div>
}
