import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
