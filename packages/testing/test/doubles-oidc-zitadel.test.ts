import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createServiceKey,
  FREE_MAIL_USER,
  JWT_BEARER_GRANT,
  ORG_CLAIM,
  RESOURCE_OWNER_CLAIM,
  RESOURCE_OWNER_SCOPE,
  startMockOidc,
  TENANT_A,
  TENANT_B,
  UNVERIFIED_USER,
  ZITADEL_API_SCOPE,
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
  return fetch(`${o.url}/oauth/v2/authorize?${q}`, { redirect: 'manual', headers });
}

interface SignedIn {
  id: Record<string, unknown>;
  access: Record<string, unknown>;
  info: Record<string, unknown>;
}

async function signIn(o: MockOidc, params: Record<string, string>): Promise<SignedIn> {
  const cb = new URL((await authorizeAt(o, params)).headers.get('location') as string);
  const res = await fetch(`${o.url}/oauth/v2/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'c' }),
  });
  const body = (await res.json()) as Record<string, string>;
  const keys = createRemoteJWKSet(new URL(o.jwksUrl));
  const id = (await jwtVerify(body.id_token as string, keys, { issuer: o.issuer })).payload;
  const access = (await jwtVerify(body.access_token as string, keys, { issuer: o.issuer })).payload;
  const info = (await (await fetch(`${o.url}/oidc/v1/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } })).json()) as Record<string, unknown>;
  return { id, access, info };
}

