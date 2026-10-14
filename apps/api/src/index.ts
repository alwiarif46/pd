import { assertTenantRole } from '@pd/core';
import { buildApp } from './app.js';

const fastify = await buildApp();

const start = async () => {
  try {
    // Tenant isolation depends on row-level security, which a superuser or BYPASSRLS
    // role skips. Refuse to serve in production as such a role; warn elsewhere.
    try {
      await assertTenantRole();
    } catch (error) {
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      fastify.log.warn(error instanceof Error ? error.message : error);
    }
    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`API server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
