import Fastify from 'fastify';
import { registerAmendments } from './amendments.js';
import { registerAuth } from './auth.js';
import { registerBids } from './bids.js';
import { registerDocuments } from './documents.js';
import { registerJobs } from './jobs.js';
import { registerOrg } from './org.js';
import { registerTabs } from './tabs.js';
import { registerUploads } from './uploads.js';

const fastify = Fastify({
  logger: true,
});

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

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`API server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
