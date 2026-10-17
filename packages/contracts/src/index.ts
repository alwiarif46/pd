import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { eventNames, type EventName } from './event-names';

export { eventNames, type EventName };

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENVELOPE_ID = 'https://contracts.e2e.local/events/_envelope';
/** The six fields every event carries (09 s2). contracts:check pins the envelope to exactly these. */
export const ENVELOPE_FIELDS = ['event_id', 'tenant_id', 'schema_version', 'occurred_at', 'type', 'payload'] as const;

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

/** The current schema is `<name>.schema.json`. A previous major N is `<name>.v<N>.schema.json`. */
export function eventSchemaPath(name: string, major?: number): string {
  return join(PACKAGE_ROOT, 'events', major === undefined ? `${name}.schema.json` : `${name}.v${major}.schema.json`);
}

export function loadEnvelopeSchema(): EventSchema {
  return readJson<EventSchema>(join(PACKAGE_ROOT, 'events', '_envelope.schema.json'));
}

export function loadEventSchema(name: string, major?: number): EventSchema {
  const path = eventSchemaPath(name, major);
  if (!(eventNames as ReadonlyArray<string>).includes(name) || !existsSync(path)) {
    throw new Error(`Unknown event: ${name}${major === undefined ? '' : ` (major ${major})`}`);
  }
  return readJson<EventSchema>(path);
}

/** The majors that have a `<name>.v<N>.schema.json` file, ascending. */
export function previousMajorsOf(name: string): number[] {
  const prefix = `${name}.v`;
  const majors: number[] = [];
  for (const file of readdirSync(join(PACKAGE_ROOT, 'events'))) {
    const m = file.startsWith(prefix) ? /^(\d+)\.schema\.json$/.exec(file.slice(prefix.length)) : null;
    if (m) majors.push(Number(m[1]));
  }
  return majors.sort((a, b) => a - b);
}

/** The exact current version of an event, from the `x-schema-version` of its current schema. */
export function currentVersionOf(name: string): string {
  const version = loadEventSchema(name)['x-schema-version'];
  if (typeof version !== 'string') throw new Error(`Event ${name} has no x-schema-version`);
  return version;
}

/** A strict Ajv instance that knows the contract keywords. Used by the package and by the check script. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-owner', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-stream', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-schema-version', schemaType: 'string' });
  ajv.addSchema(loadEnvelopeSchema());
  return ajv;
}

let sharedAjv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(name: string, major?: number): ValidateFunction {
  const key = eventSchemaPath(name, major);
  let fn = compiled.get(key);
  if (!fn) {
    sharedAjv ??= createAjv();
    fn = sharedAjv.compile(loadEventSchema(name, major));
    compiled.set(key, fn);
  }
  return fn;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ErrorObject[] };

function versionError(message: string): ValidationResult {
  return {
    valid: false,
    errors: [{ instancePath: '/schema_version', schemaPath: '#/properties/schema_version', keyword: 'schema_version', params: {}, message }],
  };
}

const DOC_VERSION = /^\d+\.\d+$/;

/**
 * Check a document against the event's schema. The schema is chosen by the document's major:
 * the current schema for the current major, `<name>.v<N>.schema.json` for the previous one (BUILD-PLAN s5).
 * Any other major, and a malformed version, is invalid.
 */
export function validateEvent(name: string, doc: unknown): ValidationResult {
  const current = currentVersionOf(name);
  const currentMajor = parseVersion(current).major;
  const version = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).schema_version : undefined;
  let major = currentMajor;
  if (typeof version === 'string' && DOC_VERSION.test(version)) {
    if (!acceptsSchemaVersion(version, supportedMajorsFor(current))) {
      return versionError(`schema_version ${version} is not supported for ${name}: current is ${current}, supported majors are ${supportedMajorsFor(current).join(', ')}`);
    }
    major = parseVersion(version).major;
  }
  if (major !== currentMajor && !previousMajorsOf(name).includes(major)) {
    return versionError(`schema_version ${String(version)} is not supported for ${name}: there is no ${name}.v${major}.schema.json`);
  }
  const fn = validatorFor(name, major === currentMajor ? undefined : major);
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

/**
 * The majors a consumer accepts for a producer at `current`: the current and the previous one (BUILD-PLAN s5).
 * Major 0 and major 1 have no previous-major window, so they accept only their own major.
 */
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
  const occurred = opts.occurredAt ?? new Date();
  return {
    event_id: opts.eventId ?? randomUUID(),
    tenant_id: tenantId,
    schema_version: opts.schemaVersion ?? currentVersionOf(name),
    occurred_at: typeof occurred === 'string' ? occurred : occurred.toISOString(),
    type: name,
    payload,
  };
}
