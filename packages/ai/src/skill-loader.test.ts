import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkill } from './skill-loader.ts';

describe('loadSkill', () => {
  let dir: string;
  const previous = process.env.PD_SKILLS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    process.env.PD_SKILLS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PD_SKILLS_DIR;
    else process.env.PD_SKILLS_DIR = previous;
  });

  const write = (name: string, body: string) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'SKILL.md'), body);
  };

  it('reads the version after the bold label without stray characters', () => {
    write('demo', '# Demo\n**Version:** 2.3.1\n**Status:** active\n\n## Instructions\nDo it.\n');
    const skill = loadSkill('demo');
    expect(skill.version).toBe('2.3.1');
    expect(skill.promptVersion).toBe('2.3.1');
  });

  it('keeps colons inside the value', () => {
    write('demo', '**Version:** 1.0.0-rc:2\n\n## Instructions\nx\n');
    expect(loadSkill('demo').version).toBe('1.0.0-rc:2');
  });

  it('defaults to 1.0.0 when no version line exists', () => {
    write('demo', '## Instructions\nx\n');
    expect(loadSkill('demo').version).toBe('1.0.0');
  });

  it('handles CRLF files and a missing space after the label', () => {
    write('crlf', '**Version:** 2.0.0\r\n\r\n## Instructions\r\nx\r\n');
    write('tight', '**Version:**3.0.0\n\n## Instructions\nx\n');
    expect(loadSkill('crlf').version).toBe('2.0.0');
    expect(loadSkill('tight').version).toBe('3.0.0');
  });

  it('falls back to 1.0.0 for a blank value', () => {
    write('demo', '**Version:**\n\n## Instructions\nx\n');
    expect(loadSkill('demo').version).toBe('1.0.0');
  });

  it('ignores Version lines inside the body', () => {
    write('demo', '**Version:** 1.2.0\n\n## Instructions\n**Version:** 9.9.9\n');
    expect(loadSkill('demo').version).toBe('1.2.0');
  });
});
