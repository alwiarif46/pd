// Phase 0: the cross-tenant helper runs against every service skeleton (09 s9.4, 08 Phase 0).
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '@pd/contracts';
import { CrossTenantError, endpointsOf, runCrossTenant, type Endpoint, type Inject } from '../src/cross-tenant';
import type { TenantFixture } from '../src/fixtures';
import { repoRoot } from '../src/paths';

/**
 * Path parameter name to tenant A's id, per service. A service adds its entries here in the PR that adds a
 * route with a path parameter. Until then an OpenAPI file that gains a non-public path fails this test.
 */
const IDS_BY_SERVICE: Record<string, Record<string, string>> = {};

/** Skeleton credentials: none exist yet. A placeholder header carries the tenant id, so A and B differ. */
const headersFor = (tenant: TenantFixture) => ({ 'x-test-tenant': tenant.id });

async function loadApp(folder: string): Promise<FastifyInstance> {
  const file = join(repoRoot(), folder, 'src', 'app.ts');
  const mod = (await import(/* @vite-ignore */ file)) as { buildApp?: () => FastifyInstance };
  if (typeof mod.buildApp !== 'function') throw new Error(`${folder}/src/app.ts does not export buildApp`);
  return mod.buildApp();
}

const injectOn = (app: FastifyInstance): Inject => async (req) => {
  const res = await app.inject({ method: req.method as 'GET', url: req.url, headers: req.headers });
  return { statusCode: res.statusCode, body: res.body };
};

const skeletons = SERVICES.filter((s) => s.skeleton);
const tsSkeletons = skeletons.filter((s) => s.language === 'ts');
const pySkeletons = skeletons.filter((s) => s.language === 'py');

describe('service table', () => {
  it('lists the 14 skeletons and the gateway', () => {
    expect(skeletons).toHaveLength(14);
    expect(tsSkeletons).toHaveLength(12);
    expect(pySkeletons.map((s) => s.id).sort()).toEqual(['portal', 'render']);
  });
});

describe.each(tsSkeletons.map((s) => [s.id, s.folder] as const))('%s skeleton', (id, folder) => {
  it('passes the cross-tenant helper with the ids mapped for it', async () => {
    const app = await loadApp(folder);
    try {
      const report = await runCrossTenant({ serviceId: id, inject: injectOn(app), ids: IDS_BY_SERVICE[id] ?? {}, headersFor });
      expect(report.failures).toEqual([]);
      expect(report.publicEndpoints).toEqual(['GET /healthz']);
      expect(report.summary).toBe('no non-public endpoints; nothing to check');
    } finally {
      await app.close();
    }
  });

  it('would fail if its OpenAPI file gained a non-public path with no id mapping', async () => {
    const app = await loadApp(folder);
    try {
      const gained: Endpoint[] = [
        ...endpointsOf(id),
        { method: 'GET', path: '/things/{thing_id}', params: ['thing_id'], public: false },
      ];
      const err = await runCrossTenant({ serviceId: id, endpoints: gained, inject: injectOn(app), ids: IDS_BY_SERVICE[id] ?? {}, headersFor }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrossTenantError);
      expect((err as CrossTenantError).report.failures).toEqual([
        { kind: 'unmapped-param', endpoint: 'GET /things/{thing_id}', detail: 'no id for path parameter {thing_id}' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('would fail on a mapped path that the service does not protect', async () => {
    const app = await loadApp(folder);
    try {
      // The skeleton has no such route, so it answers 404 to everyone, including a caller with no credentials.
      const gained: Endpoint[] = [{ method: 'GET', path: '/things/{thing_id}', params: ['thing_id'], public: false }];
      const err = await runCrossTenant({ serviceId: id, endpoints: gained, inject: injectOn(app), ids: { thing_id: 'a-id' }, headersFor }).catch((e: unknown) => e);
      // Fastify's default 404 body echoes the url, so body-leak joins the two kinds under test.
      expect((err as CrossTenantError).report.failures.map((f) => f.kind)).toEqual(expect.arrayContaining(['anonymous-leak', 'broken-control']));
    } finally {
      await app.close();
    }
  });
});

/**
 * Python routes that are in the OpenAPI file but have no handler yet, per service. The PR that writes a handler
 * deletes its entry here and adds a pytest second-tenant test for it (CLAUDE.md rule 4).
 */
const PY_CONTRACT_ONLY: Record<string, string[]> = {
  render: [
    'GET /tools',
    'POST /tools/{name}',
    'POST /render',
    'GET /render/{renderId}',
    'POST /packages',
    'GET /packages/{packageId}/download',
    'GET /format-specs',
    'GET /format-specs/{specId}',
    'GET /fonts',
    'GET /fonts/requests',
    'POST /fonts/requests',
  ],
};

describe.each(pySkeletons.map((s) => [s.id] as const))('%s skeleton (Python)', (id) => {
  // There is no TypeScript harness for a FastAPI app. Until a pytest equivalent exists (see the README),
  // this test fails when the OpenAPI file gains a non-public path that is not listed as contract only,
  // so a handler without a tenant test cannot slip in.
  it('has no non-public endpoint outside the contract-only list', () => {
    const open = endpointsOf(id).filter((e) => !e.public).map((e) => `${e.method} ${e.path}`);
    expect(open.filter((e) => !(PY_CONTRACT_ONLY[id] ?? []).includes(e))).toEqual([]);
  });

  it('lists only contract-only routes that still exist in the OpenAPI file', () => {
    const all = endpointsOf(id).map((e) => `${e.method} ${e.path}`);
    expect((PY_CONTRACT_ONLY[id] ?? []).filter((e) => !all.includes(e))).toEqual([]);
  });
});

describe('gateway (informational)', () => {
  it('has only the public /healthz in its OpenAPI file; its PD routes are not in the contract yet', () => {
    const endpoints = endpointsOf('gateway');
    expect(endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /healthz']);
    expect(endpoints.filter((e) => !e.public)).toEqual([]);
  });
});
