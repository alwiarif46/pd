import type { FastifyRequest } from 'fastify';

export type Body = Record<string, unknown>;

export const BODY_REQUIRED = { error: 'Send a JSON object in the request body' } as const;

/** The JSON object body, or null when the body is missing or not an object (answer 400). */
export function readBody(request: FastifyRequest): Body | null {
  const body: unknown = request.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : null;
}

/** A string field, or '' when it is missing or not a string. */
export function text(body: Body, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}
