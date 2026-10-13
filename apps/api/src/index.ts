import Fastify from 'fastify';

const fastify = Fastify({
  logger: true,
});

// CORS
await fastify.register(import('@fastify/cors'), {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Start server
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
