import { describe, expect, it } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { confirmAmendmentLink, listAmendmentLinks, rejectAmendmentLink } from './amendments';
import { createBid, deleteBid, getBid, listBids, updateBid } from './bids';
import {
  addComplianceRow,
  deleteComplianceRow,
  listComplianceRows,
  mergeComplianceRows,
  splitComplianceRow,
  updateComplianceRow,
} from './compliance';
import {
  confirmMarking,
  deleteDocument,
  getDocumentFile,
  getDocumentPages,
  getViewToken,
  listDocuments,
  overrideSolicitationKey,
  resolveViewToken,
  restoreDocument,
  setAmendmentNo,
} from './documents';
import type { HttpMethod } from './http';
import { listJobs, retryJob } from './jobs';
import {
  createOrg,
  getOrg,
  getProcessingInfo,
  inviteMember,
  listMembers,
  removeMember,
  updateOrg,
} from './org';
import { deleteRow, getRow, updateRow } from './rows';
import { adjustSchedule } from './schedule';
import { setToken } from './session';
import { createTabRow, getTab, seedTab } from './tabs';

type RouteCase = [name: string, call: () => Promise<unknown>, method: HttpMethod, path: string, body: unknown];

const cases: RouteCase[] = [
  // org.ts
  ['createOrg', () => createOrg('Acme'), 'POST', '/api/org', { name: 'Acme' }],
  ['getOrg', () => getOrg(), 'GET', '/api/org', undefined],
  ['updateOrg', () => updateOrg('Acme 2'), 'PATCH', '/api/org', { name: 'Acme 2' }],
  ['listMembers', () => listMembers(), 'GET', '/api/org/members', undefined],
  ['inviteMember', () => inviteMember('b@acme.com'), 'POST', '/api/org/invites', { email: 'b@acme.com' }],
  ['removeMember', () => removeMember('u/1'), 'DELETE', '/api/org/members/u%2F1', undefined],
  ['getProcessingInfo', () => getProcessingInfo(), 'GET', '/api/about/processing', undefined],
  // bids.ts
  ['listBids', () => listBids(), 'GET', '/api/bids', undefined],
  [
    'createBid',
    () => createBid({ name: 'Bid', bidType: 'federal', solicitationNumber: 'W1' }),
    'POST',
    '/api/bids',
    { name: 'Bid', bidType: 'federal', solicitationNumber: 'W1' },
  ],
  ['getBid', () => getBid('b1'), 'GET', '/api/bids/b1', undefined],
  ['updateBid', () => updateBid('b1', { dueDate: null, oralsEnabled: true }), 'PATCH', '/api/bids/b1', { dueDate: null, oralsEnabled: true }],
  ['deleteBid', () => deleteBid('b1'), 'DELETE', '/api/bids/b1', undefined],
  // documents.ts
  ['listDocuments', () => listDocuments('b1'), 'GET', '/api/bids/b1/documents', undefined],
  ['getViewToken', () => getViewToken('d1'), 'GET', '/api/documents/d1/view-token', undefined],
  ['resolveViewToken', () => resolveViewToken('t/1'), 'GET', '/api/documents/view/t%2F1', undefined],
  ['getDocumentPages', () => getDocumentPages('d1', { from: 2, to: 5 }), 'GET', '/api/documents/d1/pages?from=2&to=5', undefined],
  ['getDocumentPages (from only)', () => getDocumentPages('d1', { from: 3 }), 'GET', '/api/documents/d1/pages?from=3', undefined],
  ['getDocumentFile', () => getDocumentFile('d1'), 'GET', '/api/documents/d1/file', undefined],
  ['confirmMarking', () => confirmMarking('d1'), 'POST', '/api/documents/d1/confirm-marking', undefined],
  [
    'overrideSolicitationKey',
    () => overrideSolicitationKey('d1', 'Typo in the number'),
    'POST',
    '/api/documents/d1/key-override',
    { reason: 'Typo in the number' },
  ],
  ['restoreDocument', () => restoreDocument('d1'), 'POST', '/api/documents/d1/restore', undefined],
  ['setAmendmentNo', () => setAmendmentNo('d1', 3), 'PATCH', '/api/documents/d1/amendment-no', { amendmentNo: 3 }],
  ['deleteDocument', () => deleteDocument('d1'), 'DELETE', '/api/documents/d1', undefined],
  // jobs.ts
  ['listJobs', () => listJobs('b1'), 'GET', '/api/bids/b1/jobs', undefined],
  ['retryJob', () => retryJob('j1'), 'POST', '/api/jobs/j1/retry', undefined],
  // amendments.ts
  ['listAmendmentLinks', () => listAmendmentLinks('b1'), 'GET', '/api/bids/b1/amendment-links', undefined],
  ['confirmAmendmentLink', () => confirmAmendmentLink('l1'), 'POST', '/api/amendment-links/l1/confirm', undefined],
  ['rejectAmendmentLink', () => rejectAmendmentLink('l1'), 'POST', '/api/amendment-links/l1/reject', undefined],
  // tabs.ts
  ['getTab', () => getTab('b1', 'schedule'), 'GET', '/api/bids/b1/tabs/schedule', undefined],
  [
    'createTabRow',
    () => createTabRow('b1', 'overview', { kind: 'fact', field: 'Agency', value: 'GSA' }),
    'POST',
    '/api/bids/b1/tabs/overview/rows',
    { kind: 'fact', field: 'Agency', value: 'GSA' },
  ],
  ['seedTab (overview sends {})', () => seedTab('b1', 'overview'), 'POST', '/api/bids/b1/tabs/overview/seed', {}],
  [
    'seedTab (schedule sends the template)',
    () => seedTab('b1', 'schedule', { template: 'color-reviews' }),
    'POST',
    '/api/bids/b1/tabs/schedule/seed',
    { template: 'color-reviews' },
  ],
  ['seedTab (schedule, no template)', () => seedTab('b1', 'schedule'), 'POST', '/api/bids/b1/tabs/schedule/seed', {}],
  // rows.ts
  ['getRow', () => getRow('b1', 'bid_facts', 'r1'), 'GET', '/api/bids/b1/rows/bid_facts/r1', undefined],
  [
    'updateRow wraps fields',
    () => updateRow('b1', 'kickoff_items', 'r1', { done: true, owner: null }),
    'PATCH',
    '/api/bids/b1/rows/kickoff_items/r1',
    { fields: { done: true, owner: null } },
  ],
  ['deleteRow', () => deleteRow('b1', 'lessons', 'r1'), 'DELETE', '/api/bids/b1/rows/lessons/r1', undefined],
  // compliance.ts
  ['listComplianceRows', () => listComplianceRows('b1'), 'GET', '/api/bids/b1/tabs/compliance', undefined],
  [
    'addComplianceRow',
    () => addComplianceRow('b1', { requirementText: 'The offeror shall...', reqType: 'shall' }),
    'POST',
    '/api/bids/b1/tabs/compliance/rows',
    { requirementText: 'The offeror shall...', reqType: 'shall' },
  ],
  [
    'updateComplianceRow',
    () => updateComplianceRow('b1', 'r1', { owner: 'Ann', status: 'done' }),
    'PATCH',
    '/api/bids/b1/rows/compliance_rows/r1',
    { fields: { owner: 'Ann', status: 'done' } },
  ],
  ['deleteComplianceRow', () => deleteComplianceRow('b1', 'r1'), 'DELETE', '/api/bids/b1/rows/compliance_rows/r1', undefined],
  [
    'mergeComplianceRows',
    () => mergeComplianceRows('b1', ['r1', 'r2']),
    'POST',
    '/api/bids/b1/compliance/merge',
    { ids: ['r1', 'r2'] },
  ],
  [
    'splitComplianceRow',
    () => splitComplianceRow('b1', 'r1', 12),
    'POST',
    '/api/bids/b1/compliance/split',
    { rowId: 'r1', at: 12 },
  ],
  // schedule.ts
  [
    'adjustSchedule',
    () => adjustSchedule('b1', { mode: 'shift', previousDue: '2026-11-01', nextDue: '2026-11-08' }),
    'POST',
    '/api/bids/b1/schedule/adjust',
    { mode: 'shift', previousDue: '2026-11-01', nextDue: '2026-11-08' },
  ],
];

describe('resource routes', () => {
  it.each(cases)('%s', async (_name, call, method, path, body) => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const recorded = lastCall(fetchMock);
    expect(recorded.method).toBe(method);
    expect(recorded.url).toBe(path);
    expect(recorded.headers.get('Authorization')).toBe('Bearer tok');
    expect(recorded.headers.has('X-Org-Id')).toBe(false);
    if (body === undefined) {
      expect(recorded.body).toBeUndefined();
      expect(recorded.headers.has('Content-Type')).toBe(false);
    } else {
      expect(recorded.headers.get('Content-Type')).toBe('application/json');
      expect(jsonBody(recorded)).toEqual(body);
    }
  });

  it('forwards the signal', async () => {
    const fetchMock = mockFetch(jsonResponse(200, []));
    const controller = new AbortController();
    await listBids({ signal: controller.signal });
    expect(lastCall(fetchMock).signal).toBe(controller.signal);
  });
});
