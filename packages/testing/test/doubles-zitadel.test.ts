import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceKey,
  JWT_BEARER_GRANT,
  signZitadelEvent,
  startMockOidc,
  startMockZitadel,
  verifyZitadelEvent,
  type MockOidc,
  type MockZitadel,
} from '../src/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read by path
type Json = Record<string, any>;

let oidc: MockOidc;
let z: MockZitadel;
let bearer: string;

beforeAll(async () => {
  oidc = await startMockOidc();
  const key = createServiceKey('identity-sa');
  oidc.registerServiceKey(key.userId, key.publicJwk);
  const res = await fetch(`${oidc.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: await key.assertion(oidc.issuer), scope: 'openid' }),
  });
  bearer = ((await res.json()) as { access_token: string }).access_token;
  z = await startMockZitadel({ oidc });
});
afterAll(async () => {
  await z.close();
  await oidc.close();
});
beforeEach(() => z.reset());

async function call(method: string, path: string, body?: unknown, token: string | null = bearer): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${z.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

describe('mock Zitadel, auth', () => {
  it('refuses calls with no token, a junk token, or a token from another issuer', async () => {
    expect((await call('GET', '/v2/users/u1', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v2/users/u1', undefined, 'junk')).status).toBe(401);
    const other = await startMockOidc();
    try {
      const key = createServiceKey('sa');
      other.registerServiceKey('sa', key.publicJwk);
      const res = await fetch(`${other.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: await key.assertion(other.issuer) }) });
      const foreign = ((await res.json()) as { access_token: string }).access_token;
      expect((await call('GET', '/v2/users/u1', undefined, foreign)).status).toBe(401);
    } finally {
      await other.close();
    }
    expect(z.calls.map((c) => c.status)).toEqual([401, 401, 401]);
  });

  it('records the caller subject on accepted calls', async () => {
    z.addUser({ id: 'u1' });
    expect((await call('GET', '/v2/users/u1')).status).toBe(200);
    expect(z.calls[0]).toMatchObject({ method: 'GET', path: '/v2/users/u1', status: 200, subject: 'identity-sa' });
  });

  it('needs an issuer unless auth is off', async () => {
    await expect(startMockZitadel()).rejects.toThrow(/oidc/);
    const open = await startMockZitadel({ requireAuth: false });
    try {
      const res = await fetch(`${open.url}/v2/organizations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
      expect(res.status).toBe(201);
    } finally {
      await open.close();
    }
  });
});

describe('mock Zitadel, organizations and users', () => {
  it('creates an organization with the given id and refuses a duplicate with 409', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first = await call('POST', '/v2/organizations', { name: 'Acme', organization_id: id });
    expect(first.status).toBe(201);
    expect(first.body.organization_id).toBe(id);
    expect(z.orgs.get(id)).toEqual({ id, name: 'Acme' });
    const dup = await call('POST', '/v2/organizations', { name: 'Acme again', organization_id: id });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe(6);
    expect(z.orgs.size).toBe(1);
  });

  it('makes an id when none is given and checks the name', async () => {
    const made = await call('POST', '/v2/organizations', { name: 'No id' });
    expect(made.status).toBe(201);
    expect(z.orgs.has(made.body.organization_id)).toBe(true);
    expect((await call('POST', '/v2/organizations', {})).status).toBe(400);
  });

  it('gets, deactivates and reactivates a user', async () => {
    z.addUser({ id: 'u1', orgId: 'org1', email: 'a@acme.test', emailVerified: false });
    const got = await call('GET', '/v2/users/u1');
    expect(got.body.user).toMatchObject({ userId: 'u1', state: 'USER_STATE_ACTIVE', details: { resourceOwner: 'org1' }, human: { email: { email: 'a@acme.test', isVerified: false } } });
    expect((await call('POST', '/v2/users/u1/deactivate', {})).status).toBe(200);
    expect((await call('GET', '/v2/users/u1')).body.user.state).toBe('USER_STATE_INACTIVE');
    expect((await call('POST', '/v2/users/u1/reactivate', {})).status).toBe(200);
    expect(z.users.get('u1')?.state).toBe('active');
    expect((await call('GET', '/v2/users/nope')).status).toBe(404);
    expect((await call('POST', '/v2/users/nope/deactivate', {})).status).toBe(404);
  });
});

describe('mock Zitadel, bootstrap endpoints', () => {
  it('creates a project and an OIDC app, finds them by search, and refuses duplicates', async () => {
    const p = await call('POST', '/management/v1/projects', { name: 'e2e' });
    expect(p.status).toBe(200);
    expect((await call('POST', '/management/v1/projects', { name: 'e2e' })).status).toBe(409);
    const found = await call('POST', '/management/v1/projects/_search', { queries: [{ nameQuery: { name: 'e2e', method: 'TEXT_QUERY_METHOD_EQUALS' } }] });
    expect(found.body.result).toEqual([{ id: p.body.id, name: 'e2e' }]);

    const app = await call('POST', `/management/v1/projects/${p.body.id}/apps/oidc`, { name: 'web', responseTypes: ['OIDC_RESPONSE_TYPE_CODE'], authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE' });
    expect(app.status).toBe(200);
    expect(app.body.clientId).toMatch(/@e2e$/);
    expect(z.apps.get(app.body.appId)?.body.authMethodType).toBe('OIDC_AUTH_METHOD_TYPE_NONE');
    expect((await call('POST', `/management/v1/projects/${p.body.id}/apps/oidc`, { name: 'web' })).status).toBe(409);
    expect((await call('POST', '/management/v1/projects/ghost/apps/oidc', { name: 'web' })).status).toBe(404);
    const apps = await call('POST', `/management/v1/projects/${p.body.id}/apps/_search`, {});
    expect(apps.body.result).toHaveLength(1);
  });

  it('stores the login policy and the factor lists, and refuses a repeated factor', async () => {
    expect((await call('PUT', '/admin/v1/policies/login', { forceMfa: true, allowUsernamePassword: true })).status).toBe(200);
    expect(z.loginPolicy).toMatchObject({ forceMfa: true });
    expect((await call('POST', '/admin/v1/policies/login/second_factors', { type: 'SECOND_FACTOR_TYPE_OTP' })).status).toBe(200);
    expect((await call('POST', '/admin/v1/policies/login/second_factors', { type: 'SECOND_FACTOR_TYPE_OTP' })).status).toBe(409);
    expect((await call('POST', '/admin/v1/policies/login/multi_factors', { type: 'MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION' })).status).toBe(200);
    expect(z.secondFactors).toEqual(['SECOND_FACTOR_TYPE_OTP']);
    expect(z.multiFactors).toEqual(['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION']);
  });

  it('adds Google and Azure IdPs and attaches them to the login policy', async () => {
    const g = await call('POST', '/admin/v1/idps/google', { name: 'Google', clientId: 'gid' });
    const a = await call('POST', '/admin/v1/idps/azure', { name: 'Microsoft', clientId: 'mid' });
    expect([...z.idps.values()].map((i) => i.kind).sort()).toEqual(['azure', 'google']);
    expect((await call('POST', '/admin/v1/policies/login/idps', { idpId: g.body.id, ownerType: 'IDP_OWNER_TYPE_SYSTEM' })).status).toBe(200);
    expect((await call('POST', '/admin/v1/policies/login/idps', { idpId: a.body.id })).status).toBe(200);
    expect((await call('POST', '/admin/v1/policies/login/idps', { idpId: a.body.id })).status).toBe(409);
    expect((await call('POST', '/admin/v1/policies/login/idps', { idpId: 'ghost' })).status).toBe(404);
    expect(z.loginIdps).toEqual([g.body.id, a.body.id]);
  });

  it('creates an action target with a signing key and sets an execution on it', async () => {
    const t = await call('POST', '/v2/actions/targets', { name: 'identity-events', restWebhook: { interruptOnError: false }, endpoint: 'http://identity/internal/zitadel/events' });
    expect(t.status).toBe(201);
    expect(t.body.signingKey).toBe(z.targets.get(t.body.id)?.signingKey);
    const ex = await call('PUT', '/v2/actions/executions', { condition: { event: { group: 'user' } }, targets: [t.body.id] });
    expect(ex.status).toBe(200);
    expect(z.executions.size).toBe(1);
    expect((await call('PUT', '/v2/actions/executions', { condition: { event: { group: 'user' } }, targets: ['ghost'] })).status).toBe(400);
  });

  it('answers 404 for an unknown path', async () => {
    expect((await call('GET', '/nothing')).status).toBe(404);
  });
});

describe('mock Zitadel, failure injection', () => {
  it('fails a path with 5xx a set number of times, then recovers', async () => {
    z.injectFailure({ method: 'POST', path: '/v2/organizations', status: 502, times: 2 });
    const body = { name: 'Acme', organization_id: 'o1' };
    expect((await call('POST', '/v2/organizations', body)).status).toBe(502);
    expect((await call('POST', '/v2/organizations', body)).status).toBe(502);
    expect(z.orgs.size).toBe(0);
    expect((await call('POST', '/v2/organizations', body)).status).toBe(201);
    expect(z.calls.map((c) => c.status)).toEqual([502, 502, 201]);
  });

  it('matches a prefix with a trailing star, defaults to 503 and clears', async () => {
    z.addUser({ id: 'u1' });
    z.injectFailure({ path: '/v2/users/*' });
    expect((await call('GET', '/v2/users/u1')).status).toBe(503);
    expect((await call('POST', '/v2/users/u1/deactivate', {})).status).toBe(503);
    expect(z.users.get('u1')?.state).toBe('active');
    expect((await call('POST', '/v2/organizations', { name: 'x' })).status).toBe(201);
    z.clearFailures();
    expect((await call('GET', '/v2/users/u1')).status).toBe(200);
  });
});

describe('Zitadel event signatures', () => {
  const body = JSON.stringify({ aggregateID: 'u1', eventType: 'user.human.added' });

  it('signs as t=<unix>,v1=<hex> and verifies', () => {
    const header = signZitadelEvent(body, 'key-1', 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyZitadelEvent(body, header, 'key-1', { now: 1_700_000_100 })).toBe(true);
  });

  it('rejects a changed body, a wrong key, a stale timestamp and a malformed header', () => {
    const header = signZitadelEvent(body, 'key-1', 1_700_000_000);
    expect(verifyZitadelEvent(`${body} `, header, 'key-1', { now: 1_700_000_000 })).toBe(false);
    expect(verifyZitadelEvent(body, header, 'key-2', { now: 1_700_000_000 })).toBe(false);
    expect(verifyZitadelEvent(body, header, 'key-1', { now: 1_700_000_000 + 301 })).toBe(false);
    expect(verifyZitadelEvent(body, header, 'key-1', { now: 1_700_000_000 + 301, toleranceSeconds: 600 })).toBe(true);
    expect(verifyZitadelEvent(body, undefined, 'key-1')).toBe(false);
    expect(verifyZitadelEvent(body, 'v1=abc', 'key-1')).toBe(false);
    expect(verifyZitadelEvent(body, 't=1700000000,v1=zz', 'key-1', { now: 1_700_000_000 })).toBe(false);
    expect(verifyZitadelEvent(body, 't=1700000000,v1=ab', 'key-1', { now: 1_700_000_000 })).toBe(false);
  });

  it('uses the clock by default', () => {
    expect(verifyZitadelEvent(body, signZitadelEvent(body, 'k'), 'k')).toBe(true);
  });

  it('verifies with the key a target returned', async () => {
    const t = await call('POST', '/v2/actions/targets', { name: 'events' });
    expect(verifyZitadelEvent(body, signZitadelEvent(body, t.body.signingKey), t.body.signingKey)).toBe(true);
  });
});
