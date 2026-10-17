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

  it('lists only /healthz', () => {
    expect(routes).toEqual([{ method: 'GET', path: '/healthz' }]);
  });
});
