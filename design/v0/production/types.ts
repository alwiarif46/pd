import type { AmendmentMark } from '@/types'

export type ProductionCategory = 'format' | 'files' | 'submission' | 'copies' | 'other'
export interface ProductionItem { id: string; category: ProductionCategory; rule: string; owner: string | null; done: boolean; origin: 'ai' | 'user' | 'standard'; sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; amendment: AmendmentMark }
export interface ProductionTabProps { items: ProductionItem[]; selectedRowId: string | null; onToggle: (id: string, done: boolean) => void; onEdit: (id: string, edit: { rule?: string; owner?: string | null }) => void; onAdd: (category: ProductionCategory, rule: string) => void; onDelete: (id: string) => void; onOpenRow: (id: string) => void; onOpenSource: (id: string) => void }
export const categoryLabel: Record<ProductionCategory,string> = { format: 'Format', files: 'Files', submission: 'Submission', copies: 'Copies', other: 'Other' }
export const sampleItems: ProductionItem[] = [
 { id:'p1', category:'format', rule:'Use 12-point Arial with one-inch margins.', owner:'Dana Reyes', done:true, origin:'ai', sourcePage:12, sourcePageEnd:null, sourceQuote:'Formatting instructions', amendment:{kind:'original'} },
 { id:'p2', category:'files', rule:'Submit one searchable PDF and one editable DOCX.', owner:null, done:false, origin:'standard', sourcePage:null, sourcePageEnd:null, sourceQuote:null, amendment:{kind:'original'} },
 { id:'p3', category:'submission', rule:'Upload the final package to the designated portal by 2:00 PM ET.', owner:'Marcus Lee', done:false, origin:'ai', sourcePage:18, sourcePageEnd:null, sourceQuote:'Electronic submission', amendment:{kind:'original'} },
]
