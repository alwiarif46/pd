// The only place that reads a SKILL.md (CLAUDE.md rule 7).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedSkill } from './types';

export const SKILLS_DIR_ENV = 'PD_SKILLS_DIR';

export class SkillNotFoundError extends Error {
  constructor(
    readonly skillName: string,
    readonly dir: string,
  ) {
    super(`Skill "${skillName}" not found: no SKILL.md in ${dir}. Set ${SKILLS_DIR_ENV} to the folder that holds the skills.`);
    this.name = 'SkillNotFoundError';
  }
}

export class InvalidSkillNameError extends Error {
  constructor(readonly skillName: string) {
    super(`Invalid skill name ${JSON.stringify(skillName)}: use letters, digits, dot, dash and underscore only, with no path parts.`);
    this.name = 'InvalidSkillNameError';
  }
}

export interface LoadSkillOptions {
  dir?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function defaultSkillsDir(): string {
  const fromEnv = process.env[SKILLS_DIR_ENV];
  return fromEnv ? resolve(fromEnv) : join(repoRoot(), 'skills');
}

/** Read `key: value` lines between the leading `---` lines. Not full YAML. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = (kv[2] ?? '').trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    data[kv[1] as string] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

/** The real path of `<dir>/<name>/SKILL.md` when it is a regular file inside the real skills dir, else null. */
function resolveSkillFile(dir: string, name: string): string | null {
  try {
    const realDir = realpathSync(dir);
    const realFile = realpathSync(join(dir, name, 'SKILL.md'));
    if (!realFile.startsWith(realDir + sep)) return null;
    return statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

export function loadSkill(name: string, opts: LoadSkillOptions = {}): LoadedSkill {
  if (!NAME_RE.test(name) || name.includes('..')) throw new InvalidSkillNameError(name);
  const dir = opts.dir ? resolve(opts.dir) : defaultSkillsDir();
  const file = resolveSkillFile(dir, name);
  if (!file) throw new SkillNotFoundError(name, dir);
  const text = readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const version = data.version ? data.version : createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { name, version, body, dir };
}
