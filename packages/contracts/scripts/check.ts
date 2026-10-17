// pnpm contracts:check. Exits non-zero with one line per failure.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from '@readme/openapi-parser';
import { parse as parseYaml } from 'yaml';
import { PACKAGE_ROOT, SERVICES, createAjv, eventNames, eventSchemaPath } from '../src/index';
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
    if (!paths['/healthz']) fail(`openapi/${file}: no /healthz path`);
    const ops = new Set<string>();
    for (const [p, item] of Object.entries(paths)) {
      for (const m of METHODS) if (item[m]) ops.add(`${m.toUpperCase()} ${p}`);
    }
    operations.set(id, ops);
  }
  return operations;
}

function checkEvents(): void {
  const files = listFiles(join(PACKAGE_ROOT, 'events'), '.schema.json').filter((f) => f !== '_envelope.schema.json');
  const expected = new Set<string>(eventNames);
  for (const name of eventNames) {
    if (!files.includes(`${name}.schema.json`)) fail(`events/${name}.schema.json: missing`);
  }
  for (const file of files) {
    const name = file.replace(/\.schema\.json$/, '');
    if (!expected.has(name)) fail(`events/${file}: not in the event list (add the name to src/event-names.ts)`);
  }
  const ajv = createAjv();
  for (const name of eventNames) {
    if (!existsSyncSafe(eventSchemaPath(name))) continue;
    const label = `events/${name}.schema.json`;
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(readFileSync(eventSchemaPath(name), 'utf8')) as Record<string, unknown>;
      ajv.compile(schema);
    } catch (err) {
      fail(`${label}: does not compile: ${(err as Error).message}`);
      continue;
    }
    const expectedId = `https://contracts.e2e.local/events/${name}`;
    if (!schema.$id) fail(`${label}: no $id`);
    else if (schema.$id !== expectedId) fail(`${label}: $id is ${String(schema.$id)}, expected ${expectedId}`);
    const owner = schema['x-owner'];
    const svc = SERVICES.find((s) => s.id === owner);
    if (!svc) fail(`${label}: x-owner ${JSON.stringify(owner)} is not a known service id`);
    if (schema['x-stream'] !== `e2e.${name}`) {
      fail(`${label}: x-stream is ${JSON.stringify(schema['x-stream'])}, expected "e2e.${name}"`);
    }
    if (svc && !(svc.stream_prefix && (`e2e.${name}`.startsWith(`${svc.stream_prefix}.`) || `e2e.${name}` === svc.stream_prefix))) {
      fail(`${label}: stream e2e.${name} does not start with the prefix of service ${svc.id} (${String(svc.stream_prefix)})`);
    }
    const props = schema.properties as Record<string, { const?: unknown }> | undefined;
    const version = props?.schema_version?.const;
    if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
      fail(`${label}: properties.schema_version.const must match ^\\d+\\.\\d+$, got ${JSON.stringify(version)}`);
    }
    if (props?.type?.const !== name) fail(`${label}: properties.type.const must be "${name}"`);
  }
}

function existsSyncSafe(path: string): boolean {
  return existsSync(path);
}

async function checkGenerated(): Promise<void> {
  const expected = await buildGenerated();
  for (const [rel, text] of expected) {
    const path = join(PACKAGE_ROOT, rel);
    if (!existsSync(path)) fail(`${rel}: missing, run pnpm --filter @pd/contracts generate`);
    else if (readFileSync(path, 'utf8') !== text) fail(`${rel}: out of date, run pnpm --filter @pd/contracts generate`);
  }
  for (const f of listFiles(join(PACKAGE_ROOT, 'generated', 'openapi'), '.d.ts')) {
    if (!expected.has(`generated/openapi/${f}`)) fail(`generated/openapi/${f}: no matching OpenAPI file`);
  }
}

async function checkSkeletons(operations: Map<string, Set<string>>): Promise<void> {
  for (const svc of SERVICES) {
    if (!svc.skeleton) continue;
    const routesPath = join(REPO_ROOT, svc.folder, 'src', 'routes.ts');
    if (!existsSync(routesPath)) {
      fail(`${svc.folder}/src/routes.ts: missing (service ${svc.id} is a skeleton)`);
      continue;
    }
    let routes: ReadonlyArray<{ method: string; path: string }>;
    try {
      const mod = (await import(pathToFileURL(routesPath).href)) as { routes?: unknown };
      if (!Array.isArray(mod.routes)) throw new Error('no exported routes array');
      routes = mod.routes as ReadonlyArray<{ method: string; path: string }>;
    } catch (err) {
      fail(`${svc.folder}/src/routes.ts: cannot load routes: ${(err as Error).message}`);
      continue;
    }
    const actual = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`));
    const declared = operations.get(svc.id) ?? new Set<string>();
    for (const op of declared) if (!actual.has(op)) fail(`${svc.id}: ${op} is in the OpenAPI file but not in ${svc.folder}/src/routes.ts`);
    for (const op of actual) if (!declared.has(op)) fail(`${svc.id}: ${op} is in ${svc.folder}/src/routes.ts but not in the OpenAPI file`);
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
