// In-memory fake of the Zitadel admin and management endpoints the identity service calls (chat 2 identity design,
// "Zitadel client"). It keeps state, records every call, injects 5xx on demand, and wants a bearer token from the
// jwt-bearer grant of the mock issuer. Paths and bodies come from the design notes; items marked "verify in CI" in that
// note stay unproven until the CI Zitadel runs. Test and local-run code only: production code must never import it.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MockOidc } from './oidc.js';

export interface ZitadelOrg {
  id: string;
  name: string;
}
export interface ZitadelUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  state: 'active' | 'inactive';
}
export interface ZitadelProject {
  id: string;
  name: string;
  body: Record<string, unknown>;
}
export interface ZitadelApp {
  id: string;
  projectId: string;
  clientId: string;
  name: string;
  body: Record<string, unknown>;
}
export interface ZitadelIdp {
  id: string;
  kind: 'google' | 'azure';
  body: Record<string, unknown>;
}
export interface ZitadelTarget {
  id: string;
  body: Record<string, unknown>;
  /** Shown once by the real API. The fake keeps it so a test can sign events. */
  signingKey: string;
}
export interface ZitadelCall {
  method: string;
  path: string;
  body: unknown;
  status: number;
  /** The bearer token's subject, or undefined when the call had none. */
  subject?: string;
}

export interface MockZitadelOptions {
  /** The issuer whose jwt-bearer tokens this fake accepts. Required unless `requireAuth` is false. */
  oidc?: MockOidc;
  /** Default true. */
  requireAuth?: boolean;
  port?: number;
  host?: string;
}

export interface FailureRule {
  /** Matches any method when omitted. */
  method?: string;
  /** Exact path, for example `/v2/organizations`. A trailing `*` matches a prefix. */
  path: string;
  /** Default 503. */
  status?: number;
  /** Fails this many calls, then stops. Default: every call. */
  times?: number;
}

