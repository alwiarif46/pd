// Mock OIDC issuer. Stands in for Zitadel when E2E_STACK=native (BUILD-PLAN s8, stub rule).
// It speaks enough of OpenID Connect for the gateway and identity service: discovery, JWKS, authorize (auto-login),
// token (authorization code with optional PKCE, and refresh), and userinfo. Tokens are RS256, signed with a key
// generated when the issuer starts. It is for tests and local runs only: it must never be imported by production code.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';
import { TENANT_A, TENANT_B, type TenantFixture } from '../fixtures.js';

export interface MockOidcUser {
  sub: string;
  email: string;
  name: string;
  /** Tenant (organization) id, sent as the Zitadel-style org claims. Absent for a user with no tenant yet (the default org id is sent). */
  tenantId?: string;
  /** Authentication methods references, for example `['pwd', 'mfa']`. Default `['pwd']`. */
  amr?: string[];
  /** Default true. */
  emailVerified?: boolean;
}

export interface MockOidcTokenError {
  error: string;
  description?: string;
  /** Default 400. */
  status?: number;
}

export interface MockOidcOptions {
  /** Default 0: any free port. */
  port?: number;
  host?: string;
  /** Issuer URL. Default `http://<host>:<port>`, known after listen. */
  issuer?: string;
  /** Accepted client id. Default: any client id is accepted. */
  clientId?: string;
  /** Users the `user` query parameter can choose from. Default: the admins of TENANT_A and TENANT_B, as `a` and `b`. */
  users?: Record<string, MockOidcUser>;
  /** User used when /authorize has no `user` parameter. Default `a`. */
  defaultUser?: string;
  accessTokenTtlSeconds?: number;
  /** Fixed value for both org claims, whatever the user. Default: the user's tenant id. */
  orgId?: string;
  /** Makes every /token call fail with this OAuth error. Change it later with `setTokenError`. */
  tokenError?: MockOidcTokenError;
  /** Public keys the jwt-bearer grant accepts, by assertion issuer (the machine user id). Add more with `registerServiceKey`. */
  serviceKeys?: Record<string, JWK>;
  /** When true, `prompt=none` succeeds without a session cookie. Default false. Change it later with `setLoggedIn`. */
  loggedIn?: boolean;
}

export interface MockOidc {
  url: string;
  issuer: string;
  jwksUrl: string;
  port: number;
  /** Sets or clears the error that every /token call returns. */
  setTokenError(error: MockOidcTokenError | undefined): void;
  /** Registers a public key for the jwt-bearer grant. */
  registerServiceKey(userId: string, publicJwk: JWK): void;
  /** Says whether `prompt=none` finds a session when the request has no session cookie. */
  setLoggedIn(loggedIn: boolean): void;
  close(): Promise<void>;
}

export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** The claim Zitadel uses for the user's resource owner (organization) in its tokens. */
export const RESOURCE_OWNER_CLAIM = 'urn:zitadel:iam:user:resourceowner:id';
/** Org id sent for a user with no tenant (Zitadel's default org). */
export const DEFAULT_ORG_ID = '000000000000000001';
const SESSION_COOKIE = 'mock_oidc_session';

/** Signs in with a work email that is not verified, and has no tenant yet. */
export const UNVERIFIED_USER: MockOidcUser = {
  sub: 'cccccccc-0000-4000-8000-000000000001',
  email: 'unverified@example.test',
  name: 'Unverified User',
  emailVerified: false,
};

/** Signs in with a verified free-mail address, and has no tenant yet. */
export const FREE_MAIL_USER: MockOidcUser = {
  sub: 'dddddddd-0000-4000-8000-000000000001',
  email: 'someone@gmail.com',
  name: 'Some One',
};

export interface ServiceKey {
  userId: string;
  keyId: string;
  publicJwk: JWK;
  privateKey: KeyObject;
  /** A Zitadel key file: `{"type":"serviceaccount","keyId","key":<PKCS#1 PEM>,"userId"}`. */
  json: string;
  /** Builds a signed jwt-bearer assertion for `audience` (the issuer URL). */
  assertion(audience: string, ttlSeconds?: number): Promise<string>;
}

/** Makes a machine-user key pair like the one Zitadel hands out for the JWT profile. */
export function createServiceKey(userId: string): ServiceKey {
  const keyId = randomBytes(8).toString('hex');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const key = createPrivateKey(privateKey);
  const publicJwk: JWK = { ...(createPublicKey(publicKey).export({ format: 'jwk' }) as JWK), kid: keyId, alg: 'RS256', use: 'sig' };
  return {
    userId,
    keyId,
    publicJwk,
    privateKey: key,
    json: JSON.stringify({ type: 'serviceaccount', keyId, key: privateKey, userId }),
    assertion: (audience, ttlSeconds = 300) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: keyId })
        .setIssuer(userId)
        .setSubject(userId)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key),
  };
}

