// Lessons learned: docs/plans/09-ui-workflow.md section 5.10.
import type { FormStatus } from './shared';

export interface Lesson {
  id: string;
  question: string;
  answer: string;
  author: string | null;
  updatedAt: string;
}
export interface LessonsTabProps {
  lessons: Lesson[];
  saveStatus: FormStatus;
  onAnswer: (id: string, answer: string) => void;
  onAddQuestion: (question: string) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
}
