'use client';

import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface Lesson { id: string; text: string; source: string; bidId: string | null; tags: string[]; status: 'draft' | 'approved' }
export interface LessonsTabProps { lessons: Lesson[]; onAdd: (lesson: { text: string; source: string; tags: string[] }) => void; onEdit: (id: string, edit: Partial<Lesson>) => void; onDelete: (id: string) => void }
export function LessonsTab({ lessons, onAdd, onEdit }: LessonsTabProps) { return <main className="flex w-full flex-col gap-5 font-sans text-ink"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lessons learned</p><h1 className="text-2xl font-semibold">Make the next bid sharper</h1><p className="text-sm text-muted-foreground">Capture reusable insights without exposing another bid’s confidential content.</p></div><Button onClick={() => onAdd({ text: 'New lesson', source: 'Team review', tags: [] })}><Plus className="size-4" /> Add lesson</Button></div><div className="grid gap-3 md:grid-cols-2">{lessons.map((lesson) => <article key={lesson.id} className="rounded-md border border-line bg-paper p-4"><div className="flex items-start justify-between gap-3"><p className="leading-6">{lesson.text}</p><Badge variant={lesson.status === 'approved' ? 'secondary' : 'outline'}>{lesson.status}</Badge></div><p className="mt-3 text-xs text-muted-foreground">Source: {lesson.source}</p><div className="mt-3 flex flex-wrap gap-2">{lesson.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div><Button className="mt-4" size="sm" variant="ghost" onClick={() => onEdit(lesson.id, { status: lesson.status === 'approved' ? 'draft' : 'approved' })}>{lesson.status === 'approved' ? 'Move to draft' : 'Approve lesson'}</Button></article>)}</div></main>; }
export default LessonsTab;
