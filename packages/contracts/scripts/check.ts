// pnpm contracts:check. Exits non-zero with one line per failure.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from '@readme/openapi-parser';
import { parse as parseYaml } from 'yaml';
import { ENVELOPE_FIELDS, ENVELOPE_ID, PACKAGE_ROOT, SERVICES, VERSION_PATTERN, createAjv, eventNames, eventSchemaPath, loadEnvelopeSchema, loadEventSchema, type ServiceInfo } from '../src/index';
import { buildGenerated, listFiles, openapiPath } from './lib';

const REPO_ROOT = process.env.CONTRACTS_REPO_ROOT ?? resolve(PACKAGE_ROOT, '..', '..');
const failures: string[] = [];
const fail = (msg: string): void => {
  failures.push(msg);
};
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const serviceIds = SERVICES.map((s) => s.id);

async function checkOpenApi(): Promise<Map<string, Set<string>>> {
  const operations = new Map<string, Set<string>>();
  const files = listFiles(join(PACKAGE_ROOT, 'openapi'), '.yaml');
  for (const id of serviceIds) {
    if (!files.includes(`${id}.yaml`)) fail(`openapi/${id}.yaml: missing`);
  }
  for (const file of files) {
    const id = file.replace(/\.yaml$/, '');
    if (!serviceIds.includes(id)) fail(`openapi/${file}: not a known service id`);
    const path = openapiPath(id);
    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const result = await validate(structuredClone(doc) as never);
      if (!result.valid) {
        for (const e of result.errors) fail(`openapi/${file}: invalid OpenAPI: ${e.message}`);
        continue;
      }
    } catch (err) {
      fail(`openapi/${file}: cannot parse: ${(err as Error).message}`);
      continue;
    }
    const info = doc.info as { version?: unknown } | undefined;
    if (typeof info?.version !== 'string' || !SEMVER.test(info.version)) {
      fail(`openapi/${file}: info.version must be semver, got ${JSON.stringify(info?.version)}`);
    }
    if (doc['x-service'] !== id) fail(`openapi/${file}: x-service is ${JSON.stringify(doc['x-service'])}, expected "${id}"`);
    const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
    if (!paths['/healthz']?.get) fail(`openapi/${file}: no GET /healthz`);
    const ops = new Set<string>();
    for (const [p, item] of Object.entries(paths)) {
      for (const m of METHODS) if (item[m]) ops.add(`${m.toUpperCase()} ${p}`);
    }
    operations.set(id, ops);
  }
  return operations;
}

const EVENT_NAME = /^[a-z]+(\.[a-z_]+){1,2}$/;
const EVENT_FILE = /^(.+?)(?:\.v(0|[1-9]\d*))?\.schema\.json$/;
const VERSION_RE = new RegExp(VERSION_PATTERN);
const ENVELOPE_PROP_SHAPES: Record<string, Record<string, unknown>> = {
  event_id: { type: 'string', format: 'uuid' },
  tenant_id: { type: 'string', format: 'uuid' },
  schema_version: { type: 'string', pattern: VERSION_PATTERN },
  occurred_at: { type: 'string', format: 'date-time' },
  type: { type: 'string' },
  payload: { type: 'object' },
};

