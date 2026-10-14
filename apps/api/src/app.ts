import Fastify, { type FastifyInstance } from 'fastify';
import { enforceTenantRole } from '@pd/core';
import { registerAmendments } from './amendments.js';
import { registerAuth } from './auth.js';
import { registerBids } from './bids.js';
import { registerDocuments } from './documents.js';
import { registerJobs } from './jobs.js';
import { registerOrg } from './org.js';
import { registerTabs } from './tabs.js';
import { registerUploads } from './uploads.js';

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: options.logger ?? true,
  });

  // Tenant isolation depends on row-level security, which a superuser or BYPASSRLS role
  // skips. Refuse to build the app as such a role unless PD_ALLOW_BYPASS_RLS=1.
  await enforceTenantRole((message) => fastify.log.warn(message));

  await fastify.register(import('@fastify/cors'), {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  await registerAuth(fastify);
  await registerOrg(fastify);
  await registerBids(fastify);
  await registerUploads(fastify);
  await registerDocuments(fastify);
  await registerJobs(fastify);
  await registerAmendments(fastify);
  await registerTabs(fastify);

  return fastify;
}
