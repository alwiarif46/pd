import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { InvalidSkillNameError, SkillNotFoundError, loadSkill } from '../src/index';

const dir = join(__dirname, 'fixtures', 'skills');

describe('loadSkill', () => {
  afterEach(() => {
    delete process.env.PD_SKILLS_DIR;
  });

  it('uses the frontmatter version', () => {
    const s = loadSkill('stub-versioned', { dir });
    expect(s.version).toBe('2.3.0');
    expect(s.name).toBe('stub-versioned');
    expect(s.body).toBe('You are a stub skill with a declared version.\n');
    expect(s.dir).toBe(dir);
  });

  it('falls back to 12 hex of the file hash', () => {
    const s = loadSkill('stub-plain', { dir });
    const text = readFileSync(join(dir, 'stub-plain', 'SKILL.md'), 'utf8');
    expect(s.version).toBe(createHash('sha256').update(text).digest('hex').slice(0, 12));
    expect(s.version).toMatch(/^[0-9a-f]{12}$/);
    expect(s.body).toBe(text);
  });

  it('honors PD_SKILLS_DIR', () => {
    process.env.PD_SKILLS_DIR = dir;
    expect(loadSkill('stub-plain').dir).toBe(dir);
  });

  it('opts.dir wins over the env var', () => {
    process.env.PD_SKILLS_DIR = '/nonexistent';
    expect(loadSkill('stub-plain', { dir }).dir).toBe(dir);
  });

  it('rejects path traversal and separators', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '.hidden', '', 'a..b']) {
      expect(() => loadSkill(bad, { dir })).toThrow(InvalidSkillNameError);
    }
  });

  it('names the dir and the env var when a skill is missing', () => {
    expect(() => loadSkill('nope', { dir })).toThrow(SkillNotFoundError);
    try {
      loadSkill('nope', { dir });
    } catch (err) {
      expect((err as Error).message).toContain(dir);
      expect((err as Error).message).toContain('PD_SKILLS_DIR');
    }
  });
});

describe('loadSkill containment', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  const skillsDir = join(root, 'skills');
  const outside = join(root, 'outside');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(join(outside, 'secret'), { recursive: true });
  writeFileSync(join(outside, 'secret', 'SKILL.md'), 'TOP SECRET\n');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.PD_SKILLS_DIR;
  });

  it('refuses a skill directory that is a symlink out of the skills dir', () => {
    symlinkSync(join(outside, 'secret'), join(skillsDir, 'linked-dir'), 'dir');
    expect(() => loadSkill('linked-dir', { dir: skillsDir })).toThrow(SkillNotFoundError);
  });

  it('refuses a SKILL.md that is a symlink out of the skills dir', () => {
    mkdirSync(join(skillsDir, 'linked-file'));
    symlinkSync(join(outside, 'secret', 'SKILL.md'), join(skillsDir, 'linked-file', 'SKILL.md'), 'file');
    expect(() => loadSkill('linked-file', { dir: skillsDir })).toThrow(SkillNotFoundError);
  });

  it('allows a symlink that stays inside the skills dir', () => {
    mkdirSync(join(skillsDir, 'real'));
    writeFileSync(join(skillsDir, 'real', 'SKILL.md'), 'inside\n');
    symlinkSync(join(skillsDir, 'real'), join(skillsDir, 'alias'), 'dir');
    expect(loadSkill('alias', { dir: skillsDir }).body).toBe('inside\n');
  });

  it('throws SkillNotFoundError, not EISDIR, when SKILL.md is a directory', () => {
    mkdirSync(join(skillsDir, 'dir-skill', 'SKILL.md'), { recursive: true });
    expect(() => loadSkill('dir-skill', { dir: skillsDir })).toThrow(SkillNotFoundError);
  });

  it('throws SkillNotFoundError when the skills dir does not exist', () => {
    expect(() => loadSkill('x', { dir: join(root, 'nope') })).toThrow(SkillNotFoundError);
  });

  it('resolves a relative PD_SKILLS_DIR against the working directory', () => {
    process.env.PD_SKILLS_DIR = relative(process.cwd(), dir);
    const s = loadSkill('stub-plain');
    expect(s.dir).toBe(dir);
  });
});
