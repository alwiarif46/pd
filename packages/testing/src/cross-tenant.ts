// The cross-tenant helper of 09 s9.4: run every endpoint of a service as tenant B with tenant A's ids.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { parse } from 'yaml';
import { PACKAGE_ROOT } from '@pd/contracts';
import { FIXTURES, type TenantFixture, type TenantPair } from './fixtures.js';

/** Endpoints that need no credentials. Everything else must refuse a foreign tenant and anonymous callers. */
export const PUBLIC_ENDPOINTS: ReadonlyArray<string> = ['GET /healthz'];

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

export interface Endpoint {
  /** Upper case, such as `GET`. */
  method: string;
  /** OpenAPI form, such as `/bids/{id}`. */
  path: string;
  /** Path parameter names, in order. */
  params: string[];
  /** True when `METHOD path` is in PUBLIC_ENDPOINTS. */
  public: boolean;
}

export function endpointKey(e: Pick<Endpoint, 'method' | 'path'>): string {
  return `${e.method} ${e.path}`;
}

/** The endpoints of a service's OpenAPI file in @pd/contracts. */
export function endpointsOf(serviceId: string): Endpoint[] {
  if (!/^[a-z][a-z0-9_-]*$/.test(serviceId)) throw new Error(`Bad service id: ${JSON.stringify(serviceId)}`);
  const doc = parse(readFileSync(join(PACKAGE_ROOT, 'openapi', `${serviceId}.yaml`), 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const out: Endpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      if (item?.[m] === undefined) continue;
      const method = m.toUpperCase();
      out.push({
        method,
        path,
        params: [...path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1] as string),
        public: PUBLIC_ENDPOINTS.includes(`${method} ${path}`),
      });
    }
  }
  return out;
}

export interface InjectRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: unknown;
}

export interface InjectResponse {
  statusCode: number;
  body: string;
}

/** Fastify `app.inject` and a Python TestClient wrapper both fit this shape. */
export type Inject = (req: InjectRequest) => Promise<InjectResponse>;

/**
 * Header names that carry credentials. The anonymous probe removes these (compared in lower case) from
 * `headersFor(b)` and keeps every other header, such as content-type and accept, so a request is
 * rejected for the missing credentials and not for a missing media type.
 */
export const credentialHeaderNames: ReadonlyArray<string> = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-test-tenant',
];

export interface RunCrossTenantOptions {
  serviceId: string;
  inject: Inject;
  /** Tenant A (owner of the ids) and tenant B (the caller). Defaults to the shared fixtures. */
  fixtures?: TenantPair;
  /** Path parameter name to tenant A's id for that kind of resource. */
  ids: Record<string, string>;
  /**
   * Path parameter name to a resource that tenant B owns. Required for every path with two or more
   * parameters: the helper mixes A's and B's ids to find a handler that checks only one of them.
   */
  idsB?: Record<string, string>;
  /** Credentials for a tenant, such as a bearer token header. Tenant A and B must get different ones. */
  headersFor: (tenant: TenantFixture) => Record<string, string>;
  /** Credential header names to strip for the anonymous probe, besides `credentialHeaderNames`. */
  extraCredentialHeaders?: string[];
  /** Endpoints to run. Defaults to `endpointsOf(serviceId)`. For tests of the helper itself. */
  endpoints?: Endpoint[];
  /** A request body for endpoints that need one to reach the lookup (optional). */
  payloadFor?: (endpoint: Endpoint) => unknown;
  /**
   * What tenant A's own request must return, per `METHOD /path` key. Default: any 2xx. Give a status
   * or a list for an endpoint that answers 202 or 204 (or that is meant to answer 4xx to a valid probe).
   */
  expectAsA?: Record<string, number | number[]>;
  /**
   * Strings that must not appear in any body returned to tenant B or to an anonymous caller. The values
   * of `ids` are always checked. Default: tenant A's name, tenant A's bid name and tenant A's admin email.
   */
  markers?: string[];
  /**
   * Called before the requests of each endpoint. A mutating endpoint (DELETE, or a POST that consumes
   * the row) changes tenant A's data when tenant A's own request runs; use this to put it back.
   */
  reset?: (endpoint: Endpoint) => void | Promise<void>;
}

