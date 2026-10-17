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
  components: Record<string, Record<string, unknown>>;
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

  it('defaults to bearer or cookie, and asks cookie writes for the CSRF header', () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);
    for (const { method, path, op } of ops) {
      const cookie = (op.security ?? []).some((x) => 'sessionCookie' in (x as object));
      if (!cookie || method === 'GET') continue;
      expect(JSON.stringify(op), `${method} ${path}`).toContain('#/components/parameters/CsrfHeader');
    }
  });

  it('has no password field in any schema', () => {
    expect(JSON.stringify(doc.components.schemas).toLowerCase()).not.toContain('password');
  });
});

/** Replaces every local $ref by the thing it points at, so two files compare by content. */
function resolve(doc: Doc, node: unknown, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(doc, n, seen));
  if (node && typeof node === 'object') {
    const ref = (node as { $ref?: string }).$ref;
    if (typeof ref === 'string') {
      expect(seen, `circular ${ref}`).not.toContain(ref);
      const [, , section, name] = ref.split('/');
      const target = doc.components[section]?.[name];
      expect(target, ref).toBeDefined();
      return resolve(doc, target, [...seen, ref]);
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(doc, v, seen)]));
  }
  return node;
}

// Not proxied one to one: the gateway builds these, or keeps them private, or words them for its own callers.
const INTERNAL = new Set(['/healthz', '/tokens/verify', '/.well-known/jwks.json', '/internal/zitadel/events']);
const COMPOSED = new Set(['/bids/{id}/jobs']);
const REWORDED = new Set(['/bids/{id}/jobs/{jobId}/retry']);
const BILLING = ['POST /api/billing/checkout', 'POST /api/billing/portal', 'POST /api/billing/webhook'];

describe('gateway OpenAPI file', () => {
  const gateway = load('gateway');
  const gatewayRoutes = new Set(operations(gateway).map(({ method, path }) => `${method} ${path}`));

  it('exposes every public service route under /api', () => {
    for (const id of ['identity', 'ingest', 'intel']) {
      for (const { method, path } of operations(load(id))) {
        if (INTERNAL.has(path) || COMPOSED.has(path)) continue;
        expect(gatewayRoutes.has(`${method} /api${path}`), `${id}: ${method} /api${path}`).toBe(true);
      }
    }
  });

  it('keeps internal routes off the public surface', () => {
    for (const path of INTERNAL) {
      if (path === '/healthz') continue;
      expect([...gatewayRoutes].some((r) => r.endsWith(path) || r.includes('jwks') || r.includes('/internal/')), path).toBe(false);
    }
    expect(gatewayRoutes.has('POST /api/tokens/verify')).toBe(false);
  });

  it('has the composed and billing routes and a public /healthz', () => {
    expect(gatewayRoutes.has('GET /api/org')).toBe(true);
    expect(gatewayRoutes.has('GET /api/bids/{id}/jobs')).toBe(true);
    expect(gatewayRoutes.has('GET /api/about/processing')).toBe(true);
    expect(gatewayRoutes.has('GET /healthz')).toBe(true);
    for (const r of BILLING) expect(gatewayRoutes.has(r), r).toBe(true);
    const webhook = gateway.paths['/api/billing/webhook'].post as Operation & { parameters: Array<{ name: string; required: boolean }> };
    expect(webhook.security).toEqual([]);
    expect(webhook.parameters).toContainEqual(expect.objectContaining({ name: 'Stripe-Signature', required: true }));
    expect((gateway.paths['/api/billing/checkout'].post as Operation & { 'x-upstream': string })['x-upstream']).toBe('billing');
  });

  it('proxies each service route with the same request, responses, parameters, security and operationId', () => {
    const fields = ['operationId', 'parameters', 'requestBody', 'responses', 'security'] as const;
    let compared = 0;
    for (const id of ['identity', 'ingest', 'intel']) {
      const service = load(id);
      for (const { method, path, op } of operations(service)) {
        if (INTERNAL.has(path) || COMPOSED.has(path)) continue;
        const proxied = gateway.paths[`/api${path}`][method.toLowerCase()] as Record<string, unknown>;
        for (const f of fields) {
          expect(resolve(gateway, proxied[f]), `${id} ${method} ${path} ${f}`).toEqual(resolve(service, (op as Record<string, unknown>)[f]));
        }
        expect(proxied['x-upstream'], `${method} ${path}`).toBe(REWORDED.has(path) ? 'intel, ingest' : id);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(40);
  });
});
