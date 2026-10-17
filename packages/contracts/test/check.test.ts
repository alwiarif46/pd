import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/index';

// Copies live inside the package so node resolves its node_modules.
const copies: string[] = [];
afterAll(() => {
  for (const c of copies) rmSync(c, { recursive: true, force: true });
});

function copyPackage(): string {
  const dir = mkdtempSync(join(PACKAGE_ROOT, '.tmp-'));
  copies.push(dir);
  for (const part of ['openapi', 'events', 'generated', 'src', 'scripts', 'services.json', 'package.json', 'tsconfig.json']) {
    cpSync(join(PACKAGE_ROOT, part), join(dir, part), { recursive: true });
  }
  // Tests that are not about skeletons must not depend on the real service folders: switch every flag off.
  // Skeleton tests turn on the one service they need.
  const svcFile = join(dir, 'services.json');
  const services = JSON.parse(readFileSync(svcFile, 'utf8')) as Array<{ skeleton: boolean }>;
  for (const s of services) s.skeleton = false;
  writeFileSync(svcFile, JSON.stringify(services, null, 2) + '\n');
  return dir;
}

function runCheck(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync(join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx'), [join(dir, 'scripts', 'check.ts')], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

function runGenerate(dir: string) {
  const r = spawnSync(join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx'), [join(dir, 'scripts', 'generate.ts')], { cwd: dir, encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
}

function editJson(file: string, fn: (doc: Doc) => void): void {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc;
  fn(doc);
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

const TS_ROUTES = (paths: string[]) =>
  `export const routes: ReadonlyArray<{ method: string; path: string }> = [${paths.map((p) => `{ method: 'GET', path: '${p}' }`).join(', ')}];\n`;

/** A copy with identity as a skeleton of the given language, plus a fake repo root. */
function skeletonCopy(language: 'ts' | 'py'): { dir: string; repo: string; folder: string } {
  const dir = copyPackage();
  const svcFile = join(dir, 'services.json');
  let folder = '';
  editJson(svcFile, (doc) => {
    const services = doc as unknown as Doc[];
    const s = services.find((x) => x.id === 'identity')!;
    s.skeleton = true;
    s.language = language;
    folder = s.folder;
  });
  const repo = mkdtempSync(join(dir, 'repo-'));
  mkdirSync(join(repo, folder, 'src'), { recursive: true });
  return { dir, repo, folder: join(repo, folder) };
}

function addUsersPath(dir: string): void {
  const file = join(dir, 'openapi', 'identity.yaml');
  const text = readFileSync(file, 'utf8').replace(
    'components:\n',
    `  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: The user.
components:
`,
  );
  writeFileSync(file, text);
  runGenerate(dir);
}

describe('contracts:check', () => {
  it('passes on the repo', () => {
    const r = runCheck(PACKAGE_ROOT);
    expect(r.out).toContain('contracts:check ok');
    expect(r.code).toBe(0);
  });

  it('fails on a broken event schema', () => {
    const dir = copyPackage();
    const file = join(dir, 'events', 'render.done.schema.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    doc['x-owner'] = 'nobody';
    doc['x-stream'] = 'e2e.wrong';
    writeFileSync(file, JSON.stringify(doc));
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('x-owner');
    expect(r.out).toContain('x-stream');
  });

  it('fails on an extra event file and on stale generated types', () => {
    const dir = copyPackage();
    writeFileSync(join(dir, 'events', 'extra.thing.schema.json'), '{}');
    writeFileSync(join(dir, 'generated', 'events.d.ts'), '// stale\n');
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('extra.thing.schema.json');
    expect(r.out).toContain('out of date');
  });

  it('fails on a bad OpenAPI version and a missing /healthz', () => {
    const dir = copyPackage();
    const file = join(dir, 'openapi', 'billing.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('version: 0.1.0', 'version: one').replace('/healthz', '/health'));
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('info.version must be semver');
    expect(r.out).toContain('no GET /healthz');
  });

  it('compares skeleton routes with the OpenAPI paths', () => {
    const dir = copyPackage();
    const svcFile = join(dir, 'services.json');
    const services = JSON.parse(readFileSync(svcFile, 'utf8')) as Array<{ id: string; skeleton: boolean }>;
    services.find((s) => s.id === 'identity')!.skeleton = true;
    writeFileSync(svcFile, JSON.stringify(services));
    const repo = mkdtempSync(join(dir, 'repo-'));
    mkdirSync(join(repo, 'services', 'identity', 'src'), { recursive: true });
    const routesFile = join(repo, 'services', 'identity', 'src', 'routes.ts');

    writeFileSync(routesFile, "export const routes: ReadonlyArray<{ method: string; path: string }> = [{ method: 'GET', path: '/healthz' }];\n");
    expect(runCheck(dir, { CONTRACTS_REPO_ROOT: repo }).code).toBe(0);

    writeFileSync(routesFile, "export const routes: ReadonlyArray<{ method: string; path: string }> = [{ method: 'GET', path: '/healthz' }, { method: 'GET', path: '/users/:id' }];\n");
    const r = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('GET /users/{id} is in');
  });
  it('fails when an event drops its envelope allOf', () => {
    const dir = copyPackage();
    editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
      delete d.allOf;
    });
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('allOf');
  });

  it('fails when an event allOf holds more than the envelope ref', () => {
    const dir = copyPackage();
    editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
      d.allOf.push({});
    });
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('allOf');
  });

  it('fails when the envelope drops tenant_id', () => {
    const dir = copyPackage();
    editJson(join(dir, 'events', '_envelope.schema.json'), (d) => {
      d.required = d.required.filter((f: string) => f !== 'tenant_id');
    });
    runGenerate(dir);
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('envelope');
    expect(r.out).toContain('tenant_id');
  });

  it('fails when an event drops unevaluatedProperties false', () => {
    const dir = copyPackage();
    editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
      delete d.unevaluatedProperties;
    });
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('unevaluatedProperties');
  });

  it('fails on a schema_version pattern that does not match x-schema-version', () => {
    const dir = copyPackage();
    editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
      d['x-schema-version'] = '2.0';
    });
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('schema_version');
  });

  it('fails on a stray file in generated/', () => {
    const dir = copyPackage();
    writeFileSync(join(dir, 'generated', 'openapi', 'old.txt'), 'x');
    mkdirSync(join(dir, 'generated', 'extra'), { recursive: true });
    writeFileSync(join(dir, 'generated', 'extra', 'a.d.ts'), 'x');
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('generated/openapi/old.txt');
    expect(r.out).toContain('generated/extra/a.d.ts');
  });

  it('fails on a bad event name shape', () => {
    const dir = copyPackage();
    writeFileSync(join(dir, 'events', 'Bad_Name.schema.json'), '{}');
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Bad_Name');
  });

  it('fails when /healthz has no get', () => {
    const dir = copyPackage();
    const file = join(dir, 'openapi', 'billing.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('    get:\n      operationId: healthz', '    post:\n      operationId: healthz'));
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('GET /healthz');
  });

  describe('malformed JSON', () => {
    it('reports a broken event file as one line, no stack trace', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', 'render.done.schema.json'), '{ not json');
      const r = runCheck(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain('events/render.done.schema.json');
      expect(r.out).not.toMatch(/\n\s+at /);
    });

    it('reports a broken envelope as one line, no stack trace', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', '_envelope.schema.json'), '{ not json');
      const r = runCheck(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain('events/_envelope.schema.json');
      expect(r.out).not.toMatch(/\n\s+at /);
    });
  });

  describe('versions and file names', () => {
    it('rejects a leading zero in x-schema-version', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
        d['x-schema-version'] = '01.0';
        d.properties.schema_version = { type: 'string', pattern: '^01\\.\\d+$' };
      });
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('x-schema-version');
    });

    it('rejects a leading zero in the envelope schema_version pattern', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', '_envelope.schema.json'), (d) => {
        d.properties.schema_version.pattern = '^\\d+\\.\\d+$';
      });
      runGenerate(dir);
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('schema_version');
    });

    it('gives a clear file-name error for render.done.v01.schema.json', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', 'render.done.v01.schema.json'), '{}');
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('events/render.done.v01.schema.json: file name must be');
    });

    it('fails a .v1 file when the current major is 1', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', 'render.done.v1.schema.json'), '{}');
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('majors 0 and 1 have no previous-major window');
    });

    it('fails a .v0 file', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', 'render.done.v0.schema.json'), '{}');
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('events/render.done.v0.schema.json');
      expect(r.out).toContain('majors 0 and 1 have no previous-major window');
    });
  });

  describe('envelope pinning', () => {
    it('fails when the envelope tenant_id loses its shape', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', '_envelope.schema.json'), (d) => {
        d.properties.tenant_id = {};
      });
      runGenerate(dir);
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('tenant_id');
    });

    it('fails when an event adds a property and requires it', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
        d.properties.foo = { type: 'string' };
        d.required = ['foo'];
      });
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('properties.foo');
      expect(r.out).toContain('required');
    });

    it('fails when an event declares tenantId in properties', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
        d.properties.tenantId = { type: 'string' };
      });
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('properties.tenantId');
    });

    it('fails on top-level additionalProperties and patternProperties', () => {
      const dir = copyPackage();
      editJson(join(dir, 'events', 'render.done.schema.json'), (d) => {
        d.additionalProperties = true;
        d.patternProperties = { '^x': {} };
      });
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('additionalProperties');
      expect(r.out).toContain('patternProperties');
    });
  });

  describe('previous major event schemas', () => {
    function withV1(): string {
      const dir = copyPackage();
      const base = join(dir, 'events', 'render.done.schema.json');
      const old = JSON.parse(readFileSync(base, 'utf8')) as Doc;
      old.$id = `${old.$id}.v1`;
      writeFileSync(join(dir, 'events', 'render.done.v1.schema.json'), JSON.stringify(old, null, 2) + '\n');
      editJson(base, (d) => {
        d['x-schema-version'] = '2.0';
        d.properties.schema_version = { type: 'string', pattern: '^2\\.\\d+$' };
      });
      return dir;
    }

    it('passes, and generates an EventV1 type', () => {
      const dir = withV1();
      runGenerate(dir);
      const types = readFileSync(join(dir, 'generated', 'events.d.ts'), 'utf8');
      expect(types).toContain('export interface RenderDoneEvent ');
      expect(types).toContain('export interface RenderDoneEventV1 ');
      const r = runCheck(dir);
      expect(r.out).toContain('contracts:check ok');
      expect(r.code).toBe(0);
    });

    it('fails when the v1 file has the wrong owner, stream, pattern or id', () => {
      const dir = withV1();
      runGenerate(dir);
      editJson(join(dir, 'events', 'render.done.v1.schema.json'), (d) => {
        d['x-owner'] = 'billing';
        d['x-stream'] = 'e2e.other';
        d.properties.schema_version.pattern = '^2\\.\\d+$';
        d.$id = 'https://contracts.e2e.local/events/render.done.v9';
      });
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('render.done.v1.schema.json');
      expect(r.out).toContain('x-owner');
      expect(r.out).toContain('x-stream');
      expect(r.out).toContain('pattern');
      expect(r.out).toContain('$id');
    });

    it('fails on a v file with no base event, and on a v file at 1.x current', () => {
      const dir = copyPackage();
      writeFileSync(join(dir, 'events', 'render.done.v1.schema.json'), '{}');
      writeFileSync(join(dir, 'events', 'nothing.here.v1.schema.json'), '{}');
      const r = runCheck(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('render.done.v1.schema.json');
      expect(r.out).toContain('nothing.here.v1.schema.json');
    });
  });

  describe('skeleton routes', () => {
    it('ts: accepts /users/:id against /users/{id}', () => {
      const { dir, repo, folder } = skeletonCopy('ts');
      addUsersPath(dir);
      writeFileSync(join(folder, 'src', 'routes.ts'), TS_ROUTES(['/healthz', '/users/:id']));
      const r = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(r.out).toContain('contracts:check ok');
      expect(r.code).toBe(0);
    });

    it('ts: rejects :userId against {id}', () => {
      const { dir, repo, folder } = skeletonCopy('ts');
      addUsersPath(dir);
      writeFileSync(join(folder, 'src', 'routes.ts'), TS_ROUTES(['/healthz', '/users/:userId']));
      const r = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('GET /users/{id} is in the OpenAPI file but not in');
      expect(r.out).toContain('GET /users/{userId} is in');
    });

    it('ts: rejects braces in a Fastify path', () => {
      const { dir, repo, folder } = skeletonCopy('ts');
      addUsersPath(dir);
      writeFileSync(join(folder, 'src', 'routes.ts'), TS_ROUTES(['/healthz', '/users/{id}']));
      const r = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('/users/{id}');
      expect(r.out).toContain(':id');
    });

    it('py: reads routes.json with {id} paths', () => {
      const { dir, repo, folder } = skeletonCopy('py');
      addUsersPath(dir);
      const file = join(folder, 'routes.json');
      writeFileSync(file, JSON.stringify([{ method: 'GET', path: '/healthz' }, { method: 'get', path: '/users/{id}' }]));
      const ok = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(ok.out).toContain('contracts:check ok');
      expect(ok.code).toBe(0);

      writeFileSync(file, JSON.stringify([{ method: 'GET', path: '/healthz' }, { method: 'GET', path: '/users/:id' }]));
      const bad = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(bad.code).not.toBe(0);
      expect(bad.out).toContain('GET /users/:id is in');
      expect(bad.out).toContain('GET /users/{id} is in the OpenAPI file but not in');
    });

    it('py: fails when routes.json is missing or is not an array', () => {
      const { dir, repo, folder } = skeletonCopy('py');
      writeFileSync(join(folder, 'src', 'routes.ts'), TS_ROUTES(['/healthz']));
      const missing = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(missing.code).not.toBe(0);
      expect(missing.out).toContain('routes.json');
      writeFileSync(join(folder, 'routes.json'), '{}');
      const bad = runCheck(dir, { CONTRACTS_REPO_ROOT: repo });
      expect(bad.code).not.toBe(0);
      expect(bad.out).toContain('routes.json');
    });
  });
});
