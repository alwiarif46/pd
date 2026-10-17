import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/index';
import { checkBump } from '../scripts/bump';

// Each test builds a throwaway git repo in the OS temp dir: a base commit on "main", then a branch with the change.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const C = 'packages/contracts';
const yaml = (version: string, extra = '') => `openapi: 3.1.0\ninfo:\n  title: T\n  version: ${version}\nx-service: billing\npaths: {}\n${extra}`;
const envelope = (version: string | undefined, note: string) =>
  JSON.stringify({ $id: 'https://contracts.e2e.local/events/_envelope', ...(version ? { 'x-schema-version': version } : {}), note }, null, 2) + '\n';
const event = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ $id: `https://contracts.e2e.local/events/${name}`, 'x-schema-version': version, ...extra }, null, 2) + '\n';

// No hooks, and no GIT_* variables from a parent git process (a hook run by git sets GIT_DIR and friends).
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return env;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bump-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, `${C}/openapi/billing.yaml`, yaml('0.1.0'));
  put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '1.0'));
  put(dir, `${C}/events/_envelope.schema.json`, envelope('1.0', 'x'));
  put(dir, `${C}/README.md`, 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

function commit(dir: string, msg = 'change'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

const run = (dir: string, extra: { ci?: boolean; base?: string } = {}) => checkBump({ repoRoot: dir, base: extra.base ?? 'main', ci: extra.ci });

describe('version-bump check', () => {
  it('passes when nothing under openapi or events changed', () => {
    const dir = fixture();
    put(dir, `${C}/README.md`, 'two\n');
    commit(dir);
    expect(run(dir)).toMatchObject({ status: 'ok', checked: 0 });
  });

  it('fails an OpenAPI file that changed without a version bump', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.1.0', 'x-note: changed\n'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/billing\.yaml: changed but info\.version is still 0\.1\.0/);
  });

  it('passes an OpenAPI file with a higher version, and fails a lower one', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.2.0', 'x-note: changed\n'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.0.9', 'x-note: changed\n'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/went down, 0\.1\.0 to 0\.0\.9/);
  });

  it('compares versions numerically, not as text (0.9.0 to 0.10.0 is a bump)', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.9.0'));
    commit(dir);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feature');
    git(dir, 'checkout', '-q', '-b', 'feature2');
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.10.0', 'x-note: y\n'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('fails an event that changed without a bump, passes a minor bump', () => {
    const dir = fixture();
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '1.0', { description: 'new' }));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/x-schema-version is still 1\.0/);
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '1.1', { description: 'new' }));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('requires the previous-major file on a major bump of an event', () => {
    const dir = fixture();
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '2.0'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toContain('billing.credit.consumed.v1.schema.json');
  });

  it('accepts a major bump when the previous-major file is added in the same diff', () => {
    const dir = fixture();
    put(dir, `${C}/events/billing.credit.consumed.v1.schema.json`, event('billing.credit.consumed.v1', '1.0'));
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '2.0'));
    commit(dir);
    expect(run(dir)).toMatchObject({ status: 'ok', checked: 1 });
  });

  it('accepts a major bump when the previous-major file already existed at the merge base', () => {
    const dir = fixture();
    git(dir, 'checkout', '-q', 'main');
    put(dir, `${C}/events/billing.credit.consumed.v1.schema.json`, event('billing.credit.consumed.v1', '1.0'));
    commit(dir, 'main adds the old copy');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', 'main');
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '2.0'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('refuses a major bump that skips a major', () => {
    const dir = fixture();
    put(dir, `${C}/events/billing.credit.consumed.v1.schema.json`, event('billing.credit.consumed.v1', '1.0'));
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '3.0'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/skips a major/);
  });

  it('needs no bump for new files', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/identity.yaml`, yaml('0.1.0'));
    put(dir, `${C}/events/identity.tenant.created.schema.json`, event('identity.tenant.created', '1.0'));
    commit(dir);
    expect(run(dir)).toMatchObject({ status: 'ok', checked: 0 });
  });

  it('fails a deleted contract file but allows deleting a previous-major file', () => {
    const dir = fixture();
    git(dir, 'rm', '-q', `${C}/openapi/billing.yaml`);
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/billing\.yaml: deleted/);

    const dir2 = fixture();
    git(dir2, 'checkout', '-q', 'main');
    put(dir2, `${C}/events/billing.credit.consumed.v1.schema.json`, event('billing.credit.consumed.v1', '1.0'));
    commit(dir2, 'old copy on main');
    git(dir2, 'checkout', '-q', 'feature');
    git(dir2, 'merge', '-q', 'main');
    git(dir2, 'rm', '-q', `${C}/events/billing.credit.consumed.v1.schema.json`);
    commit(dir2);
    expect(run(dir2).status).toBe('ok');
  });

  it('fails an envelope change without a bump of its own x-schema-version', () => {
    const dir = fixture();
    put(dir, `${C}/events/_envelope.schema.json`, envelope('1.0', 'y'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/_envelope\.schema\.json: changed but x-schema-version is still 1\.0/);
  });

  it('accepts an envelope minor or major bump, with no per-event files', () => {
    const dir = fixture();
    put(dir, `${C}/events/_envelope.schema.json`, envelope('1.1', 'y'));
    commit(dir);
    expect(run(dir)).toMatchObject({ status: 'ok', checked: 1 });
    put(dir, `${C}/events/_envelope.schema.json`, envelope('2.0', 'z'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('lets an envelope that gains its first version in this diff through, and fails its deletion', () => {
    const dir = fixture();
    git(dir, 'checkout', '-q', 'main');
    put(dir, `${C}/events/_envelope.schema.json`, envelope(undefined, 'x'));
    commit(dir, 'unversioned envelope on main');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', 'main');
    put(dir, `${C}/events/_envelope.schema.json`, envelope('1.0', 'x'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
    git(dir, 'rm', '-q', `${C}/events/_envelope.schema.json`);
    commit(dir);
    expect(run(dir).messages.join('\n')).toMatch(/_envelope\.schema\.json: deleted/);
  });

  it('fails when the merge-base copy does not parse', () => {
    const dir = fixture();
    git(dir, 'checkout', '-q', 'main');
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, '{ not json');
    commit(dir, 'broken on main');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', 'main');
    put(dir, `${C}/events/billing.credit.consumed.schema.json`, event('billing.credit.consumed', '1.1'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/merge base does not parse/);
  });

  it('lets a parsed old file without the version field through', () => {
    const dir = fixture();
    git(dir, 'checkout', '-q', 'main');
    put(dir, `${C}/openapi/billing.yaml`, 'openapi: 3.1.0\ninfo:\n  title: T\nx-service: billing\npaths: {}\n');
    commit(dir, 'no version on main');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', 'main');
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.1.0'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('does not count a pre-release of the same numbers as a bump', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.1.0-rc1', 'x-note: changed\n'));
    commit(dir);
    const r = run(dir);
    expect(r.status).toBe('failed');
    expect(r.messages.join('\n')).toMatch(/went down/);
  });

  it('counts a release after its pre-release as a bump', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.2.0-rc1'));
    commit(dir);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feature');
    git(dir, 'checkout', '-q', '-b', 'feature2');
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.2.0'));
    commit(dir);
    expect(run(dir).status).toBe('ok');
  });

  it('uses the merge base, so changes that landed on the base after the branch point are not blamed on the branch', () => {
    const dir = fixture();
    put(dir, `${C}/README.md`, 'branch\n');
    commit(dir);
    git(dir, 'checkout', '-q', 'main');
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.3.0', 'x-note: landed on main\n'));
    commit(dir, 'main moves on');
    git(dir, 'checkout', '-q', 'feature');
    expect(run(dir).status).toBe('ok');
  });

  it('skips with a clear message when the base ref is missing, and fails under CI', () => {
    const dir = fixture();
    const local = run(dir, { base: 'origin/master' });
    expect(local.status).toBe('skipped');
    expect(local.messages.join('\n')).toMatch(/base ref origin\/master is not available locally/);
    const ci = run(dir, { base: 'origin/master', ci: true });
    expect(ci.status).toBe('failed');
  });

  it('the command exits 0 on skip, 1 on a missing bump, and reads --base after a bare --', () => {
    const dir = fixture();
    put(dir, `${C}/openapi/billing.yaml`, yaml('0.1.0', 'x-note: changed\n'));
    commit(dir);
    const tsx = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
    const cli = join(PACKAGE_ROOT, 'scripts', 'bump-cli.ts');
    const env = { ...cleanEnv(), CI: '' };
    const failed = spawnSync(tsx, [cli, '--', '--base', 'main', '--repo', dir], { env, encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/still 0\.1\.0/);
    const skipped = spawnSync(tsx, [cli, '--base', 'origin/nope', '--repo', dir], { env, encoding: 'utf8' });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toMatch(/skipped/);
  });
});
