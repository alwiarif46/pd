import type { FastifyInstance } from 'fastify';
import { createServiceApp, type ServiceDb } from '@pd/service-kit';

export const SERVICE_ID = 'drive';
export const VERSION = '0.1.0';

export function buildApp(db?: ServiceDb): FastifyInstance {
  return createServiceApp({ id: SERVICE_ID, version: VERSION, ...(db ? { db } : {}) });
}
