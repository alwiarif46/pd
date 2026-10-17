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

export interface RunCrossTenantOptions {
  serviceId: string;
  inject: Inject;
  /** Tenant A (owner of the ids) and tenant B (the caller). Defaults to the shared fixtures. */
  fixtures?: TenantPair;
  /** Path parameter name to tenant A's id for that kind of resource. */
  ids: Record<string, string>;
  /** Credentials for a tenant, such as a bearer token header. */
  headersFor: (tenant: TenantFixture) => Record<string, string>;
  /** Endpoints to run. Defaults to `endpointsOf(serviceId)`. For tests of the helper itself. */
  endpoints?: Endpoint[];
  /** A request body for endpoints that need one to reach the lookup (optional). */
  payloadFor?: (endpoint: Endpoint) => unknown;
}

export type FailureKind = 'unmapped-param' | 'cross-tenant-leak' | 'anonymous-leak';

export interface Failure {
  kind: FailureKind;
  endpoint: string;
  detail: string;
}

export interface EndpointResult {
  endpoint: string;
  url: string;
  asTenantB: number | null;
  noCredentials: number | null;
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

function fill(path: string, ids: Record<string, string>): { url: string; missing: string[] } {
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

/**
 * For every non-public endpoint: send it as tenant B with tenant A's ids and expect 404; send it with
 * no credentials and expect 401. An id missing from `ids` is a failure, not a skip. Throws
 * CrossTenantError (an AggregateError with `report`) listing every problem; returns the report when clean.
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

  for (const e of targets) {
    const key = endpointKey(e);
    const { url, missing } = fill(e.path, opts.ids);
    if (missing.length > 0) {
      report.failures.push({ kind: 'unmapped-param', endpoint: key, detail: `no id for path parameter ${missing.map((m) => `{${m}}`).join(', ')}` });
      report.checked.push({ endpoint: key, url, asTenantB: null, noCredentials: null, ok: false });
      continue;
    }
    const payload = opts.payloadFor?.(e);
    const base = { method: e.method, url, ...(payload === undefined ? {} : { payload }) };
    const asB = await opts.inject({ ...base, headers: opts.headersFor(fixtures.b) });
    const anon = await opts.inject({ ...base, headers: {} });
    let ok = true;
    if (asB.statusCode !== 404) {
      ok = false;
      report.failures.push({ kind: 'cross-tenant-leak', endpoint: key, detail: `${url} as ${fixtures.b.name} returned ${asB.statusCode}, expected 404` });
    }
    if (anon.statusCode !== 401) {
      ok = false;
      report.failures.push({ kind: 'anonymous-leak', endpoint: key, detail: `${url} with no credentials returned ${anon.statusCode}, expected 401` });
    }
    report.checked.push({ endpoint: key, url, asTenantB: asB.statusCode, noCredentials: anon.statusCode, ok });
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
  /** When given, the ids must be visible to this tenant first, so the check cannot pass on ids that do not exist. */
  tenantA?: string;
}

export interface RlsIsolationResult {
  selectedAsB: number;
  updatedAsB: number;
  deletedAsB: number;
  visibleToA: number | null;
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
  if (opts.idsA.length === 0) throw new Error('assertRlsIsolation needs at least one id of tenant A');
  if (opts.idsA.some((id) => !UUID.test(id))) throw new Error('assertRlsIsolation needs ids as uuids');
  const table = quoteTable(opts.table);
  const idCol = quoteIdent(opts.idColumn ?? 'id');
  const tenantCol = quoteIdent(opts.tenantColumn);

  const run = async (c: Queryable): Promise<RlsIsolationResult> => {
    let visibleToA: number | null = null;
    if (opts.tenantA) {
      visibleToA = await asTenant(c, opts.tenantA, async () =>
        (await c.query(`select count(*)::int as n from ${table} where ${idCol} = any($1::uuid[])`, [opts.idsA])).rows[0].n as number);
      if (visibleToA !== opts.idsA.length) {
        throw new RlsLeakError(`${opts.table}: tenant A sees ${visibleToA} of its ${opts.idsA.length} ids, so the check would prove nothing`, { visibleToA });
      }
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
