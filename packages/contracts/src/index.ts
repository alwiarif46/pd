import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { eventNames, type EventName } from './event-names';

export { eventNames, type EventName };

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENVELOPE_ID = 'https://contracts.e2e.local/events/_envelope';

export interface ServiceInfo {
  id: string;
  name: string;
  language: 'ts' | 'py';
  folder: string;
  schema: string | null;
  stream_prefix: string | null;
  skeleton: boolean;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const SERVICES: ReadonlyArray<ServiceInfo> = readJson<ServiceInfo[]>(join(PACKAGE_ROOT, 'services.json'));

export interface EventEnvelope<P = Record<string, unknown>> {
  event_id: string;
  tenant_id: string;
  schema_version: string;
  occurred_at: string;
  type: string;
  payload: P;
}

export type EventSchema = Record<string, unknown> & { $id: string };

export function eventSchemaPath(name: string): string {
  return join(PACKAGE_ROOT, 'events', `${name}.schema.json`);
}

export function loadEnvelopeSchema(): EventSchema {
  return readJson<EventSchema>(join(PACKAGE_ROOT, 'events', '_envelope.schema.json'));
}

export function loadEventSchema(name: string): EventSchema {
  const path = eventSchemaPath(name);
  if (!(eventNames as ReadonlyArray<string>).includes(name) || !existsSync(path)) {
    throw new Error(`Unknown event: ${name}`);
  }
  return readJson<EventSchema>(path);
}

/** A strict Ajv instance that knows the contract keywords. Used by the package and by the check script. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-owner', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-stream', schemaType: 'string' });
  ajv.addSchema(loadEnvelopeSchema());
  return ajv;
}

let sharedAjv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(name: string): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    sharedAjv ??= createAjv();
    fn = sharedAjv.compile(loadEventSchema(name));
    compiled.set(name, fn);
  }
  return fn;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ErrorObject[] };

export function validateEvent(name: string, doc: unknown): ValidationResult {
  const fn = validatorFor(name);
  if (fn(doc)) return { valid: true };
  return { valid: false, errors: [...(fn.errors ?? [])] };
}

export interface Version {
  major: number;
  minor: number;
}

export function parseVersion(text: string): Version {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(text);
  if (!m) throw new Error(`Bad version: ${JSON.stringify(text)}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** The majors a consumer accepts for a producer at `current`: the current and the previous one (BUILD-PLAN s5). */
export function supportedMajorsFor(current: string): number[] {
  const { major } = parseVersion(current);
  return major > 1 ? [major, major - 1] : [major];
}

/** True when the document's major is one the consumer supports. A malformed version is not accepted. */
export function acceptsSchemaVersion(docVersion: string, supportedMajors: number[]): boolean {
  try {
    return supportedMajors.includes(parseVersion(docVersion).major);
  } catch {
    return false;
  }
}

export interface MakeEventOptions {
  eventId?: string;
  occurredAt?: Date | string;
  schemaVersion?: string;
}

/** Build a valid envelope for a named event. The schema version comes from the event's own schema. */
export function makeEvent<P extends Record<string, unknown> = Record<string, unknown>>(
  name: EventName,
  tenantId: string,
  payload: P,
  opts: MakeEventOptions = {},
): EventEnvelope<P> {
  const schema = loadEventSchema(name) as { properties?: { schema_version?: { const?: string } } };
  const occurred = opts.occurredAt ?? new Date();
  return {
    event_id: opts.eventId ?? randomUUID(),
    tenant_id: tenantId,
    schema_version: opts.schemaVersion ?? schema.properties?.schema_version?.const ?? '1.0',
    occurred_at: typeof occurred === 'string' ? occurred : occurred.toISOString(),
    type: name,
    payload,
  };
}
