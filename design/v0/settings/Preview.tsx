import { useState } from 'react'
import { BidSettings } from './BidSettings'
import { settingsSample } from './sample-data'
export function Preview() { const [bid,setBid]=useState(settingsSample); return <main className="min-h-screen bg-canvas p-4 md:p-8"><div className="mx-auto max-w-5xl"><BidSettings bid={bid} plan="starter" isOwner filesLiveUntil="2027-02-01" creditStatus="reserved" saveStatus="idle" deleteStatus="idle" onSave={setBid} onDeleteBid={()=>console.log('[v0] delete bid')} /></div></main> }