export function fixtureUser(t: TenantFixture): MockOidcUser {
  return { sub: t.admin.id, email: t.admin.email, name: t.admin.name, tenantId: t.id };
}

interface AccessGrant {
  user: MockOidcUser;
  expires: number;
}
interface CodeGrant {
  user: MockOidcUser;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  challenge?: string;
  expires: number;
}
interface RefreshGrant {
  user: MockOidcUser;
  clientId: string;
}

export const ORG_CLAIM = 'urn:zitadel:iss:org:id';

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startMockOidc(options: MockOidcOptions = {}): Promise<MockOidc> {
  const host = options.host ?? '127.0.0.1';
  const users = options.users ?? {
    a: fixtureUser(TENANT_A),
    b: fixtureUser(TENANT_B),
    free: FREE_MAIL_USER,
    unverified: UNVERIFIED_USER,
  };
  const defaultUser = options.defaultUser ?? 'a';
  const ttl = options.accessTokenTtlSeconds ?? 3600;

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomBytes(8).toString('hex');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  let tokenError = options.tokenError;
  let loggedIn = options.loggedIn ?? false;
  const serviceKeys = new Map<string, JWK>(Object.entries(options.serviceKeys ?? {}));
  const codes = new Map<string, CodeGrant>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const accessTokens = new Map<string, AccessGrant>();
  let issuer = options.issuer ?? '';

  async function sign(key: Parameters<SignJWT['sign']>[0], claims: Record<string, unknown>, aud: string, sub: string): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setSubject(sub)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(key);
  }

  /** Drops expired codes and access tokens, so a long local run does not grow without bound. */
  function sweep(): void {
    const now = Date.now();
    for (const [k, g] of codes) if (g.expires < now) codes.delete(k);
    for (const [k, g] of accessTokens) if (g.expires < now) accessTokens.delete(k);
  }

  function claimsOf(user: MockOidcUser): Record<string, unknown> {
    const org = options.orgId ?? user.tenantId ?? DEFAULT_ORG_ID;
    return {
      email: user.email,
      email_verified: user.emailVerified ?? true,
      name: user.name,
      amr: user.amr ?? ['pwd'],
      [ORG_CLAIM]: org,
      [RESOURCE_OWNER_CLAIM]: org,
    };
  }

  async function tokensFor(user: MockOidcUser, clientId: string, nonce: string | undefined, scope: string): Promise<Record<string, unknown>> {
    const common = claimsOf(user);
    const idToken = await sign(privateKey, { ...common, ...(nonce ? { nonce } : {}) }, clientId, user.sub);
    const accessToken = await sign(privateKey, { ...common, scope }, clientId, user.sub);
    const refreshToken = randomBytes(24).toString('base64url');
    sweep();
    accessTokens.set(accessToken, { user, expires: Date.now() + ttl * 1000 });
    refreshTokens.set(refreshToken, { user, clientId });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, id_token: idToken, refresh_token: refreshToken, scope };
  }

  function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
    json(res, status, { error, error_description: description });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', issuer || 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        end_session_endpoint: `${issuer}/end_session`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', JWT_BEARER_GRANT],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'amr', ORG_CLAIM, RESOURCE_OWNER_CLAIM],
      });
    }

    if (req.method === 'GET' && path === '/jwks') return json(res, 200, { keys: [jwk] });

    if (req.method === 'GET' && path === '/authorize') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri');
      const clientId = q.get('client_id') ?? '';
      if (!redirectUri) return oauthError(res, 400, 'invalid_request', 'redirect_uri is required');
      if (options.clientId && clientId !== options.clientId) return oauthError(res, 400, 'unauthorized_client', 'unknown client_id');
      const sessionKey = cookieOf(req, SESSION_COOKIE);
      const hinted = Object.keys(users).find((k) => users[k]?.email === q.get('login_hint'));
      const userKey = q.get('user') ?? hinted ?? (sessionKey && users[sessionKey] ? sessionKey : defaultUser);
      const user = users[userKey];
      if (!user) return oauthError(res, 400, 'invalid_request', `unknown user ${userKey}`);
      const back = new URL(redirectUri);
      const state = q.get('state');
      if (q.get('prompt') === 'none' && !loggedIn && !sessionKey) {
        back.searchParams.set('error', 'login_required');
        if (state) back.searchParams.set('state', state);
        res.writeHead(302, { location: back.toString() });
        return void res.end();
      }
      if (q.get('response_type') !== 'code') {
        back.searchParams.set('error', 'unsupported_response_type');
        if (state) back.searchParams.set('state', state);
        res.writeHead(302, { location: back.toString() });
        return void res.end();
      }
      sweep();
      const code = randomBytes(16).toString('base64url');
      codes.set(code, {
        user,
        clientId,
        redirectUri,
        ...(q.get('nonce') ? { nonce: q.get('nonce') as string } : {}),
        ...(q.get('code_challenge') ? { challenge: q.get('code_challenge') as string } : {}),
        expires: Date.now() + 60_000,
      });
      back.searchParams.set('code', code);
      if (state) back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString(), 'set-cookie': `${SESSION_COOKIE}=${userKey}; Path=/; HttpOnly; SameSite=Lax` });
      return void res.end();
    }

    if (req.method === 'GET' && path === '/end_session') {
      const target = url.searchParams.get('post_logout_redirect_uri');
      const clear = `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`;
      if (!target) {
        res.setHeader('set-cookie', clear);
        return json(res, 200, { ok: true });
      }
      const back = new URL(target);
      if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state') as string);
      res.writeHead(302, { location: back.toString(), 'set-cookie': clear });
      return void res.end();
    }

    if (req.method === 'POST' && path === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get('grant_type');
      if (tokenError) return oauthError(res, tokenError.status ?? 400, tokenError.error, tokenError.description ?? tokenError.error);
      const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
      const clientId = form.get('client_id') ?? (basic ? Buffer.from(basic[1] as string, 'base64').toString().split(':')[0] : '') ?? '';
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        const g = codes.get(code);
        codes.delete(code); // a code works once
        if (!g || g.expires < Date.now()) return oauthError(res, 400, 'invalid_grant', 'unknown or expired code');
        if (form.get('redirect_uri') !== g.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
        if (g.clientId && clientId && g.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'client mismatch');
        if (g.challenge) {
          const verifier = form.get('code_verifier');
          if (!verifier || s256(verifier) !== g.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
        }
        return json(res, 200, await tokensFor(g.user, g.clientId || clientId, g.nonce, 'openid profile email offline_access'));
      }
      if (grant === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        const g = refreshTokens.get(token);
        if (!g) return oauthError(res, 400, 'invalid_grant', 'unknown refresh token');
        refreshTokens.delete(token); // rotate
        return json(res, 200, await tokensFor(g.user, g.clientId, undefined, 'openid profile email offline_access'));
      }
      if (grant === JWT_BEARER_GRANT) {
        const assertion = form.get('assertion');
        if (!assertion) return oauthError(res, 400, 'invalid_request', 'assertion is required');
        let iss: string | undefined;
        try {
          iss = decodeJwt(assertion).iss;
        } catch {
          return oauthError(res, 400, 'invalid_grant', 'assertion is not a JWT');
        }
        const registered = iss ? serviceKeys.get(iss) : undefined;
        if (!iss || !registered) return oauthError(res, 400, 'invalid_grant', 'no key is registered for the assertion issuer');
        try {
          await jwtVerify(assertion, await importJWK(registered, 'RS256'), { issuer: iss, audience: issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'iat'] });
        } catch (err) {
          return oauthError(res, 400, 'invalid_grant', `assertion rejected: ${(err as Error).message}`);
        }
        const scope = form.get('scope') ?? 'openid';
        const accessToken = await sign(privateKey, { scope }, issuer, iss);
        return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, scope });
      }
      return oauthError(res, 400, 'unsupported_grant_type', `grant_type ${grant ?? '(none)'} is not supported`);
    }

    if ((req.method === 'GET' || req.method === 'POST') && path === '/userinfo') {
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
      const grant = m ? accessTokens.get(m[1] as string) : undefined;
      const user = grant && grant.expires >= Date.now() ? grant.user : undefined;
      if (!user) {
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        return oauthError(res, 401, 'invalid_token', 'missing or unknown access token');
      }
      return json(res, 200, { sub: user.sub, ...claimsOf(user) });
    }

    json(res, 404, { error: 'not_found' });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: (err as Error).message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  if (!issuer) issuer = `http://${host}:${port}`;

  return {
    url: issuer,
    issuer,
    jwksUrl: `${issuer}/jwks`,
    port,
    setTokenError: (e) => {
      tokenError = e;
    },
    registerServiceKey: (userId, publicJwk) => {
      serviceKeys.set(userId, publicJwk);
    },
    setLoggedIn: (v) => {
      loggedIn = v;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