describe('mock OIDC issuer, Zitadel behaviors', () => {
  it('discovery lists Zitadel paths, end_session_endpoint and the jwt-bearer grant', async () => {
    const doc = (await (await fetch(`${oidc.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc.end_session_endpoint).toBe(`${oidc.issuer}/oidc/v1/end_session`);
    expect(doc.authorization_endpoint).toBe(`${oidc.issuer}/oauth/v2/authorize`);
    expect(doc.userinfo_endpoint).toBe(`${oidc.issuer}/oidc/v1/userinfo`);
    expect(doc.jwks_uri).toBe(`${oidc.issuer}/oauth/v2/keys`);
    expect(doc.grant_types_supported).toContain(JWT_BEARER_GRANT);
  });

  it('still answers on the short paths', async () => {
    expect((await fetch(`${oidc.url}/jwks`)).status).toBe(200);
    expect((await fetch(`${oidc.url}/end_session`)).status).toBe(200);
    expect((await fetch(`${oidc.url}/oauth/v2/keys`)).status).toBe(200);
  });

  it('end_session sends the browser back with state and ends the session', async () => {
    const back = encodeURIComponent('http://localhost:3000/bye');
    const res = await fetch(`${oidc.url}/oidc/v1/end_session?post_logout_redirect_uri=${back}&state=x1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000/bye?state=x1');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('end_session without post_logout_redirect_uri answers 200 and clears the cookie', async () => {
    const res = await fetch(`${oidc.url}/oidc/v1/end_session`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('sends amr in every token, and email, email_verified and name only in userinfo by default', async () => {
    const user = { sub: TENANT_A.admin.id, email: TENANT_A.admin.email, name: TENANT_A.admin.name, tenantId: TENANT_A.id, amr: ['pwd', 'mfa'] };
    const o = await startMockOidc({ users: { u: user }, defaultUser: 'u' });
    try {
      const { id, access, info } = await signIn(o, { scope: 'openid profile email' });
      expect(id.amr).toEqual(['pwd', 'mfa']);
      expect(access.amr).toEqual(['pwd', 'mfa']);
      expect(info.amr).toEqual(['pwd', 'mfa']);
      expect(id.email).toBeUndefined();
      expect(id.email_verified).toBeUndefined();
      expect(id.name).toBeUndefined();
      expect(info).toMatchObject({ email: TENANT_A.admin.email, email_verified: true, name: TENANT_A.admin.name });
    } finally {
      await o.close();
    }
  });

  it('idTokenUserinfo puts email, email_verified and name in the id_token too', async () => {
    const o = await startMockOidc({ idTokenUserinfo: true });
    try {
      const { id } = await signIn(o, {});
      expect(id).toMatchObject({ email: TENANT_A.admin.email, email_verified: true, name: TENANT_A.admin.name });
    } finally {
      await o.close();
    }
  });

  it('sends the resource owner claim only when its scope was requested', async () => {
    const withScope = await signIn(oidc, { scope: `openid ${RESOURCE_OWNER_SCOPE}` });
    for (const t of [withScope.id, withScope.access, withScope.info]) expect(t[RESOURCE_OWNER_CLAIM]).toBe(TENANT_A.id);
    const without = await signIn(oidc, { scope: 'openid profile email' });
    for (const t of [without.id, without.access, without.info]) expect(t[RESOURCE_OWNER_CLAIM]).toBeUndefined();
    expect(without.id[ORG_CLAIM]).toBeUndefined();
  });

  it('legacyOrgClaim adds the deprecated org claim, and is off by default', async () => {
    const o = await startMockOidc({ legacyOrgClaim: true });
    try {
      const { id, access, info } = await signIn(o, {});
      for (const t of [id, access, info]) expect(t[ORG_CLAIM]).toBe(TENANT_A.id);
    } finally {
      await o.close();
    }
    const plain = await signIn(oidc, {});
    for (const t of [plain.id, plain.access, plain.info]) expect(t[ORG_CLAIM]).toBeUndefined();
  });

  it('refuses the reserved client id zitadel on authorize', async () => {
    const res = await authorizeAt(oidc, { client_id: 'zitadel' });
    expect(res.status).toBe(400);
  });

  it('the orgId option fixes the org claims in the id_token, the access token and userinfo', async () => {
    const o = await startMockOidc({ orgId: 'org-fixed', legacyOrgClaim: true });
    try {
      const { id, access, info } = await signIn(o, { user: 'b', scope: `openid ${RESOURCE_OWNER_SCOPE}` });
      for (const t of [id, access, info]) expect(t[RESOURCE_OWNER_CLAIM]).toBe('org-fixed');
      expect(id[ORG_CLAIM]).toBe('org-fixed');
      expect(id.sub).toBe(TENANT_B.admin.id);
    } finally {
      await o.close();
    }
  });

  it('serves a free-mail user and an unverified user', async () => {
    const o = await startMockOidc({ idTokenUserinfo: true });
    try {
      const f = (await signIn(o, { user: 'free' })).id;
      expect(f.email).toBe(FREE_MAIL_USER.email);
      expect(String(f.email)).toMatch(/@gmail\.com$/);
      expect(f.email_verified).toBe(true);
      const u = await signIn(o, { user: 'unverified' });
      expect(u.id.email).toBe(UNVERIFIED_USER.email);
      expect(u.id.email_verified).toBe(false);
      expect(u.info.email_verified).toBe(false);
    } finally {
      await o.close();
    }
  });

  it('login_hint chooses the user whose email matches', async () => {
    const { id } = await signIn(oidc, { login_hint: TENANT_B.admin.email });
    expect(id.sub).toBe(TENANT_B.admin.id);
  });

  it('prompt=none answers login_required until a valid session cookie or flag exists', async () => {
    const o = await startMockOidc();
    try {
      const silent = { prompt: 'none', state: 'p1' };
      const first = new URL((await authorizeAt(o, silent)).headers.get('location') as string);
      expect(first.searchParams.get('error')).toBe('login_required');
      expect(first.searchParams.get('state')).toBe('p1');
      expect(first.searchParams.get('code')).toBeNull();

      const earlier = await authorizeAt(o, { user: 'b' });
      const cookie = (earlier.headers.get('set-cookie') as string).split(';')[0] as string;
      const second = new URL((await authorizeAt(o, silent, { cookie })).headers.get('location') as string);
      expect(second.searchParams.get('code')).toBeTruthy();

      // a cookie that names no known user does not count
      const forged = new URL((await authorizeAt(o, silent, { cookie: 'mock_oidc_session=nobody' })).headers.get('location') as string);
      expect(forged.searchParams.get('error')).toBe('login_required');

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
    const call = (): Promise<Response> => fetch(`${o.url}/oauth/v2/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }) });
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
  const grant = (o: MockOidc, assertion?: string, scope = 'openid'): Promise<Response> =>
    fetch(`${o.url}/oauth/v2/token`, { method: 'POST', headers: FORM, body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, ...(assertion ? { assertion } : {}), scope }) });

  /** Signs an assertion by hand, so a test can break one claim or header. */
  const forge = (key: ReturnType<typeof createServiceKey>, o: MockOidc, over: { iss?: string; sub?: string; iat?: number; kid?: string | null } = {}): Promise<string> => {
    const iat = over.iat ?? Math.floor(Date.now() / 1000);
    const header = over.kid === null ? { alg: 'RS256' } : { alg: 'RS256', kid: over.kid ?? key.keyId };
    return new SignJWT({}).setProtectedHeader(header).setIssuer(over.iss ?? key.userId).setSubject(over.sub ?? key.userId).setAudience(o.issuer).setIssuedAt(iat).setExpirationTime(iat + 300).sign(key.privateKey);
  };

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
      expect(claims.aud).toBe(o.issuer);
      expect(JSON.parse(key.json)).toMatchObject({ type: 'serviceaccount', userId: 'identity-sa', keyId: key.keyId });
    } finally {
      await o.close();
    }
  });

  it('adds the zitadel audience only when the API scope is requested', async () => {
    const o = await startMockOidc();
    try {
      const key = createServiceKey('identity-sa');
      o.registerServiceKey(key.userId, key.publicJwk);
      const body = (await (await grant(o, await key.assertion(o.issuer), `openid ${ZITADEL_API_SCOPE}`)).json()) as { access_token: string };
      expect((await jwtVerify(body.access_token, createRemoteJWKSet(new URL(o.jwksUrl)), { issuer: o.issuer })).payload.aud).toBe('zitadel');
    } finally {
      await o.close();
    }
  });

  it('keeps keys per user and per kid', async () => {
    const k1 = createServiceKey('sa-1');
    const k2 = createServiceKey('sa-1');
    const other = createServiceKey('sa-2');
    const o = await startMockOidc({ serviceKeys: { 'sa-1': k1.publicJwk } });
    try {
      o.registerServiceKey('sa-1', k2.publicJwk);
      o.registerServiceKey('sa-2', other.publicJwk);
      expect((await grant(o, await k1.assertion(o.issuer))).status).toBe(200);
      expect((await grant(o, await k2.assertion(o.issuer))).status).toBe(200);
      // a key registered for another user does not work for this one
      expect((await grant(o, await forge(other, o, { iss: 'sa-1', sub: 'sa-1' }))).status).toBe(400);
      // right user, but the kid of another user's key
      expect((await grant(o, await forge(k1, o, { kid: other.keyId }))).status).toBe(400);
    } finally {
      await o.close();
    }
  });

  it('refuses a missing kid, an unknown kid, sub different from iss, and a future iat', async () => {
    const key = createServiceKey('sa-1');
    const o = await startMockOidc({ serviceKeys: { 'sa-1': key.publicJwk } });
    const now = Math.floor(Date.now() / 1000);
    try {
      expect((await grant(o, await forge(key, o, { kid: null }))).status).toBe(400);
      expect((await grant(o, await forge(key, o, { kid: 'unknown' }))).status).toBe(400);
      const subMismatch = await grant(o, await forge(key, o, { sub: 'someone-else' }));
      expect(subMismatch.status).toBe(400);
      expect(await subMismatch.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await grant(o, await forge(key, o, { iat: now + 120 }))).status).toBe(400);
      expect((await grant(o, await forge(key, o, { iat: now + 2 }))).status).toBe(200);
    } finally {
      await o.close();
    }
  });

  it('refuses an unknown issuer, a wrong signature, a wrong audience, an expired or a missing assertion', async () => {
    const key = createServiceKey('sa-1');
    const o = await startMockOidc({ serviceKeys: { 'sa-1': key.publicJwk } });
    try {
      expect((await grant(o, await createServiceKey('ghost').assertion(o.issuer))).status).toBe(400);
      // signed by another private key but claiming the registered kid
      const impostor = createServiceKey('sa-1');
      expect((await grant(o, await forge(impostor, o, { kid: key.keyId }))).status).toBe(400);
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
