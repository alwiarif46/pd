import { isIP } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { enforceTenantRole } from '@pd/core';
import { registerAmendments } from './amendments.js';
import { registerAuth } from './auth.js';
import { registerBids } from './bids.js';
import { registerDocuments } from './documents.js';
import { registerJobs } from './jobs.js';
import { registerInvites } from './invites.js';
import { registerOrg } from './org.js';
import { assertOutOfBandDelivery } from './security.js';
import { registerTabs } from './tabs.js';
import { registerUploads } from './uploads.js';

const PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * The proxies whose X-Forwarded-For is believed, from PD_TRUST_PROXY: a comma-separated list
 * of IP addresses, CIDR ranges, or the presets loopback, linklocal and uniquelocal. Unset or
 * empty: no proxy is trusted and request.ip is the socket address. `true`, `*` or anything
 * else that is not an address is refused, because trusting every hop lets any client choose
 * the IP the per-IP caps count.
 */
export function trustProxyFromEnv(value = process.env.PD_TRUST_PROXY): string[] | false {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    return false;
  }
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    const prefixOk = prefix === undefined
      || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (!PROXY_PRESETS.has(entry) && (family === 0 || !prefixOk || extra !== undefined)) {
      throw new Error(`PD_TRUST_PROXY: "${entry}" is not an IP address, CIDR range, or loopback/linklocal/uniquelocal.`);
    }
  }
  return entries;
}

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // Signup, resends, resets and invites need a delivery in production.
  assertOutOfBandDelivery();
  const fastify = Fastify({
    logger: options.logger ?? true,
    // Behind nginx or Cloudflare, the per-IP send caps need the client's address, not the proxy's.
    trustProxy: trustProxyFromEnv(),
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
  await registerInvites(fastify);
  await registerBids(fastify);
  await registerUploads(fastify);
  await registerDocuments(fastify);
  await registerJobs(fastify);
  await registerAmendments(fastify);
  await registerTabs(fastify);

  return fastify;
}
