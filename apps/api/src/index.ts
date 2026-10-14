import { buildApp } from './app.js';

const start = async () => {
  // buildApp refuses a database role that skips row-level security (see app.ts).
  const fastify = await buildApp();
  try {
    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`API server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
