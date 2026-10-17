import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { openapiPath } from '../scripts/lib';

type Operation = {
  operationId?: string;
  security?: unknown[];
  responses?: Record<string, unknown>;
};
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  security?: unknown[];
  components: { schemas: Record<string, unknown> };
};

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function load(id: string): Doc {
  return parse(readFileSync(openapiPath(id), 'utf8')) as Doc;
}

function operations(doc: Doc): Array<{ method: string; path: string; op: Operation }> {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((method) => ({ method: method.toUpperCase(), path, op: item[method] })),
  );
}

const FILLED = ['identity', 'ingest', 'intel', 'gateway'] as const;

describe.each(FILLED)('%s OpenAPI file', (id) => {
  const doc = load(id);
  const ops = operations(doc);

  it('gives every operation a unique operationId', () => {
    const ids = ops.map(({ op }) => op.operationId);
    expect(ids.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states security on every operation, or inherits a default', () => {
    for (const { method, path, op } of ops) {
      expect(op.security !== undefined || (doc.security?.length ?? 0) > 0, `${method} ${path}`).toBe(true);
    }
  });

  it('answers 401 on secured routes and 404 on routes with an id', () => {
    for (const { method, path, op } of ops) {
      const secured = (op.security ?? doc.security ?? []).length > 0;
      if (secured) expect(op.responses, `${method} ${path} 401`).toHaveProperty('401');
      if (/\{[^}]+\}/.test(path) && secured) expect(op.responses, `${method} ${path} 404`).toHaveProperty('404');
    }
  });

  it('has no password field in any schema', () => {
    expect(JSON.stringify(doc.components.schemas).toLowerCase()).not.toContain('password');
  });
});

describe('gateway OpenAPI file', () => {
  const gateway = load('gateway');
  const gatewayRoutes = new Set(operations(gateway).map(({ method, path }) => `${method} ${path}`));

  it('exposes every public service route under /api', () => {
    // Internal routes stay private. The two job lists are replaced by one composed route.
    const internal = new Set(['/healthz', '/tokens/verify', '/.well-known/jwks.json', '/bids/{id}/jobs']);
    for (const id of ['identity', 'ingest', 'intel']) {
      for (const { method, path } of operations(load(id))) {
        if (internal.has(path)) continue;
        expect(gatewayRoutes.has(`${method} /api${path}`), `${id}: ${method} /api${path}`).toBe(true);
      }
    }
  });

  it('keeps internal routes off the public surface', () => {
    expect(gatewayRoutes.has('POST /api/tokens/verify')).toBe(false);
    expect([...gatewayRoutes].some((r) => r.includes('jwks'))).toBe(false);
  });

  it('has the composed routes and a public /healthz', () => {
    expect(gatewayRoutes.has('GET /api/org')).toBe(true);
    expect(gatewayRoutes.has('GET /api/bids/{id}/jobs')).toBe(true);
    expect(gatewayRoutes.has('GET /api/about/processing')).toBe(true);
    expect(gatewayRoutes.has('GET /healthz')).toBe(true);
  });
});
