import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/** Services that own an OpenAPI file (09 s9.3 migration order, plus the gateway). */
export const SERVICES = [
  'gateway',
  'identity',
  'billing',
  'ingest',
  'intel',
  'orchestrator',
  'modelgw',
  'drafting',
  'review',
  'render',
  'evidence',
  'comms',
  'portal',
  'drive',
  'notify',
] as const;
export type Service = (typeof SERVICES)[number];

export interface ContractProblem {
  file: string;
  message: string;
}

export const contractsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const EVENT_FILE = /^([a-z]+)\.([a-z_]+)\.([a-z_]+)\.schema\.json$/;
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/** Checks the contract files for structure. Service-drift checks arrive with each service. */
export function checkContracts(root: string = contractsRoot): ContractProblem[] {
  const problems: ContractProblem[] = [];
  const fail = (file: string, message: string) => problems.push({ file, message });

  const specFiles = new Set(readdirSync(join(root, 'openapi')));
  for (const service of SERVICES) {
    const file = `openapi/${service}.yaml`;
    if (!specFiles.has(`${service}.yaml`)) {
      fail(file, 'missing OpenAPI file for service');
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      doc = parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      fail(file, `not valid YAML: ${(err as Error).message}`);
      continue;
    }
    if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.1')) fail(file, 'openapi must be 3.1.x');
    const info = doc?.info as { title?: unknown; version?: unknown } | undefined;
    if (!info?.title || !info.version) fail(file, 'info.title and info.version are required');
    const paths = (doc?.paths ?? {}) as Record<string, Record<string, { operationId?: string }>>;
    if (!paths['/health']?.get) fail(file, 'GET /health is required');
    for (const [path, item] of Object.entries(paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op && !op.operationId) fail(file, `${method.toUpperCase()} ${path} needs an operationId`);
      }
    }
  }
  for (const name of specFiles) {
    if (!SERVICES.includes(name.replace(/\.yaml$/, '') as Service)) fail(`openapi/${name}`, 'not a known service');
  }

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const eventDir = readdirSync(join(root, 'events')).sort();
  const envelope = eventDir.includes('envelope.schema.json');
  if (!envelope) fail('events/envelope.schema.json', 'missing event envelope');
  else ajv.addSchema(JSON.parse(readFileSync(join(root, 'events/envelope.schema.json'), 'utf8')));
  for (const name of eventDir) {
    if (name === 'envelope.schema.json') continue;
    const file = `events/${name}`;
    const m = EVENT_FILE.exec(name);
    if (!m) {
      fail(file, 'name must be <service>.<entity>.<verb>.schema.json');
      continue;
    }
    if (!SERVICES.includes(m[1] as Service)) fail(file, `unknown service "${m[1]}"`);
    try {
      ajv.compile(JSON.parse(readFileSync(join(root, file), 'utf8')));
    } catch (err) {
      fail(file, `invalid schema: ${(err as Error).message}`);
    }
  }
  return problems;
}

/**
 * Drift check for one service: compares the routes its code registers with the paths in its OpenAPI file.
 * A service test calls this with its own route list, as `"GET /health"`. Path parameters use the
 * OpenAPI form, `/tenants/{id}`.
 */
export function checkServiceDrift(
  service: Service,
  registeredRoutes: readonly string[],
  root: string = contractsRoot,
): ContractProblem[] {
  const file = `openapi/${service}.yaml`;
  const doc = parse(readFileSync(join(root, file), 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const declared = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) if (item[method]) declared.add(`${method.toUpperCase()} ${path}`);
  }
  const registered = new Set(registeredRoutes.map((r) => r.trim()));
  const problems: ContractProblem[] = [];
  for (const route of registered) {
    if (!declared.has(route)) problems.push({ file, message: `route ${route} is not in the contract` });
  }
  for (const route of declared) {
    if (!registered.has(route))
      problems.push({
        file,
        message: `contract route ${route} is not implemented`,
      });
  }
  return problems;
}
