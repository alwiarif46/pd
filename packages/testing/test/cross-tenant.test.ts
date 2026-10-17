import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CrossTenantError, endpointsOf, type Endpoint, PUBLIC_ENDPOINTS, runCrossTenant, type Inject } from '../src/cross-tenant';
import { TENANT_A, TENANT_B, type TenantFixture } from '../src/fixtures';

const TOKENS: Record<string, TenantFixture> = { 'token-a': TENANT_A, 'token-b': TENANT_B };
const headersFor = (t: TenantFixture) => ({ authorization: `Bearer ${t === TENANT_A ? 'token-a' : 'token-b'}` });
const BID_OF: Record<string, string> = { [TENANT_A.bid.id]: TENANT_A.id, [TENANT_B.bid.id]: TENANT_B.id };

/** A fake service with two routes. `/bids/:bid_id` is correct; `/leaky/:thing_id` returns the row to anyone who signs in. */
function fakeApp(opts: { leakyWithoutAuth?: boolean } = {}): FastifyInstance {
  const app = Fastify();
  app.get('/healthz', async () => ({ ok: true }));
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const tenant = TOKENS[(req.headers.authorization ?? '').replace('Bearer ', '')];
    if (!tenant && !(opts.leakyWithoutAuth && req.url.startsWith('/leaky/'))) return reply.code(401).send({ error: 'no' });
    (req as unknown as { tenant?: TenantFixture }).tenant = tenant;
  });
  app.get('/bids/:bid_id', async (req, reply) => {
    const tenant = (req as unknown as { tenant: TenantFixture }).tenant;
    const owner = BID_OF[(req.params as { bid_id: string }).bid_id];
    if (owner !== tenant.id) return reply.code(404).send({ error: 'not found' });
    return { id: (req.params as { bid_id: string }).bid_id };
  });
  app.get('/leaky/:thing_id', async (req) => ({ id: (req.params as { thing_id: string }).thing_id }));
  return app;
}

const injectOn = (app: FastifyInstance): Inject => async (req) => {
  const res = await app.inject({
    method: req.method as 'GET',
    url: req.url,
    headers: req.headers,
    ...(req.payload === undefined ? {} : { payload: req.payload as object }),
  });
  return { statusCode: res.statusCode, body: res.body };
};

const HEALTHZ: Endpoint = { method: 'GET', path: '/healthz', params: [], public: true };

function ep(path: string, ...methods: string[]): Endpoint[] {
  return methods.map((m) => ({ method: m, path, params: [...path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1] as string), public: false }));
}

describe('endpointsOf', () => {
  it('reads the OpenAPI file of a service and marks the public endpoints', () => {
    const e = endpointsOf('identity');
    expect(e).toEqual([{ method: 'GET', path: '/healthz', params: [], public: true }]);
    expect(PUBLIC_ENDPOINTS).toEqual(['GET /healthz']);
  });

  it('rejects an id that is not a service name', () => {
    expect(() => endpointsOf('../etc/passwd')).toThrow(/Bad service id/);
  });
});

describe('runCrossTenant with a fake service', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('passes a route that answers 404 to a foreign id and 401 to anonymous callers', async () => {
    app = fakeApp();
    const endpoints = [HEALTHZ, ...ep('/bids/{bid_id}', 'GET')];
    const report = await runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id }, headersFor });
    expect(report.failures).toEqual([]);
    expect(report.checked).toEqual([
      { endpoint: 'GET /bids/{bid_id}', url: `/bids/${TENANT_A.bid.id}`, asTenantB: 404, noCredentials: 401, ok: true },
    ]);
    expect(report.publicEndpoints).toEqual(['GET /healthz']);
  });

  it('reports a leaky route that answers 200 to tenant B', async () => {
    app = fakeApp();
    const endpoints = [...ep('/bids/{bid_id}', 'GET'), ...ep('/leaky/{thing_id}', 'GET')];
    const err = await runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id, thing_id: TENANT_A.id }, headersFor })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err).toBeInstanceOf(CrossTenantError);
    const failures = (err as CrossTenantError).report.failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'cross-tenant-leak', endpoint: 'GET /leaky/{thing_id}' });
    expect(failures[0]?.detail).toContain('returned 200, expected 404');
    expect((err as CrossTenantError).message).toContain('GET /leaky/{thing_id}');
    expect((err as CrossTenantError).message).not.toContain('GET /bids/');
  });

  it('fails an unmapped path parameter instead of skipping it', async () => {
    app = fakeApp();
    const endpoints = [HEALTHZ, ...ep('/bids/{bid_id}', 'GET')];
    const err = (await runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: {}, headersFor }).catch((e: unknown) => e)) as CrossTenantError;
    expect(err).toBeInstanceOf(CrossTenantError);
    expect(err.report.failures).toEqual([
      { kind: 'unmapped-param', endpoint: 'GET /bids/{bid_id}', detail: 'no id for path parameter {bid_id}' },
    ]);
  });

  it('reports an endpoint that answers 200 with no credentials', async () => {
    app = fakeApp({ leakyWithoutAuth: true });
    const endpoints = ep('/leaky/{thing_id}', 'GET');
    const err = (await runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { thing_id: TENANT_A.id }, headersFor }).catch((e: unknown) => e)) as CrossTenantError;
    expect(err.report.failures.map((f) => f.kind).sort()).toEqual(['anonymous-leak', 'cross-tenant-leak']);
    expect(err.report.failures.find((f) => f.kind === 'anonymous-leak')?.detail).toContain('returned 200, expected 401');
  });

  it('lists every problem in one failure', async () => {
    app = fakeApp();
    const endpoints = [...ep('/leaky/{thing_id}', 'GET'), ...ep('/bids/{bid_id}', 'GET')];
    const err = (await runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { thing_id: TENANT_A.id }, headersFor }).catch((e: unknown) => e)) as CrossTenantError;
    expect(err.errors).toHaveLength(2);
    expect(err.report.failures.map((f) => f.kind).sort()).toEqual(['cross-tenant-leak', 'unmapped-param']);
  });

  it('sends the payload from payloadFor and the method of each endpoint', async () => {
    app = fakeApp();
    const seen: Array<{ method: string; payload: unknown }> = [];
    const endpoints = ep('/bids/{bid_id}', 'GET', 'DELETE');
    const inject: Inject = async (req) => {
      seen.push({ method: req.method, payload: req.payload });
      return { statusCode: req.headers.authorization ? 404 : 401, body: '' };
    };
    await runCrossTenant({ serviceId: 'identity', endpoints, inject, ids: { bid_id: TENANT_A.bid.id }, headersFor, payloadFor: (e) => (e.method === 'DELETE' ? { x: 1 } : undefined) });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'GET', 'DELETE', 'DELETE']);
    expect(seen.filter((s) => s.method === 'DELETE').every((s) => (s.payload as { x: number }).x === 1)).toBe(true);
  });

  it('says there is nothing to check when the service has only /healthz', async () => {
    const report = await runCrossTenant({ serviceId: 'identity', inject: async () => { throw new Error('no request expected'); }, ids: {}, headersFor });
    expect(report.summary).toBe('no non-public endpoints; nothing to check');
    expect(report.checked).toEqual([]);
  });
});
