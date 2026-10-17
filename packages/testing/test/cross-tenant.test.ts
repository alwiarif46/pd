import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRlsIsolation, credentialHeaderNames, CrossTenantError, endpointsOf, type Endpoint, PUBLIC_ENDPOINTS, runCrossTenant, type Inject } from '../src/cross-tenant';
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
  app.get('/leaky/:thing_id', async () => ({ ok: true }));
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
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
      { endpoint: 'GET /bids/{bid_id}', url: `/bids/${TENANT_A.bid.id}`, asTenantA: 200, asTenantB: 404, noCredentials: 401, mixed: [], ok: true },
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
      if (!req.headers.authorization) return { statusCode: 401, body: '' };
      return { statusCode: req.headers.authorization === 'Bearer token-a' ? 200 : 404, body: '' };
    };
    await runCrossTenant({ serviceId: 'identity', endpoints, inject, ids: { bid_id: TENANT_A.bid.id }, headersFor, payloadFor: (e) => (e.method === 'DELETE' ? { x: 1 } : undefined) });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'GET', 'GET', 'DELETE', 'DELETE', 'DELETE']);
    expect(seen.filter((s) => s.method === 'DELETE').every((s) => (s.payload as { x: number }).x === 1)).toBe(true);
  });

  it('says there is nothing to check when the service has only /healthz', async () => {
    const report = await runCrossTenant({ serviceId: 'identity', inject: async () => { throw new Error('no request expected'); }, ids: {}, headersFor });
    expect(report.summary).toBe('no non-public endpoints; nothing to check');
    expect(report.checked).toEqual([]);
  });
});

/** A fake service for the positive control, the body checks and the nested routes. */
function richApp(): FastifyInstance {
  const app = Fastify();
  const DOC_OF: Record<string, string> = { 'doc-a': TENANT_A.id, 'doc-b': TENANT_B.id };
  app.addHook('onRequest', async (req, reply) => {
    const tenant = TOKENS[(req.headers.authorization ?? '').replace('Bearer ', '')];
    if (!tenant) return reply.code(401).send({ error: 'no' });
    (req as unknown as { tenant: TenantFixture }).tenant = tenant;
  });
  const tenantOf = (req: unknown) => (req as { tenant: TenantFixture }).tenant;
  app.get('/bids/:bid_id', async (req, reply) =>
    BID_OF[(req.params as { bid_id: string }).bid_id] === tenantOf(req).id ? { ok: true } : reply.code(404).send({ error: 'not found' }));
  app.delete('/bids/:bid_id', async (req, reply) =>
    BID_OF[(req.params as { bid_id: string }).bid_id] === tenantOf(req).id ? reply.code(204).send() : reply.code(404).send({ error: 'not found' }));
  // Always 404, for everyone: a route a typo or a wrong id would also look like.
  app.get('/gone/:bid_id', async (_req, reply) => reply.code(404).send({ error: 'not found' }));
  // 404s correctly but echoes what it was asked for.
  app.get('/echo/:bid_id', async (req, reply) => reply.code(404).send({ error: `bid ${(req.params as { bid_id: string }).bid_id} not found` }));
  app.get('/chatty/:bid_id', async (req, reply) => (BID_OF[(req.params as { bid_id: string }).bid_id] === tenantOf(req).id ? { ok: true } : reply.code(404).send({ error: `no such bid for ${TENANT_A.admin.email}` })));
  // Nested: checks the bid, then loads the document by its id alone.
  app.get('/bids/:bid_id/docs/:doc_id', async (req, reply) => {
    const { bid_id, doc_id } = req.params as { bid_id: string; doc_id: string };
    if (BID_OF[bid_id] !== tenantOf(req).id) return reply.code(404).send({ error: 'not found' });
    return DOC_OF[doc_id] ? { id: doc_id } : reply.code(404).send({ error: 'not found' });
  });
  // Nested and correct: the document must belong to the caller too.
  app.get('/safe/:bid_id/docs/:doc_id', async (req, reply) => {
    const { bid_id, doc_id } = req.params as { bid_id: string; doc_id: string };
    if (BID_OF[bid_id] !== tenantOf(req).id || DOC_OF[doc_id] !== tenantOf(req).id) return reply.code(404).send({ error: 'not found' });
    return { id: doc_id };
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  return app;
}

describe('runCrossTenant: positive control', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });
  const run = async (endpoints: Endpoint[], extra: Partial<Parameters<typeof runCrossTenant>[0]> = {}) => {
    app = richApp();
    return runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id, doc_id: 'doc-a' }, headersFor, ...extra })
      .then(() => null, (e: unknown) => e as CrossTenantError);
  };

  it('fails a route that answers 404 to everyone, tenant A included', async () => {
    const err = await run(ep('/gone/{bid_id}', 'GET'));
    expect(err).toBeInstanceOf(CrossTenantError);
    expect(err!.report.failures).toHaveLength(1);
    expect(err!.report.failures[0]).toMatchObject({ kind: 'broken-control', endpoint: 'GET /gone/{bid_id}' });
    expect(err!.report.failures[0]?.detail).toContain('returned 404');
    expect(err!.report.checked[0]).toMatchObject({ asTenantA: 404, asTenantB: 404, noCredentials: 401, ok: false });
  });

  it('fails ids that do not exist, because tenant A cannot reach them either', async () => {
    const err = await run(ep('/bids/{bid_id}', 'GET'), { ids: { bid_id: 'no-such-bid' } });
    expect(err!.report.failures.map((f) => f.kind)).toEqual(['broken-control']);
  });

  it('fails a path that does not match any route', async () => {
    const err = await run(ep('/bidz/{bid_id}', 'GET'));
    expect(err!.report.failures.map((f) => f.kind)).toEqual(['broken-control']);
  });

  it('expects 2xx from tenant A by default and the per-endpoint status when given', async () => {
    const endpoints = ep('/bids/{bid_id}', 'DELETE');
    expect((await run(endpoints))).toBeNull(); // 204 is 2xx
    const err = await run(endpoints, { expectAsA: { 'DELETE /bids/{bid_id}': 202 } });
    expect(err!.report.failures).toHaveLength(1);
    expect(err!.report.failures[0]).toMatchObject({ kind: 'broken-control', endpoint: 'DELETE /bids/{bid_id}' });
    expect(err!.report.failures[0]?.detail).toContain('as Tenant A returned 204, expected 202');
    expect(await run(endpoints, { expectAsA: { 'DELETE /bids/{bid_id}': 204 } })).toBeNull();
  });

  it('accepts a list of statuses in expectAsA', async () => {
    expect(await run(ep('/bids/{bid_id}', 'DELETE'), { expectAsA: { 'DELETE /bids/{bid_id}': [202, 204] } })).toBeNull();
  });

  it('sends tenant A last for each endpoint, after a reset', async () => {
    app = richApp();
    const order: string[] = [];
    const inner = injectOn(app);
    const inject: Inject = async (req) => {
      order.push(req.headers.authorization ?? 'anon');
      return inner(req);
    };
    await runCrossTenant({
      serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET'), inject, ids: { bid_id: TENANT_A.bid.id }, headersFor,
      reset: () => { order.push('reset'); },
    });
    expect(order).toEqual(['reset', 'Bearer token-b', 'anon', 'Bearer token-a']);
  });
});

