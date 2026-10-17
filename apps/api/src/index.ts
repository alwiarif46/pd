import { buildApp } from './app.js';
import { installDeliveryFromEnv } from './delivery.js';

const start = async () => {
  // Email (Resend) and SMS (Telnyx) from the environment. Throws on half-set or invalid
  // settings, and with NODE_ENV=production when either channel is missing (delivery.ts);
  // buildApp then refuses production with no delivery installed (security.ts).
  const delivery = installDeliveryFromEnv();
  console.log(`Out-of-band delivery: email ${delivery.email ? 'Resend' : 'off'}, SMS ${delivery.sms ? 'Telnyx' : 'off'}`);
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
