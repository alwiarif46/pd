// Version-bump check (BUILD-PLAN s5): a changed contract must change its version in the same diff.
// Library part. The command is scripts/bump-cli.ts (pnpm contracts:check:bump); pnpm contracts:check --base <ref> runs it too.
//
// Rules, comparing HEAD with `git merge-base HEAD <base>`:
//   - A new file needs no bump.
//   - A changed openapi/<service>.yaml must change info.version, and the new version must be higher (semver).
//   - A changed events/<name>.schema.json (and .v<N> file) must change x-schema-version, and the new one must be higher.
//   - A MAJOR bump of an event must go up by exactly one, and the previous-major file events/<name>.v<old>.schema.json
//     must exist at HEAD (already there at the merge base, or added in this diff).
//   - A deleted file fails. The one exception is a previous-major file events/<name>.v<N>.schema.json: the README says
//     the follow-up PR after a breaking change deletes it.
//   - events/_envelope.schema.json has no version. A change to it only prints a warning.
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export interface BumpOptions {
  /** The git work tree (the repo root). */
  repoRoot: string;
  /** The ref to compare with, for example origin/master. */
  base: string;
  /** Where the contracts live, relative to repoRoot. */
  contractsDir?: string;
  /** Under CI an unavailable base is a failure, not a skip. */
  ci?: boolean;
}

export interface BumpResult {
  status: 'ok' | 'failed' | 'skipped';
  /** One line per problem (failed), or the reason (skipped). */
  messages: string[];
  warnings: string[];
  checked: number;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return git(repoRoot, args);
  } catch {
    return undefined;
  }
}

const OPENAPI_FILE = /^openapi\/[^/]+\.yaml$/;
const EVENT_FILE = /^events\/(.+?)(?:\.v(0|[1-9]\d*))?\.schema\.json$/;

function showAt(repoRoot: string, rev: string, path: string): string | undefined {
  return tryGit(repoRoot, ['show', `${rev}:${path}`]);
}

function existsAt(repoRoot: string, rev: string, path: string): boolean {
  return tryGit(repoRoot, ['cat-file', '-e', `${rev}:${path}`]) !== undefined;
}

/** Numeric compare of dotted versions; a pre-release suffix is ignored, build metadata too. */
function compare(a: string, b: string): number {
  const num = (v: string) => v.split(/[-+]/)[0]!.split('.').map(Number);
  const x = num(a);
  const y = num(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // Same numbers: a different pre-release suffix still counts as a change, but not an increase we can order.
  return 0;
}

function versionOf(kind: 'openapi' | 'event', text: string): string | undefined {
  try {
    if (kind === 'openapi') {
      const v = (parseYaml(text) as { info?: { version?: unknown } } | null)?.info?.version;
      return typeof v === 'string' ? v : undefined;
    }
    const v = (JSON.parse(text) as Record<string, unknown>)['x-schema-version'];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function checkBump(opts: BumpOptions): BumpResult {
  const { repoRoot, base } = opts;
  const dir = (opts.contractsDir ?? 'packages/contracts').replace(/\/+$/, '');
  const messages: string[] = [];
  const warnings: string[] = [];

  const unavailable = (why: string): BumpResult => {
    if (opts.ci) return { status: 'failed', messages: [`version-bump check: ${why}. In CI the base must be fetched (fetch-depth 0).`], warnings, checked: 0 };
    return { status: 'skipped', messages: [`version-bump check skipped: ${why}. Fetch it (git fetch origin) to run the check.`], warnings, checked: 0 };
  };

  if (tryGit(repoRoot, ['rev-parse', '--git-dir']) === undefined) return unavailable(`${repoRoot} is not a git work tree`);
  if (tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === undefined) return unavailable(`base ref ${base} is not available locally`);
  const mergeBase = tryGit(repoRoot, ['merge-base', 'HEAD', base])?.trim();
  if (!mergeBase) return unavailable(`no merge base between HEAD and ${base} (shallow clone?)`);

  const out = git(repoRoot, ['diff', '--name-status', '--no-renames', '-z', mergeBase, 'HEAD', '--', `${dir}/openapi`, `${dir}/events`]);
  const parts = out.split('\0').filter((p) => p.length > 0);
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i]!, path: parts[i + 1]!.slice(dir.length + 1) });

  let checked = 0;
  for (const { status, path } of changes) {
    const isOpenApi = OPENAPI_FILE.test(path);
    const ev = EVENT_FILE.exec(path);
    if (path === 'events/_envelope.schema.json') {
      warnings.push(`${path} changed: it has no version, so review every event schema against the new envelope.`);
      continue;
    }
    if (!isOpenApi && !ev) continue; // not a contract file (a README, say)
    const label = `${dir}/${path}`;
    if (status === 'A') continue; // new files need no bump
    if (status === 'D') {
      if (ev?.[2] !== undefined) continue; // the follow-up PR deletes a previous-major file
      messages.push(`${label}: deleted. Contracts are not deleted in a normal PR (only a previous-major .v<N> file may be).`);
      continue;
    }
    if (status !== 'M' && status !== 'T') {
      messages.push(`${label}: unexpected change status ${status}`);
      continue;
    }
    checked++;
    const kind = isOpenApi ? 'openapi' : 'event';
    const field = isOpenApi ? 'info.version' : 'x-schema-version';
    const oldText = showAt(repoRoot, mergeBase, label);
    const newText = showAt(repoRoot, 'HEAD', label);
    const oldV = oldText === undefined ? undefined : versionOf(kind, oldText);
    const newV = newText === undefined ? undefined : versionOf(kind, newText);
    if (newV === undefined) {
      messages.push(`${label}: no ${field} at HEAD`);
      continue;
    }
    if (oldV === undefined) continue; // the old file had no version: nothing to compare with, contracts:check judges the new one
    if (oldV === newV) {
      messages.push(`${label}: changed but ${field} is still ${newV}. Bump it in the same diff (minor for a compatible change, major for a break).`);
      continue;
    }
    if (compare(newV, oldV) < 0) {
      messages.push(`${label}: ${field} went down, ${oldV} to ${newV}`);
      continue;
    }
    if (kind === 'event' && ev && ev[2] === undefined) {
      const oldMajor = Number(oldV.split('.')[0]);
      const newMajor = Number(newV.split('.')[0]);
      if (newMajor > oldMajor) {
        const prev = `${dir}/events/${ev[1]}.v${oldMajor}.schema.json`;
        if (newMajor !== oldMajor + 1) {
          messages.push(`${label}: major bump ${oldV} to ${newV} skips a major. Go up one major at a time.`);
        } else if (!existsAt(repoRoot, 'HEAD', prev)) {
          messages.push(`${label}: major bump ${oldV} to ${newV} needs the previous-major file ${prev} (copy the old schema there, with $id suffix .v${oldMajor}).`);
        }
      }
    }
  }
  return { status: messages.length > 0 ? 'failed' : 'ok', messages, warnings, checked };
}
