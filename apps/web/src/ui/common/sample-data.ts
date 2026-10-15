import type { AmendmentProposal, ProcessingState } from './types';

export const SAMPLE_PROCESSING: ProcessingState = {
  steps: [
    { id: 'virus', label: 'Virus scan', status: 'done', percent: 100 },
    { id: 'read', label: 'Read the file', status: 'running', percent: 62 },
    { id: 'marking', label: 'Marking check', status: 'waiting', percent: 0 },
    { id: 'classify', label: 'Classify pages', status: 'waiting', percent: 0 },
  ],
  queuePosition: 3,
  etaSeconds: 120,
};

export const SAMPLE_AMENDMENTS: AmendmentProposal[] = [
  {
    id: 'proposal-replaces',
    amendmentNo: 2,
    action: 'supersede',
    confidence: 0.62,
    oldRow: {
      rowId: 'row-old',
      label: 'C.3.2',
      text: 'Provide help desk support during business hours.',
      sourcePage: 12,
    },
    newRow: { rowId: 'row-new', label: 'C.3.2', text: 'Provide help desk support 24 hours a day.', sourcePage: 3 },
  },
  {
    id: 'proposal-withdraws',
    amendmentNo: 2,
    action: 'withdraw',
    confidence: null,
    oldRow: { rowId: 'row-withdrawn', label: 'L.7', text: 'Submit three printed copies.', sourcePage: 18 },
    newRow: null,
  },
  {
    id: 'proposal-adds',
    amendmentNo: 3,
    action: 'add',
    confidence: 0.91,
    oldRow: null,
    newRow: {
      rowId: 'row-added',
      label: 'L.9.1',
      text: 'Include a small-business subcontracting plan.',
      sourcePage: 6,
    },
  },
];

export const SAMPLE_MARKINGS = ['FOUO', 'Controlled Unclassified Information'];

export const SAMPLE_TABS = [
  'overview',
  'compliance',
  'outline',
  'resumes',
  'reviews',
  'production',
  'orals',
  'lessons',
] as const;