describe('runCrossTenant: response bodies', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });
  const run = async (endpoints: Endpoint[], extra: Partial<Parameters<typeof runCrossTenant>[0]> = {}) => {
    app = richApp();
    return runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id }, headersFor, ...extra })
      .then(() => null, (e: unknown) => e as CrossTenantError);
  };

  it('fails a 404 that echoes tenant A\'s id', async () => {
    const err = await run(ep('/echo/{bid_id}', 'GET'), { expectAsA: { 'GET /echo/{bid_id}': 404 } });
    expect(err!.report.failures.map((f) => f.kind)).toEqual(['body-leak']);
    expect(err!.report.failures[0]?.detail).toContain(TENANT_A.bid.id);
  });

  it('fails a 404 that names tenant A\'s admin email, a default marker', async () => {
    const err = await run(ep('/chatty/{bid_id}', 'GET'));
    expect(err!.report.failures.map((f) => f.kind)).toEqual(['body-leak']);
    expect(err!.report.failures[0]?.detail).toContain(TENANT_A.admin.email);
  });

  it('checks caller-supplied markers too', async () => {
    expect(await run(ep('/bids/{bid_id}', 'GET'), { markers: ['not found'] })).toBeInstanceOf(CrossTenantError);
    expect(await run(ep('/bids/{bid_id}', 'GET'), { markers: ['Acme Corp'] })).toBeNull();
  });

  it('fails an anonymous 401 whose body names tenant A', async () => {
    app = richApp();
    const inner = injectOn(app);
    const inject: Inject = async (req) => {
      const res = await inner(req);
      return req.headers.authorization ? res : { ...res, body: `sign in to ${TENANT_A.name}` };
    };
    const err = await runCrossTenant({ serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET'), inject, ids: { bid_id: TENANT_A.bid.id }, headersFor })
      .catch((e: unknown) => e as CrossTenantError);
    expect((err as CrossTenantError).report.failures.map((f) => f.kind)).toEqual(['body-leak']);
  });
});

