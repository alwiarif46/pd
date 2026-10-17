import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSkillLoader, StageRegistry } from './index.js';
import type { StageContext, StageHandler } from './index.js';

function skillsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'SKILL.md'), text);
  }
  return dir;
}

describe('FileSkillLoader', () => {
  const dir = skillsDir({
    'compliance-matrix': '# Compliance Matrix Skill\n\n**Version:** 1.2.0\n**Status:** Draft\n',
    unversioned: '# No version here\n',
  });
  const loader = new FileSkillLoader(dir);

  it('loads a skill with its version', async () => {
    expect(await loader.load('compliance-matrix')).toMatchObject({ name: 'compliance-matrix', version: '1.2.0' });
  });

  it('rejects a skill with no version', async () => {
    await expect(loader.load('unversioned')).rejects.toThrow(/Version/);
  });

  it('rejects path traversal in the name', async () => {
    await expect(loader.load('../etc')).rejects.toThrow(/invalid skill name/);
  });
});

describe('StageRegistry', () => {
  const dir = skillsDir({ 'compliance-matrix': '**Version:** 2.0.0\n' });
  const ctx: StageContext = { tenantId: 't', runId: 'r', skills: new FileSkillLoader(dir) };
  const shred: StageHandler<{ text: string }, { rows: number }> = {
    key: 'shred',
    skill: 'compliance-matrix',
    parseInput(raw) {
      if (typeof (raw as { text?: unknown })?.text !== 'string') throw new Error('text required');
      return raw as { text: string };
    },
    async run(input, c) {
      const skill = await c.skills.load(this.skill);
      return { output: { rows: input.text.length }, skill: { name: skill.name, version: skill.version } };
    },
    gate: (out) => ({ passed: out.rows > 0, reasons: out.rows > 0 ? [] : ['no rows'] }),
  };

  it('runs a handler, records the skill version, and applies the gate', async () => {
    const registry = new StageRegistry();
    registry.register(shred);
    const res = await registry.execute('shred', { text: 'abc' }, ctx);
    expect(res.skill).toEqual({ name: 'compliance-matrix', version: '2.0.0' });
    expect(res.gate.passed).toBe(true);
    expect((await registry.execute('shred', { text: '' }, ctx)).gate).toEqual({ passed: false, reasons: ['no rows'] });
  });

  it('rejects bad input, duplicate and unknown stages', async () => {
    const registry = new StageRegistry();
    registry.register(shred);
    expect(() => registry.register(shred)).toThrow(/already registered/);
    await expect(registry.execute('shred', {}, ctx)).rejects.toThrow(/text required/);
    expect(() => registry.get('draft')).toThrow(/no handler/);
  });
});
