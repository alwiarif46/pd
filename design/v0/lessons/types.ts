export interface Lesson { id: string; question: string; answer: string; author: string | null; updatedAt: string }
export interface LessonsTabProps { lessons: Lesson[]; saveStatus: 'idle' | 'saving' | 'saved' | 'error'; onAnswer: (id: string, answer: string) => void; onAddQuestion: (question: string) => void; onDelete: (id: string) => void; onExport: () => void }
export const sampleLessons: Lesson[] = [
 { id:'l1', question:'What worked well in this bid?', answer:'', author:null, updatedAt:'2026-10-15T12:00:00Z' },
 { id:'l2', question:'What should we change next time?', answer:'', author:null, updatedAt:'2026-10-15T12:00:00Z' },
 { id:'l3', question:'What evaluator feedback should we carry forward?', answer:'', author:null, updatedAt:'2026-10-15T12:00:00Z' },
]
