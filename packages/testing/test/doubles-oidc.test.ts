import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ORG_CLAIM, startMockOidc, TENANT_A, TENANT_B, type MockOidc } from '../src/index';

let oidc: MockOidc;
beforeAll(async () => {
  oidc = await startMockOidc({ clientId: 'web-client', idTokenUserinfo: true });
});
afterAll(async () => {
  await oidc.close();
});

const REDIRECT = 'http://localhost:3000/callback';

async function authorize(params: Record<string, string>): Promise<URL> {
  const q = new URLSearchParams({ client_id: 'web-client', redirect_uri: REDIRECT, response_type: 'code', state: 's1', ...params });
  const res = await fetch(`${oidc.url}/authorize?${q}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') as string);
}

async function token(form: Record<string, string>): Promise<Response> {
  return fetch(`${oidc.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
}

describe('mock OIDC issuer', () => {
  it('serves a discovery document whose endpoints point at itself', async () => {
    const doc = (await (await fetch(`${oidc.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(oidc.issuer);
    expect(doc.jwks_uri).toBe(oidc.jwksUrl);
    expect(doc.token_endpoint).toBe(`${oidc.issuer}/oauth/v2/token`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('publishes a JWKS with one RS256 key and no private part', async () => {
    const { keys } = (await (await fetch(oidc.jwksUrl)).json()) as { keys: Array<Record<string, unknown>> };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('authorize logs in as tenant A by default and as tenant B with user=b', async () => {
    const a = await authorize({ nonce: 'n1' });
    expect(a.origin + a.pathname).toBe(REDIRECT);
    expect(a.searchParams.get('state')).toBe('s1');
    const tokens = (await (await token({ grant_type: 'authorization_code', code: a.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client' })).json()) as Record<string, string>;
    const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
    const idA = await jwtVerify(tokens.id_token as string, jwks, { issuer: oidc.issuer, audience: 'web-client' });
    expect(idA.payload.sub).toBe(TENANT_A.admin.id);
    expect(idA.payload.email).toBe(TENANT_A.admin.email);
    expect(idA.payload[ORG_CLAIM]).toBe(TENANT_A.id);
    expect(idA.payload.nonce).toBe('n1');
    expect(idA.protectedHeader.alg).toBe('RS256');

    const b = await authorize({ user: 'b' });
    const tb = (await (await token({ grant_type: 'authorization_code', code: b.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client' })).json()) as Record<string, string>;
    const idB = await jwtVerify(tb.id_token as string, jwks, { issuer: oidc.issuer, audience: 'web-client' });
    expect(idB.payload.sub).toBe(TENANT_B.admin.id);
    expect(idB.payload[ORG_CLAIM]).toBe(TENANT_B.id);
    const accessB = await jwtVerify(tb.access_token as string, jwks, { issuer: oidc.issuer });
    expect(accessB.payload.sub).toBe(TENANT_B.admin.id);
  });

  it('a code works once and needs the same redirect_uri', async () => {
    const cb = await authorize({});
    const code = cb.searchParams.get('code') as string;
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: 'http://evil.test/cb', client_id: 'web-client' })).status).toBe(400);
    // the failed attempt used the code up
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'web-client' })).status).toBe(400);
  });

  it('checks PKCE when the authorize request carried a challenge', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const bad = await authorize({ code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await token({ grant_type: 'authorization_code', code: bad.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client', code_verifier: 'wrong' })).status).toBe(400);
    const good = await authorize({ code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await token({ grant_type: 'authorization_code', code: good.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client', code_verifier: verifier });
    expect(res.status).toBe(200);
  });

  it('refresh grant issues new tokens and rotates the refresh token', async () => {
    const cb = await authorize({ user: 'b' });
    const first = (await (await token({ grant_type: 'authorization_code', code: cb.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client' })).json()) as Record<string, string>;
    const res = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token as string, client_id: 'web-client' });
    expect(res.status).toBe(200);
    const second = (await res.json()) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
    expect((await jwtVerify(second.id_token as string, jwks, { issuer: oidc.issuer })).payload.sub).toBe(TENANT_B.admin.id);
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token as string })).status).toBe(400);
  });

  it('userinfo returns the user for a token the issuer made, and 401 otherwise', async () => {
    const cb = await authorize({});
    const t = (await (await token({ grant_type: 'authorization_code', code: cb.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'web-client' })).json()) as Record<string, string>;
    const ok = await fetch(`${oidc.url}/userinfo`, { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sub: TENANT_A.admin.id, email: TENANT_A.admin.email, [ORG_CLAIM]: TENANT_A.id });
    expect((await fetch(`${oidc.url}/userinfo`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${oidc.url}/userinfo`)).status).toBe(401);
  });

  it('rejects an unknown client, an unknown user and an unsupported grant', async () => {
    const q = new URLSearchParams({ client_id: 'other', redirect_uri: REDIRECT, response_type: 'code' });
    expect((await fetch(`${oidc.url}/authorize?${q}`, { redirect: 'manual' })).status).toBe(400);
    const q2 = new URLSearchParams({ client_id: 'web-client', redirect_uri: REDIRECT, response_type: 'code', user: 'zed' });
    expect((await fetch(`${oidc.url}/authorize?${q2}`, { redirect: 'manual' })).status).toBe(400);
    expect((await token({ grant_type: 'password' })).status).toBe(400);
  });
});

describe('mock OIDC issuer, expiry', () => {
  it('userinfo refuses an access token after its lifetime', async () => {
    const short = await startMockOidc({ accessTokenTtlSeconds: 1 });
    try {
      const q = new URLSearchParams({ client_id: 'c', redirect_uri: REDIRECT, response_type: 'code' });
      const cb = new URL((await fetch(`${short.url}/authorize?${q}`, { redirect: 'manual' })).headers.get('location') as string);
      const t = (await (await fetch(`${short.url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code') as string, redirect_uri: REDIRECT, client_id: 'c' }),
      })).json()) as Record<string, string>;
      const call = (): Promise<Response> => fetch(`${short.url}/userinfo`, { headers: { authorization: `Bearer ${t.access_token}` } });
      expect((await call()).status).toBe(200);
      await new Promise((r) => setTimeout(r, 1100));
      expect((await call()).status).toBe(401);
    } finally {
      await short.close();
    }
  });
});