export type FailureKind =
  | 'unmapped-param'
  | 'missing-idsB'
  | 'broken-control'
  | 'cross-tenant-leak'
  | 'anonymous-leak'
  | 'body-leak'
  | 'request-error';

export interface Failure {
  kind: FailureKind;
  endpoint: string;
  detail: string;
}

export interface MixedResult {
  url: string;
  statusCode: number | null;
}

export interface EndpointResult {
  endpoint: string;
  url: string;
  /** Tenant A's own request (the positive control). */
  asTenantA: number | null;
  asTenantB: number | null;
  noCredentials: number | null;
  /** For paths with 2 or more parameters: exactly one of A's ids, the rest B's, sent as B. */
  mixed: MixedResult[];
  ok: boolean;
}

export interface CrossTenantReport {
  serviceId: string;
  publicEndpoints: string[];
  checked: EndpointResult[];
  failures: Failure[];
  /** Plain-words summary, such as "no non-public endpoints; nothing to check". */
  summary: string;
}

export class CrossTenantError extends AggregateError {
  readonly report: CrossTenantReport;
  constructor(report: CrossTenantReport) {
    const lines = report.failures.map((f) => `  ${f.kind}: ${f.endpoint}: ${f.detail}`);
    super(
      report.failures.map((f) => new Error(`${f.kind}: ${f.endpoint}: ${f.detail}`)),
      `Cross-tenant check failed for ${report.serviceId} (${report.failures.length} problem${report.failures.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
    this.name = 'CrossTenantError';
    this.report = report;
  }
}

function fill(path: string, ids: Record<string, string | undefined>): { url: string; missing: string[] } {
  const missing: string[] = [];
  const url = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const id = ids[name];
    if (id === undefined || id === '') {
      missing.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(id);
  });
  return { url, missing };
}

function stripCredentials(headers: Record<string, string>, extra: ReadonlyArray<string>): Record<string, string> {
  const drop = new Set([...credentialHeaderNames, ...extra].map((n) => n.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase())));
}

function isExpectedAsA(status: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return status >= 200 && status < 300;
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

/**
 * For every non-public endpoint:
 * - as tenant B with tenant A's ids: expect 404;
 * - with no credentials: expect 401;
 * - for a path with 2 or more parameters, as tenant B with exactly one of A's ids and the rest B's own
 *   (`idsB`): expect 404, so a handler that checks one id and loads the other alone is caught;
 * - as tenant A with A's ids (the positive control, sent last): expect 2xx, or `expectAsA`. Without this
 *   a service that answers 404 to everyone, or ids that do not exist, would pass;
 * - no B or anonymous body may contain a value of `ids` or a marker.
 * An id missing from `ids` (or `idsB` for a multi-parameter path) is a failure, not a skip. A request that
 * throws is a `request-error`. Throws CrossTenantError (an AggregateError with `report`) listing every
 * problem; returns the report when clean.
 */
export async function runCrossTenant(opts: RunCrossTenantOptions): Promise<CrossTenantReport> {
  const fixtures = opts.fixtures ?? FIXTURES;
  const endpoints = opts.endpoints ?? endpointsOf(opts.serviceId);
  const report: CrossTenantReport = {
    serviceId: opts.serviceId,
    publicEndpoints: endpoints.filter((e) => e.public).map(endpointKey),
    checked: [],
    failures: [],
    summary: '',
  };
  const targets = endpoints.filter((e) => !e.public);
  const markers = [
    ...Object.values(opts.ids).filter((v) => v !== ''),
    ...(opts.markers ?? [fixtures.a.name, fixtures.a.bid.name, fixtures.a.admin.email]),
  ].filter((m) => m !== '');

  for (const e of targets) {
    const key = endpointKey(e);
    const fail = (kind: FailureKind, detail: string): void => {
      result.ok = false;
      report.failures.push({ kind, endpoint: key, detail });
    };
    const { url, missing } = fill(e.path, opts.ids);
    const result: EndpointResult = { endpoint: key, url, asTenantA: null, asTenantB: null, noCredentials: null, mixed: [], ok: true };
    report.checked.push(result);
    if (missing.length > 0) {
      fail('unmapped-param', `no id for path parameter ${missing.map((m) => `{${m}}`).join(', ')}`);
      continue;
    }
    const missingB = e.params.length >= 2 ? e.params.filter((p) => !opts.idsB?.[p]) : [];
    if (missingB.length > 0) {
      fail('missing-idsB', `no tenant B id for path parameter ${missingB.map((m) => `{${m}}`).join(', ')}`);
      continue;
    }

    const payload = opts.payloadFor?.(e);
    const send = async (label: string, requestUrl: string, headers: Record<string, string>): Promise<InjectResponse | null> => {
      try {
        return await opts.inject({ method: e.method, url: requestUrl, headers, ...(payload === undefined ? {} : { payload }) });
      } catch (error) {
        fail('request-error', `${requestUrl} ${label} threw: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    const checkBody = (label: string, requestUrl: string, res: InjectResponse): void => {
      const body = res.body.toLowerCase();
      const hit = markers.find((m) => body.includes(m.toLowerCase()));
      if (hit !== undefined) fail('body-leak', `${requestUrl} ${label} returned a body that contains ${JSON.stringify(hit)}`);
    };

    await opts.reset?.(e);
    const headersB = opts.headersFor(fixtures.b);

    const asB = await send(`as ${fixtures.b.name}`, url, headersB);
    if (asB) {
      result.asTenantB = asB.statusCode;
      if (asB.statusCode !== 404) fail('cross-tenant-leak', `${url} as ${fixtures.b.name} returned ${asB.statusCode}, expected 404`);
      checkBody(`as ${fixtures.b.name}`, url, asB);
    }

    const anon = await send('with no credentials', url, stripCredentials(headersB, opts.extraCredentialHeaders ?? []));
    if (anon) {
      result.noCredentials = anon.statusCode;
      if (anon.statusCode !== 401) fail('anonymous-leak', `${url} with no credentials returned ${anon.statusCode}, expected 401`);
      checkBody('with no credentials', url, anon);
    }

    if (e.params.length >= 2) {
      for (const own of e.params) {
        const mixedUrl = fill(e.path, Object.fromEntries(e.params.map((p) => [p, p === own ? opts.ids[p] : opts.idsB?.[p]]))).url;
        const res = await send(`as ${fixtures.b.name}`, mixedUrl, headersB);
        result.mixed.push({ url: mixedUrl, statusCode: res?.statusCode ?? null });
        if (!res) continue;
        if (res.statusCode !== 404) {
          fail('cross-tenant-leak', `${mixedUrl} as ${fixtures.b.name} (only {${own}} is ${fixtures.a.name}'s) returned ${res.statusCode}, expected 404`);
        }
        checkBody(`as ${fixtures.b.name}`, mixedUrl, res);
      }
    }

    // Last, because an endpoint that deletes or consumes the row would make the probes above meaningless.
    const asA = await send(`as ${fixtures.a.name}`, url, opts.headersFor(fixtures.a));
    if (asA) {
      result.asTenantA = asA.statusCode;
      const expected = opts.expectAsA?.[key];
      if (!isExpectedAsA(asA.statusCode, expected)) {
        const want = expected === undefined ? 'a 2xx status' : Array.isArray(expected) ? expected.join(' or ') : String(expected);
        fail('broken-control', `${url} as ${fixtures.a.name} returned ${asA.statusCode}, expected ${want}; the ids or the path may be wrong, so the checks above prove nothing`);
      }
    }
  }

  report.summary = targets.length === 0
    ? 'no non-public endpoints; nothing to check'
    : `${targets.length} non-public endpoint${targets.length === 1 ? '' : 's'} checked, ${report.failures.length} problem${report.failures.length === 1 ? '' : 's'}`;
  if (report.failures.length > 0) throw new CrossTenantError(report);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Database level

/** What assertRlsIsolation needs: a pool, or one connection. `pg.Pool`, `pg.PoolClient` and `pg.Client` fit. */
type Queryable = Pick<PoolClient, 'query'>;

export interface AssertRlsOptions {
  /** A pool or a connection that logs in as the app role. A superuser or BYPASSRLS role skips RLS and will fail the check. */
  pool?: Pick<Pool, 'connect'>;
  client?: Queryable;
  /** Table name, with an optional schema, such as `bids` or `identity.outbox`. */
  table: string;
  /** The column the policy checks, such as `org_id` or `tenant_id`. */
  tenantColumn: string;
  /** Primary key column. Defaults to `id`. */
  idColumn?: string;
  /** Row ids owned by tenant A. */
  idsA: string[];
  tenantB: string;
  /** Owner of `idsA`. The ids must be visible to this tenant first, so the check cannot pass on ids that do not exist. */
  tenantA: string;
}

export interface RlsIsolationResult {
  selectedAsB: number;
  updatedAsB: number;
  deletedAsB: number;
  /** How many of `idsA` tenant A could see (always all of them, or the check throws). */
  visibleToA: number;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Not a safe identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

function quoteTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2) throw new Error(`Not a safe table name: ${JSON.stringify(table)}`);
  return parts.map(quoteIdent).join('.');
}

export class RlsLeakError extends Error {
  constructor(message: string, readonly result: Partial<RlsIsolationResult>) {
    super(message);
    this.name = 'RlsLeakError';
  }
}

async function asTenant<T>(c: Queryable, tenantId: string, fn: () => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('assertRlsIsolation needs tenant ids as uuids');
  await c.query('BEGIN');
  try {
    // The same pair withTenant sets: PD reads app.org_id, the E2E services read app.tenant_id.
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.org_id', $1, true)", [tenantId]);
    return await fn();
  } finally {
    // Always roll back: a leaking update or delete must not change data.
    await c.query('ROLLBACK');
  }
}

/**
 * As tenant B, selecting tenant A's ids returns 0 rows, and updating or deleting them affects 0 rows.
 * Throws RlsLeakError otherwise. Every statement runs in a transaction that is rolled back.
 */
export async function assertRlsIsolation(opts: AssertRlsOptions): Promise<RlsIsolationResult> {
  if (!opts.tenantA) throw new Error('assertRlsIsolation needs tenantA, the owner of idsA');
  if (opts.idsA.length === 0) throw new Error('assertRlsIsolation needs at least one id of tenant A');
  if (opts.idsA.some((id) => !UUID.test(id))) throw new Error('assertRlsIsolation needs ids as uuids');
  const table = quoteTable(opts.table);
  const idCol = quoteIdent(opts.idColumn ?? 'id');
  const tenantCol = quoteIdent(opts.tenantColumn);

  const run = async (c: Queryable): Promise<RlsIsolationResult> => {
    const visibleToA = await asTenant(c, opts.tenantA, async () =>
      (await c.query(`select count(*)::int as n from ${table} where ${idCol} = any($1::uuid[])`, [opts.idsA])).rows[0].n as number);
    if (visibleToA !== opts.idsA.length) {
      throw new RlsLeakError(`${opts.table}: tenant A sees ${visibleToA} of its ${opts.idsA.length} ids, so the check would prove nothing`, { visibleToA });
    }
    return asTenant(c, opts.tenantB, async () => {
      const sel = (await c.query(`select ${idCol} from ${table} where ${idCol} = any($1::uuid[])`, [opts.idsA])).rowCount ?? 0;
      const upd = (await c.query(`update ${table} set ${tenantCol} = ${tenantCol} where ${idCol} = any($1::uuid[])`, [opts.idsA])).rowCount ?? 0;
      const del = (await c.query(`delete from ${table} where ${idCol} = any($1::uuid[])`, [opts.idsA])).rowCount ?? 0;
      const result = { selectedAsB: sel, updatedAsB: upd, deletedAsB: del, visibleToA };
      if (sel !== 0 || upd !== 0 || del !== 0) {
        throw new RlsLeakError(`${opts.table}: tenant B reached tenant A's rows (select ${sel}, update ${upd}, delete ${del})`, result);
      }
      return result;
    });
  };

  if (opts.client) return run(opts.client);
  if (!opts.pool) throw new Error('assertRlsIsolation needs a pool or a client');
  const client = await opts.pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}
