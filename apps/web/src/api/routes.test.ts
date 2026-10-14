import { describe, expect, it } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { createBid, deleteBid, getBid, listBids, updateBid } from './bids';
import type { HttpMethod } from './http';
import {
  createOrg,
  getOrg,
  getProcessingInfo,
  inviteMember,
  listMembers,
  removeMember,
  updateOrg,
} from './org';
import { setToken } from './session';

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
