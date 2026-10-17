import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createServiceKey,
  FREE_MAIL_USER,
  JWT_BEARER_GRANT,
  ORG_CLAIM,
  RESOURCE_OWNER_CLAIM,
  startMockOidc,
  TENANT_A,
  TENANT_B,
  UNVERIFIED_USER,
  type MockOidc,
} from '../src/index';

// Zitadel-shaped behaviors of the mock issuer (chat 2 identity design, "Mock must add").
const REDIRECT = 'http://localhost:3000/callback';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let oidc: MockOidc;
beforeAll(async () => {
  oidc = await startMockOidc();
});
afterAll(async () => {
  await oidc.close();
});

async function authorizeAt(o: MockOidc, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  const q = new URLSearchParams({ client_id: 'c', redirect_uri: REDIRECT, response_type: 'code', ...params });
  return fetch(`${o.url}/authorize?${q}`, { redirect: 'manual', headers });
}

async function idTokenFor(o: MockOidc, params: Record<string, string>): Promise<Record<string, unknown>> {
  const cb = new URL((await authorizeAt(o, params)).headers.get('location') as string);
  const res = await fetch(`${o.url}/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'c' }),
  });
  const body = (await res.json()) as Record<string, string>;
  return (await jwtVerify(body.id_token as string, createRemoteJWKSet(new URL(o.jwksUrl)), { issuer: o.issuer })).payload;
}

describe('mock OIDC issuer, Zitadel behaviors', () => {
  it('discovery lists end_session_endpoint and the jwt-bearer grant', async () => {
    const doc = (await (await fetch(`${oidc.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc.end_session_endpoint).toBe(`${oidc.issuer}/end_session`);
    expect(doc.grant_types_supported).toContain(JWT_BEARER_GRANT);
  });

  it('end_session sends the browser back with state and ends the session', async () => {
    const back = encodeURIComponent('http://localhost:3000/bye');
    const res = await fetch(`${oidc.url}/end_session?post_logout_redirect_uri=${back}&state=x1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000/bye?state=x1');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('sets both org claims, amr and email_verified in tokens and userinfo', async () => {
    const user = { sub: TENANT_A.admin.id, email: TENANT_A.admin.email, name: TENANT_A.admin.name, tenantId: TENANT_A.id, amr: ['pwd', 'mfa'] };
    const o = await startMockOidc({ users: { u: user }, defaultUser: 'u' });
    try {
      const id = await idTokenFor(o, {});
      expect(id[ORG_CLAIM]).toBe(TENANT_A.id);
      expect(id[RESOURCE_OWNER_CLAIM]).toBe(TENANT_A.id);
      expect(id.amr).toEqual(['pwd', 'mfa']);
      expect(id.email_verified).toBe(true);
    } finally {
      await o.close();
    }
  });

  it('the orgId option fixes the org claims for every user', async () => {
    const o = await startMockOidc({ orgId: 'org-fixed' });
    try {
      const id = await idTokenFor(o, { user: 'b' });
      expect(id[ORG_CLAIM]).toBe('org-fixed');
      expect(id[RESOURCE_OWNER_CLAIM]).toBe('org-fixed');
      expect(id.sub).toBe(TENANT_B.admin.id);
    } finally {
      await o.close();
    }
  });

  it('serves a free-mail user and an unverified user', async () => {
    const f = await idTokenFor(oidc, { user: 'free' });
    expect(f.email).toBe(FREE_MAIL_USER.email);
    expect(String(f.email)).toMatch(/@gmail\.com$/);
    expect(f.email_verified).toBe(true);
    const u = await idTokenFor(oidc, { user: 'unverified' });
    expect(u.email).toBe(UNVERIFIED_USER.email);
    expect(u.email_verified).toBe(false);
  });

  it('login_hint chooses the user whose email matches', async () => {
    const id = await idTokenFor(oidc, { login_hint: TENANT_B.admin.email });
    expect(id.sub).toBe(TENANT_B.admin.id);
  });

  it('prompt=none answers login_required until a session cookie or flag exists', async () => {
    const o = await startMockOidc();
    try {
      const silent = { prompt: 'none', state: 'p1' };
      const first = new URL((await authorizeAt(o, silent)).headers.get('location') as string);
      expect(first.searchParams.get('error')).toBe('login_required');
      expect(first.searchParams.get('state')).toBe('p1');
      expect(first.searchParams.get('code')).toBeNull();

      const signIn = await authorizeAt(o, { user: 'b' });
      const cookie = (signIn.headers.get('set-cookie') as string).split(';')[0] as string;
      const second = new URL((await authorizeAt(o, silent, { cookie })).headers.get('location') as string);
      expect(second.searchParams.get('code')).toBeTruthy();

      o.setLoggedIn(true);
      const third = new URL((await authorizeAt(o, silent)).headers.get('location') as string);
      expect(third.searchParams.get('code')).toBeTruthy();
      o.setLoggedIn(false);
      const fourth = new URL((await authorizeAt(o, silent)).headers.get('location') as string);
      expect(fourth.searchParams.get('error')).toBe('login_required');
    } finally {
      await o.close();
    }
  });

  it('the tokenError option makes /token fail, and can be cleared', async () => {
    const o = await startMockOidc({ tokenError: { error: 'temporarily_unavailable', status: 503 } });
    const call = (): Promise<Response> => fetch(`${o.url}/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }) });
    try {
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
      o.setTokenError(undefined);
      const again = await call();
      expect(again.status).toBe(400);
      expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
    } finally {
      await o.close();
    }
  });
});

describe('mock OIDC issuer, jwt-bearer grant', () => {
  const grant = (o: MockOidc, assertion?: string): Promise<Response> =>
    fetch(`${o.url}/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, ...(assertion ? { assertion } : {}), scope: 'openid' }) });

  it('accepts an assertion signed by a registered key and returns an access token', async () => {
    const o = await startMockOidc();
    try {
      const key = createServiceKey('identity-sa');
      o.registerServiceKey(key.userId, key.publicJwk);
      const res = await grant(o, await key.assertion(o.issuer));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(3600);
      const claims = (await jwtVerify(body.access_token as string, createRemoteJWKSet(new URL(o.jwksUrl)), { issuer: o.issuer })).payload;
      expect(claims.sub).toBe('identity-sa');
      expect(JSON.parse(key.json)).toMatchObject({ type: 'serviceaccount', userId: 'identity-sa', keyId: key.keyId });
    } finally {
      await o.close();
    }
  });

  it('refuses an unknown issuer, a wrong signature, a wrong audience, an expired or a missing assertion', async () => {
    const key = createServiceKey('sa-1');
    const o = await startMockOidc({ serviceKeys: { 'sa-1': key.publicJwk } });
    try {
      expect((await grant(o, await createServiceKey('ghost').assertion(o.issuer))).status).toBe(400);
      expect((await grant(o, await createServiceKey('sa-1').assertion(o.issuer))).status).toBe(400);
      expect((await grant(o, await key.assertion('http://elsewhere.test'))).status).toBe(400);
      expect((await grant(o)).status).toBe(400);
      const past = Math.floor(Date.now() / 1000) - 3600;
      const expired = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: key.keyId }).setIssuer('sa-1').setSubject('sa-1').setAudience(o.issuer).setIssuedAt(past).setExpirationTime(past + 60).sign(key.privateKey);
      const res = await grant(o, expired);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await grant(o, await key.assertion(o.issuer))).status).toBe(200);
    } finally {
      await o.close();
    }
  });
});
