import type { BidCard } from './types';

export const SAMPLE_CREDITS_RESET_ON = '2026-11-01';

export const SAMPLE_BIDS: BidCard[] = [
  {
    id: 'bid-navwar',
    name: 'Navy IT modernization support',
    agency: 'NAVWAR',
    dueDate: '2026-10-16',
    daysLeft: 2,
    status: 'writing',
    creditUsed: true,
  },
  {
    id: 'bid-texas-dir',
    name: 'Texas DIR cloud services',
    agency: 'Texas Department of Information Resources',
    dueDate: '2026-10-14',
    daysLeft: 0,
    status: 'writing',
    creditUsed: true,
  },
  {
    id: 'bid-va-claims',
    name: 'VA claims processing BPA',
    agency: 'Department of Veterans Affairs',
    dueDate: '2026-11-06',
    daysLeft: 23,
    status: 'planning',
    creditUsed: true,
  },
  {
    id: 'bid-army-helpdesk',
    name: 'Army PEO EIS help desk',
    agency: 'U.S. Army',
    dueDate: '2026-10-10',
    daysLeft: -4,
    status: 'writing',
    creditUsed: true,
  },
  {
    id: 'bid-austin-311',
    name: 'City of Austin 311 platform',
    status: 'planning',
    creditUsed: false,
  },
  {
    id: 'bid-gsa-oasis',
    name: 'GSA OASIS+ on-ramp',
    agency: 'General Services Administration',
    dueDate: '2026-09-12',
    daysLeft: -32,
    status: 'submitted',
    creditUsed: true,
  },
  {
    id: 'bid-cisa-training',
    name: 'CISA cyber workforce training',
    agency: 'Department of Homeland Security',
    dueDate: '2026-06-30',
    daysLeft: -106,
    status: 'closed',
    creditUsed: true,
  },
];

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

// Sample files report a realistic size without allocating that much memory.
function sampleFile(name: string, megabytes: number): File {
  const extension = name.split('.').pop() as keyof typeof MIME;
  const file = new File([''], name, { type: MIME[extension], lastModified: 1760400000000 });
  Object.defineProperty(file, 'size', { value: Math.round(megabytes * 1024 * 1024) });
  return file;
}

export function sampleFilesWithinCap(): File[] {
  return [
    sampleFile('N00039-26-R-0042 RFP.pdf', 12.4),
    sampleFile('Attachment J-1 Statement of work.docx', 1.8),
    sampleFile('Attachment J-3 Pricing template.xlsx', 0.6),
  ];
}

/** Free plan, 50 MB cap: the third file goes over and is refused with 4.3 MB left. */
export function sampleFilesOverFreeCap(): File[] {
  return [
    sampleFile('TX-DIR-CPO-5821 Solicitation.pdf', 31.5),
    sampleFile('Exhibit B Technical requirements.docx', 14.2),
    sampleFile('Exhibit C Cost proposal workbook.xlsx', 9.8),
  ];
}
