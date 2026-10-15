import type { AmendmentMark } from '@/types'

export type OralsCategory = 'rules' | 'prep' | 'session'
export interface OralsItem { id: string; category: OralsCategory; item: string; owner: string | null; minutes: number | null; done: boolean; origin: 'ai' | 'user' | 'standard'; sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark }
export interface OralsTabProps { items: OralsItem[]; selectedRowId: string | null; onToggle: (id: string, done: boolean) => void; onEdit: (id: string, edit: { item?: string; owner?: string | null; minutes?: number | null }) => void; onAdd: (category: OralsCategory, item: string) => void; onDelete: (id: string) => void; onOpenRow: (id: string) => void; onOpenSource: (id: string) => void }
export const categoryLabel: Record<OralsCategory,string> = { rules: 'Orals rules', prep: 'Preparation checklist', session: 'Session plan' }
export const sampleItems: OralsItem[] = [
 { id:'o1', category:'rules', item:'The oral presentation may not exceed 30 minutes.', owner:null, minutes:null, done:false, origin:'ai', sourcePage:22, sourcePageEnd:null, sourceQuote:'Oral presentation time limit', amendment:{kind:'original'} },
 { id:'o2', category:'prep', item:'Confirm presenter roles and rehearsal schedule.', owner:'Dana Reyes', minutes:null, done:false, origin:'standard', sourcePage:null, sourcePageEnd:null, sourceQuote:null, amendment:{kind:'original'} },
 { id:'o3', category:'session', item:'Technical approach and transition', owner:'Marcus Lee', minutes:12, done:false, origin:'user', sourcePage:null, sourcePageEnd:null, sourceQuote:null, amendment:{kind:'original'} },
]
