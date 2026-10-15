import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool } from '@pd/core';
import { activeModel } from '@pd/ai';

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('GET /api/about/processing', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 2 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it('answers without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/about/processing' });
    expect(response.statusCode).toBe(200);
  });

  it('answers a request with a bogus token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/about/processing',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns only the provider, the model in use, the subprocessors, and the privacy path', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/about/processing' })).json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['model', 'privacyPath', 'provider', 'subprocessors']);
    expect(body.model).toBe(activeModel());
    expect(body).not.toHaveProperty('orgId');
    expect(body).not.toHaveProperty('org');
  });
});
