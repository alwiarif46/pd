import type { BidType, FormStatus, Plan } from '../common/types'
export interface BidSettingsValues { name: string; agency: string; bidType: BidType; solicitationNumber: string; startDate: string | null; dueDate: string | null; dueTime: string | null; timeZone: string; oralsEnabled: boolean; keepFilesLiveUntil: string | null }
export interface BidSettingsProps { bid: BidSettingsValues; plan: Plan; isOwner: boolean; filesLiveUntil: string | null; creditStatus: 'reserved' | 'consumed' | 'none'; saveStatus: FormStatus; deleteStatus: FormStatus; onSave: (v: BidSettingsValues) => void; onDeleteBid: () => void }
export interface DateChangePromptProps { open: boolean; previousDue: string; nextDue: string; onChoose: (mode: 'shift' | 'scale' | 'keep') => void; onCancel: () => void }
export type { BidType, FormStatus, Plan }
