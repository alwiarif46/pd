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
    expect(r.out).toContain('no /healthz path');
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
});