function sameList(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function checkEnvelope(): void {
  const label = 'events/_envelope.schema.json';
  let env: Record<string, unknown>;
  try {
    env = loadEnvelopeSchema();
  } catch (err) {
    fail(`${label}: cannot load: ${(err as Error).message}`);
    return;
  }
  if (env.$id !== ENVELOPE_ID) fail(`${label}: $id is ${JSON.stringify(env.$id)}, expected ${ENVELOPE_ID}`);
  if (!sameList(env.required, ENVELOPE_FIELDS)) {
    fail(`${label}: envelope required must be exactly ${ENVELOPE_FIELDS.join(', ')}, got ${JSON.stringify(env.required)}`);
  }
  const props = (env.properties ?? {}) as Record<string, unknown>;
  for (const f of ENVELOPE_FIELDS) {
    if (!(f in props)) fail(`${label}: envelope has no property ${f}`);
    else if (JSON.stringify(props[f]) !== JSON.stringify(ENVELOPE_PROP_SHAPES[f])) {
      fail(`${label}: envelope property ${f} must be ${JSON.stringify(ENVELOPE_PROP_SHAPES[f])}, got ${JSON.stringify(props[f])}`);
    }
  }
}

/** Checks shared by a current schema and a previous-major schema. */
function checkEventSchema(name: string, major: number | undefined, ajv: ReturnType<typeof createAjv>): void {
  const file = major === undefined ? `${name}.schema.json` : `${name}.v${major}.schema.json`;
  const label = `events/${file}`;
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(eventSchemaPath(name, major), 'utf8')) as Record<string, unknown>;
    ajv.compile(schema);
  } catch (err) {
    fail(`${label}: does not compile: ${(err as Error).message}`);
    return;
  }
  const expectedId = `https://contracts.e2e.local/events/${name}${major === undefined ? '' : `.v${major}`}`;
  if (!schema.$id) fail(`${label}: no $id`);
  else if (schema.$id !== expectedId) fail(`${label}: $id is ${String(schema.$id)}, expected ${expectedId}`);
  const owner = schema['x-owner'];
  const svc = SERVICES.find((s) => s.id === owner);
  if (!svc) fail(`${label}: x-owner ${JSON.stringify(owner)} is not a known service id`);
  if (major !== undefined) {
    try {
      const baseOwner = loadEventSchema(name)['x-owner'];
      if (owner !== baseOwner) fail(`${label}: x-owner ${JSON.stringify(owner)} must match ${name}.schema.json (${JSON.stringify(baseOwner)})`);
    } catch (err) {
      fail(`${label}: cannot read ${name}.schema.json to compare x-owner: ${(err as Error).message}`);
    }
  }
  if (schema['x-stream'] !== `e2e.${name}`) {
    fail(`${label}: x-stream is ${JSON.stringify(schema['x-stream'])}, expected "e2e.${name}"`);
  }
  if (svc && !(svc.stream_prefix && (`e2e.${name}`.startsWith(`${svc.stream_prefix}.`) || `e2e.${name}` === svc.stream_prefix))) {
    fail(`${label}: stream e2e.${name} does not start with the prefix of service ${svc.id} (${String(svc.stream_prefix)})`);
  }
  const allOf = schema.allOf;
  if (!Array.isArray(allOf) || JSON.stringify(allOf) !== JSON.stringify([{ $ref: ENVELOPE_ID }])) {
    fail(`${label}: allOf must be exactly [{ "$ref": "${ENVELOPE_ID}" }], got ${JSON.stringify(allOf)}`);
  }
  if (schema.unevaluatedProperties !== false) fail(`${label}: unevaluatedProperties must be false at the top level`);
  for (const key of ['required', 'additionalProperties', 'patternProperties']) {
    if (key in schema) fail(`${label}: top-level ${key} is not allowed; the envelope owns the top-level shape`);
  }
  const props = schema.properties as Record<string, { const?: unknown; type?: unknown; pattern?: unknown }> | undefined;
  for (const key of Object.keys(props ?? {})) {
    if (!(ENVELOPE_FIELDS as ReadonlyArray<string>).includes(key)) {
      fail(`${label}: properties.${key} is not an envelope field (${ENVELOPE_FIELDS.join(', ')}); put event data under payload`);
    }
  }
  if (props?.type?.const !== name) fail(`${label}: properties.type.const must be "${name}"`);

  const version = schema['x-schema-version'];
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    fail(`${label}: x-schema-version must match ${VERSION_PATTERN} (no leading zeros), got ${JSON.stringify(version)}`);
    return;
  }
  const versionMajor = Number(version.split('.')[0]);
  const sv = props?.schema_version;
  const expectedPattern = `^${versionMajor}\\.\\d+$`;
  if (sv?.type !== 'string' || sv?.pattern !== expectedPattern || sv?.const !== undefined) {
    fail(`${label}: properties.schema_version must be { "type": "string", "pattern": ${JSON.stringify(expectedPattern)} } to match x-schema-version ${version}`);
  }
  if (major !== undefined && versionMajor !== major) {
    fail(`${label}: x-schema-version ${version} must be major ${major}`);
  }
}

