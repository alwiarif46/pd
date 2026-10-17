import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { routes } from '../src/routes';

describe('intel skeleton', () => {
  it('answers GET /healthz with its id', async () => {
    const app = buildApp();
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: 'intel', version: '0.1.0', schemaMigration: 'none' });
    await app.close();
  });

  it('lists /healthz and every route once (the handlers come in the service PRs)', () => {
    expect(routes).toContainEqual({ method: 'GET', path: '/healthz' });
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