export interface MockZitadel {
  url: string;
  port: number;
  calls: ZitadelCall[];
  orgs: Map<string, ZitadelOrg>;
  users: Map<string, ZitadelUser>;
  projects: Map<string, ZitadelProject>;
  apps: Map<string, ZitadelApp>;
  idps: Map<string, ZitadelIdp>;
  targets: Map<string, ZitadelTarget>;
  /** The last PUT /admin/v1/policies/login body. */
  loginPolicy: Record<string, unknown> | undefined;
  secondFactors: string[];
  multiFactors: string[];
  /** Ids of IdPs added to the login policy. */
  loginIdps: string[];
  /** Last PUT /v2/actions/executions bodies, by JSON of the condition. */
  executions: Map<string, Record<string, unknown>>;
  addUser(user: Partial<ZitadelUser> & { id: string }): ZitadelUser;
  injectFailure(rule: FailureRule): void;
  clearFailures(): void;
  /** Clears state, calls and failures. */
  reset(): void;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
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

// gRPC-gateway style error: code 6 already exists, 5 not found, 3 invalid argument, 16 unauthenticated.
const err = (res: ServerResponse, status: number, code: number, message: string): void => json(res, status, { code, message, details: [] });
const details = (): Record<string, unknown> => ({ details: { sequence: '1', changeDate: new Date().toISOString() } });

export async function startMockZitadel(options: MockZitadelOptions = {}): Promise<MockZitadel> {
  const host = options.host ?? '127.0.0.1';
  const requireAuth = options.requireAuth ?? true;
  if (requireAuth && !options.oidc) throw new Error('startMockZitadel needs an oidc issuer, or requireAuth: false');
  const jwks = options.oidc ? createRemoteJWKSet(new URL(options.oidc.jwksUrl)) : undefined;

  const z: MockZitadel = {
    url: '',
    port: 0,
    calls: [],
    orgs: new Map(),
    users: new Map(),
    projects: new Map(),
    apps: new Map(),
    idps: new Map(),
    targets: new Map(),
    loginPolicy: undefined,
    secondFactors: [],
    multiFactors: [],
    loginIdps: [],
    executions: new Map(),
    addUser(u) {
      const user: ZitadelUser = { orgId: 'default-org', email: `${u.id}@example.test`, name: u.id, emailVerified: true, state: 'active', ...u };
      z.users.set(user.id, user);
      return user;
    },
    injectFailure: (rule) => void failures.push({ ...rule, left: rule.times ?? Infinity }),
    clearFailures: () => void (failures.length = 0),
    reset() {
      z.calls.length = 0;
      for (const m of [z.orgs, z.users, z.projects, z.apps, z.idps, z.targets, z.executions] as Array<Map<string, unknown>>) m.clear();
      z.loginPolicy = undefined;
      z.secondFactors.length = 0;
      z.multiFactors.length = 0;
      z.loginIdps.length = 0;
      failures.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const failures: Array<FailureRule & { left: number }> = [];

  function matchFailure(method: string, path: string): number | undefined {
    for (const f of failures) {
      if (f.left <= 0) continue;
      if (f.method && f.method.toUpperCase() !== method) continue;
      const hit = f.path.endsWith('*') ? path.startsWith(f.path.slice(0, -1)) : f.path === path;
      if (!hit) continue;
      f.left -= 1;
      return f.status ?? 503;
    }
    return undefined;
  }

  async function subjectOf(req: IncomingMessage): Promise<string | undefined | null> {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m || !jwks || !options.oidc) return undefined;
    try {
      const { payload } = await jwtVerify(m[1] as string, jwks, { issuer: options.oidc.issuer });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  async function route(method: string, path: string, body: Record<string, unknown>, res: ServerResponse): Promise<number> {
    const reply = (status: number, payload: unknown): number => (json(res, status, payload), status);
    const fail = (status: number, code: number, message: string): number => (err(res, status, code, message), status);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    if (method === 'POST' && path === '/v2/organizations') {
      const name = str(body.name);
      if (!name) return fail(400, 3, 'name is required');
      const id = str(body.organization_id ?? body.organizationId) || String(randomBytes(9).readBigUInt64BE() % 10n ** 18n);
      if (z.orgs.has(id)) return fail(409, 6, `organization ${id} already exists`);
      z.orgs.set(id, { id, name });
      return reply(201, { organization_id: id, organizationId: id, created_date: new Date().toISOString() });
    }

    const userAction = /^\/v2\/users\/([^/]+)(?:\/(deactivate|reactivate))?$/.exec(path);
    if (userAction) {
      const user = z.users.get(decodeURIComponent(userAction[1] as string));
      if (!user) return fail(404, 5, 'user not found');
      if (method === 'GET' && !userAction[2]) {
        return reply(200, {
          user: {
            userId: user.id,
            state: user.state === 'active' ? 'USER_STATE_ACTIVE' : 'USER_STATE_INACTIVE',
            username: user.email,
            details: { resourceOwner: user.orgId },
            human: { profile: { displayName: user.name }, email: { email: user.email, isVerified: user.emailVerified } },
          },
        });
      }
      if (method === 'POST' && userAction[2]) {
        user.state = userAction[2] === 'deactivate' ? 'inactive' : 'active'; // idempotent here; the real API may differ (verify in CI)
        return reply(200, details());
      }
    }

    if (method === 'POST' && path === '/management/v1/projects') {
      const name = str(body.name);
      if (!name) return fail(400, 3, 'name is required');
      if ([...z.projects.values()].some((p) => p.name === name)) return fail(409, 6, 'project already exists');
      const id = randomUUID();
      z.projects.set(id, { id, name, body });
      return reply(200, { id, ...details() });
    }
    if (method === 'POST' && path === '/management/v1/projects/_search') {
      const name = str((body.queries as Array<{ nameQuery?: { name?: string } }> | undefined)?.[0]?.nameQuery?.name);
      const result = [...z.projects.values()].filter((p) => !name || p.name === name).map((p) => ({ id: p.id, name: p.name }));
      return reply(200, { result });
    }
    const appPath = /^\/management\/v1\/projects\/([^/]+)\/apps\/(oidc|_search)$/.exec(path);
    if (method === 'POST' && appPath) {
      const projectId = decodeURIComponent(appPath[1] as string);
      if (!z.projects.has(projectId)) return fail(404, 5, 'project not found');
      if (appPath[2] === '_search') {
        return reply(200, { result: [...z.apps.values()].filter((a) => a.projectId === projectId).map((a) => ({ id: a.id, name: a.name, oidcConfig: { clientId: a.clientId } })) });
      }
      const name = str(body.name);
      if (!name) return fail(400, 3, 'name is required');
      if ([...z.apps.values()].some((a) => a.projectId === projectId && a.name === name)) return fail(409, 6, 'app already exists');
      const id = randomUUID();
      const clientId = `${String(randomBytes(9).readBigUInt64BE() % 10n ** 18n)}@e2e`;
      z.apps.set(id, { id, projectId, clientId, name, body });
      return reply(200, { appId: id, clientId, ...details() });
    }

    if (method === 'PUT' && path === '/admin/v1/policies/login') {
      z.loginPolicy = body;
      return reply(200, details());
    }
    if (method === 'POST' && (path === '/admin/v1/policies/login/second_factors' || path === '/admin/v1/policies/login/multi_factors')) {
      const list = path.endsWith('second_factors') ? z.secondFactors : z.multiFactors;
      const type = str(body.type);
      if (!type) return fail(400, 3, 'type is required');
      if (list.includes(type)) return fail(409, 6, 'factor already added');
      list.push(type);
      return reply(200, details());
    }
    const idpKind = /^\/admin\/v1\/idps\/(google|azure)$/.exec(path);
    if (method === 'POST' && idpKind) {
      const id = randomUUID();
      z.idps.set(id, { id, kind: idpKind[1] as 'google' | 'azure', body });
      return reply(200, { id, ...details() });
    }
    if (method === 'POST' && path === '/admin/v1/policies/login/idps') {
      const idpId = str(body.idpId ?? body.idp_id);
      if (!z.idps.has(idpId)) return fail(404, 5, 'idp not found');
      if (z.loginIdps.includes(idpId)) return fail(409, 6, 'idp already in the login policy');
      z.loginIdps.push(idpId);
      return reply(200, details());
    }

    if (method === 'POST' && path === '/v2/actions/targets') {
      const name = str(body.name);
      if (!name) return fail(400, 3, 'name is required');
      const id = randomUUID();
      const signingKey = randomBytes(24).toString('base64url');
      z.targets.set(id, { id, body, signingKey });
      return reply(201, { id, creationDate: new Date().toISOString(), signingKey });
    }
    if (method === 'PUT' && path === '/v2/actions/executions') {
      const ids = Array.isArray(body.targets) ? (body.targets as unknown[]).map(String) : [];
      const unknown = ids.find((t) => !z.targets.has(t));
      if (unknown) return fail(400, 3, `target ${unknown} does not exist`);
      z.executions.set(JSON.stringify(body.condition ?? null), body);
      return reply(200, { setDate: new Date().toISOString() });
    }

    return fail(404, 5, 'Not Found');
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* a bad body reads as empty and fails validation below */
      }
      const subject = await subjectOf(req);
      const record = (status: number): void => void z.calls.push({ method, path, body, status, ...(typeof subject === 'string' ? { subject } : {}) });
      if (requireAuth && typeof subject !== 'string') {
        err(res, 401, 16, 'missing or invalid bearer token');
        return record(401);
      }
      const injected = matchFailure(method, path);
      if (injected) {
        err(res, injected, 13, 'injected failure');
        return record(injected);
      }
      record(await route(method, path, body, res));
    })().catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { code: 13, message: (e as Error).message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  z.port = (server.address() as AddressInfo).port;
  z.url = `http://${host}:${z.port}`;
  return z;
}

/**
 * Signs a Zitadel Actions v2 webhook body: `t=<unix>,v1=<hex hmac-sha256 of "t.body">`.
 * This follows the design note. The real header format is "verify in CI" against the CI Zitadel.
 */
export function signZitadelEvent(body: string, signingKey: string, now: number = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', signingKey).update(`${now}.${body}`).digest('hex');
  return `t=${now},v1=${mac}`;
}

export interface VerifyZitadelEventOptions {
  /** Seconds the timestamp may differ from `now`. Default 300. */
  toleranceSeconds?: number;
  /** Unix seconds. Default: the clock. */
  now?: number;
}

/** Checks the header from `signZitadelEvent` with a constant-time compare and a timestamp window. */
export function verifyZitadelEvent(body: string, header: string | undefined, signingKey: string, opts: VerifyZitadelEventOptions = {}): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = createHmac('sha256', signingKey).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
