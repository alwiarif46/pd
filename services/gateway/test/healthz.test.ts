import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool } from '@pd/core';

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('GET /healthz', () => {
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

  it('returns the standard shape without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'gateway', version: '0.1.0', schemaMigration: 'none' });
  });

  it('keeps the old /health route', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ok');
  });
});