function checkEvents(): void {
  const files = listFiles(join(PACKAGE_ROOT, 'events'), '.schema.json').filter((f) => f !== '_envelope.schema.json');
  const expected = new Set<string>(eventNames);
  for (const name of eventNames) {
    if (!EVENT_NAME.test(name)) fail(`src/event-names.ts: event name ${JSON.stringify(name)} must match ${EVENT_NAME.source}`);
    if (!files.includes(`${name}.schema.json`)) fail(`events/${name}.schema.json: missing`);
  }
  const previous = new Map<string, number[]>();
  for (const file of files) {
    const m = EVENT_FILE.exec(file);
    const name = m?.[1] ?? '';
    if (!EVENT_NAME.test(name)) {
      fail(`events/${file}: file name must be <event name>.schema.json or <event name>.v<N>.schema.json, with a name matching ${EVENT_NAME.source}`);
      continue;
    }
    if (!expected.has(name)) {
      fail(`events/${file}: not in the event list (add the name to src/event-names.ts)`);
      continue;
    }
    if (m?.[2] !== undefined) previous.set(name, [...(previous.get(name) ?? []), Number(m[2])]);
  }
  checkEnvelope();
  let ajv: ReturnType<typeof createAjv>;
  try {
    ajv = createAjv();
  } catch (err) {
    fail(`events/_envelope.schema.json: cannot build the validator: ${(err as Error).message}`);
    return;
  }
  for (const name of eventNames) {
    if (!existsSync(eventSchemaPath(name))) continue;
    checkEventSchema(name, undefined, ajv);
    const prev = previous.get(name) ?? [];
    let currentMajor: number | undefined;
    try {
      currentMajor = Number(String(loadEventSchema(name)['x-schema-version']).split('.')[0]);
    } catch {
      currentMajor = undefined;
    }
    for (const major of prev) {
      if (currentMajor !== undefined && currentMajor < 2) {
        fail(`events/${name}.v${major}.schema.json: majors 0 and 1 have no previous-major window, current is major ${currentMajor}`);
      } else if (currentMajor !== undefined && major !== currentMajor - 1) {
        fail(`events/${name}.v${major}.schema.json: only the previous major (${currentMajor - 1}) may be kept, current is major ${currentMajor}`);
      }
      checkEventSchema(name, major, ajv);
    }
  }
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

async function checkGenerated(): Promise<void> {
  const expected = await buildGenerated();
  for (const [rel, text] of expected) {
    const path = join(PACKAGE_ROOT, rel);
    if (!existsSync(path)) fail(`${rel}: missing, run pnpm --filter @pd/contracts generate`);
    else if (readFileSync(path, 'utf8') !== text) fail(`${rel}: out of date, run pnpm --filter @pd/contracts generate`);
  }
  for (const f of walk(join(PACKAGE_ROOT, 'generated'))) {
    if (!expected.has(`generated/${f}`)) fail(`generated/${f}: not produced by the generators, delete it`);
  }
}

type Route = { method: string; path: string };

async function loadRoutes(svc: ServiceInfo): Promise<{ file: string; routes: Route[] } | undefined> {
  const isPy = svc.language === 'py';
  const rel = isPy ? `${svc.folder}/routes.json` : `${svc.folder}/src/routes.ts`;
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) {
    fail(`${rel}: missing (service ${svc.id} is a skeleton)`);
    return undefined;
  }
  try {
    const value = isPy ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : ((await import(pathToFileURL(path).href)) as { routes?: unknown }).routes;
    if (!Array.isArray(value)) throw new Error(isPy ? 'routes.json must be an array of { method, path }' : 'no exported routes array');
    for (const r of value as Array<Partial<Route>>) {
      if (typeof r?.method !== 'string' || typeof r?.path !== 'string') throw new Error('every route needs a string method and path');
    }
    return { file: rel, routes: value as Route[] };
  } catch (err) {
    fail(`${rel}: cannot load routes: ${(err as Error).message}`);
    return undefined;
  }
}

async function checkSkeletons(operations: Map<string, Set<string>>): Promise<void> {
  for (const svc of SERVICES) {
    if (!svc.skeleton) continue;
    const loaded = await loadRoutes(svc);
    if (!loaded) continue;
    const isPy = svc.language === 'py';
    if (!isPy) {
      for (const r of loaded.routes) {
        if (r.path.includes('{')) fail(`${loaded.file}: path ${r.path} uses {braces}; Fastify routes use :param (for example /users/:id)`);
      }
    }
    // TS paths use :id and are read as {id}. Python routes.json already uses the OpenAPI form.
    const actual = new Set(loaded.routes.map((r) => `${r.method.toUpperCase()} ${isPy ? r.path : r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`));
    const declared = operations.get(svc.id) ?? new Set<string>();
    for (const op of declared) if (!actual.has(op)) fail(`${svc.id}: ${op} is in the OpenAPI file but not in ${loaded.file}`);
    for (const op of actual) if (!declared.has(op)) fail(`${svc.id}: ${op} is in ${loaded.file} but not in the OpenAPI file`);
  }
}

const operations = await checkOpenApi();
checkEvents();
try {
  await checkGenerated();
} catch (err) {
  fail(`generated types: cannot build: ${(err as Error).message}`);
}
await checkSkeletons(operations);

if (failures.length > 0) {
  console.error(`contracts:check failed with ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`contracts:check ok: ${serviceIds.length} OpenAPI files, ${eventNames.length} event schemas, generated types current`);
