import type { ShellBid } from './types';

export const sampleBids = [
  { id: 'va-ehr', name: 'VA EHR Support Services' },
  { id: 'austin-fleet', name: 'City of Austin Fleet Telematics' },
  { id: 'navsea-logistics', name: 'NAVSEA Logistics Support' },
];

export const sampleBid: ShellBid = {
  id: 'va-ehr',
  name: 'VA EHR Support Services',
  agency: 'Department of Veterans Affairs',
  dueDate: '2026-11-03',
  dueTime: '14:00',
  timeZone: 'America/New_York',
};

export const sampleUser = { name: 'Dana Reyes', email: 'dana.reyes@northbridge-gov.com' };