describe('runCrossTenant: several path parameters', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });
  const idsB = { bid_id: TENANT_B.bid.id, doc_id: 'doc-b' };
  const run = async (endpoints: Endpoint[], extra: Partial<Parameters<typeof runCrossTenant>[0]> = {}) => {
    app = richApp();
    return runCrossTenant({ serviceId: 'identity', endpoints, inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id, doc_id: 'doc-a' }, idsB, headersFor, ...extra })
      .then((r) => r, (e: unknown) => e as CrossTenantError);
  };

  it('catches the nested IDOR: the bid is checked, the document is loaded by id alone', async () => {
    const err = (await run(ep('/bids/{bid_id}/docs/{doc_id}', 'GET'))) as CrossTenantError;
    expect(err).toBeInstanceOf(CrossTenantError);
    // The leaking combination also echoes A's document id, so the body check fires too.
    expect(err.report.failures.map((f) => f.kind)).toEqual(['cross-tenant-leak', 'body-leak']);
    expect(err.report.failures[0]).toMatchObject({ endpoint: 'GET /bids/{bid_id}/docs/{doc_id}' });
    expect(err.report.failures[0]?.detail).toContain(`/bids/${TENANT_B.bid.id}/docs/doc-a`);
    expect(err.report.failures[0]?.detail).toContain('returned 200');
  });

  it('passes a nested route that checks every parameter, and reports each combination', async () => {
    const report = (await run(ep('/safe/{bid_id}/docs/{doc_id}', 'GET'))) as Awaited<ReturnType<typeof runCrossTenant>>;
    expect(report.failures).toEqual([]);
    expect(report.checked[0]?.mixed).toEqual([
      { url: `/safe/${TENANT_A.bid.id}/docs/doc-b`, statusCode: 404 },
      { url: `/safe/${TENANT_B.bid.id}/docs/doc-a`, statusCode: 404 },
    ]);
  });

  it('fails when idsB is missing for a multi-parameter path', async () => {
    const err = (await run(ep('/safe/{bid_id}/docs/{doc_id}', 'GET'), { idsB: { bid_id: TENANT_B.bid.id } })) as CrossTenantError;
    expect(err.report.failures).toEqual([
      { kind: 'missing-idsB', endpoint: 'GET /safe/{bid_id}/docs/{doc_id}', detail: 'no tenant B id for path parameter {doc_id}' },
    ]);
  });

  it('does not need idsB for single-parameter paths', async () => {
    app = richApp();
    const report = await runCrossTenant({ serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET'), inject: injectOn(app), ids: { bid_id: TENANT_A.bid.id }, headersFor });
    expect(report.checked[0]?.mixed).toEqual([]);
  });
});

describe('runCrossTenant: requests', () => {
  it('strips only credentials from the anonymous request and keeps content-type and accept', async () => {
    const seen: Array<Record<string, string>> = [];
    const inject: Inject = async (req) => {
      seen.push(req.headers);
      const a = req.headers['x-test-tenant'] === TENANT_A.id;
      const none = !req.headers.Authorization && !req.headers.cookie && !req.headers['x-test-tenant'];
      return { statusCode: none ? 401 : a ? 200 : 404, body: '' };
    };
    await runCrossTenant({
      serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET'), inject, ids: { bid_id: TENANT_A.bid.id },
      headersFor: (t) => ({ Authorization: 'Bearer x', Cookie: 'sid=1', 'X-Test-Tenant': t.id, 'x-custom-key': 'k', 'content-type': 'application/json', accept: 'application/json' }),
    }).catch(() => undefined);
    const anon = seen[1]!;
    expect(Object.keys(anon).sort()).toEqual(['accept', 'content-type', 'x-custom-key']);
    expect(credentialHeaderNames).toEqual(expect.arrayContaining(['authorization', 'cookie', 'x-test-tenant']));
  });

  it('strips extra credential headers named by the caller', async () => {
    const seen: Array<Record<string, string>> = [];
    const inject: Inject = async (req) => { seen.push(req.headers); return { statusCode: 401, body: '' }; };
    await runCrossTenant({
      serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET'), inject, ids: { bid_id: 'x' },
      headersFor: () => ({ 'x-session': 's', accept: 'a' }), extraCredentialHeaders: ['X-Session'],
    }).catch(() => undefined);
    expect(seen[1]).toEqual({ accept: 'a' });
  });

  it('records a request that throws as request-error and carries on', async () => {
    const inject: Inject = async (req) => {
      if (!req.headers.authorization) throw new Error('socket hang up');
      return { statusCode: req.headers.authorization === 'Bearer token-a' ? 200 : 404, body: '' };
    };
    const err = (await runCrossTenant({ serviceId: 'identity', endpoints: ep('/bids/{bid_id}', 'GET', 'DELETE'), inject, ids: { bid_id: TENANT_A.bid.id }, headersFor })
      .catch((e: unknown) => e)) as CrossTenantError;
    expect(err.report.failures.map((f) => f.kind)).toEqual(['request-error', 'request-error']);
    expect(err.report.failures[0]?.detail).toContain('socket hang up');
    expect(err.report.checked.map((c) => c.noCredentials)).toEqual([null, null]);
  });
});

describe('assertRlsIsolation arguments', () => {
  it('requires tenantA, the owner of the ids', async () => {
    const client = { query: async () => { throw new Error('no query expected'); } };
    await expect(
      assertRlsIsolation({ client: client as never, table: 'bids', tenantColumn: 'org_id', idsA: [TENANT_A.bid.id], tenantB: TENANT_B.id } as never),
    ).rejects.toThrow(/needs tenantA/);
  });
});
