import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiSkillLoader, StageRegistry } from './index.js';
import type { StageContext, StageHandler } from './index.js';

const savedDir = process.env.PD_SKILLS_DIR;
afterEach(() => {
  if (savedDir === undefined) delete process.env.PD_SKILLS_DIR;
  else process.env.PD_SKILLS_DIR = savedDir;
});

function useSkills(files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'SKILL.md'), text);
  }
  process.env.PD_SKILLS_DIR = dir;
}

describe('AiSkillLoader', () => {
  it('loads a skill with its version', async () => {
    useSkills({
      'compliance-matrix': '# Compliance Matrix Skill\n\n**Version:** 1.2.0\n**Status:** Draft\n',
    });
    expect(await new AiSkillLoader().load('compliance-matrix')).toMatchObject({
      name: 'compliance-matrix',
      version: '1.2.0',
    });
  });

  it('rejects an unknown skill', async () => {
    useSkills({});
    await expect(new AiSkillLoader().load('missing')).rejects.toThrow(/Skill not found/);
  });
});

describe('StageRegistry', () => {
  const makeCtx = (): StageContext => {
    useSkills({
      'compliance-matrix': '**Version:** 2.0.0\n',
      'plain-language': '**Version:** 0.3.0\n',
    });
    return { tenantId: 't', runId: 'r', skillLoader: new AiSkillLoader() };
  };
  const draft: StageHandler<{ text: string }, { rows: number }> = {
    key: 'draft',
    skills: ['compliance-matrix', 'plain-language'],
    parseInput(raw) {
      if (typeof (raw as { text?: unknown })?.text !== 'string') throw new Error('text required');
      return raw as { text: string };
    },
    async run(input, c) {
      const skills = await Promise.all(this.skills.map((n) => c.skillLoader.load(n)));
      return {
        output: { rows: input.text.length },
        skills: skills.map(({ name, version }) => ({ name, version })),
      };
    },
    gate: (out) => ({
      passed: out.rows > 0,
      reasons: out.rows > 0 ? [] : ['no rows'],
    }),
  };

  it('runs a handler, records every skill version, and applies the gate', async () => {
    const ctx = makeCtx();
    const registry = new StageRegistry();
    registry.register(draft);
    const res = await registry.execute('draft', { text: 'abc' }, ctx);
    expect(res.skills).toEqual([
      { name: 'compliance-matrix', version: '2.0.0' },
      { name: 'plain-language', version: '0.3.0' },
    ]);
    expect(res.gate.passed).toBe(true);
    expect((await registry.execute('draft', { text: '' }, ctx)).gate).toEqual({
      passed: false,
      reasons: ['no rows'],
    });
  });

  it('rejects bad input, duplicate and unknown stages', async () => {
    const ctx = makeCtx();
    const registry = new StageRegistry();
    registry.register(draft);
    expect(() => registry.register(draft)).toThrow(/already registered/);
    await expect(registry.execute('draft', {}, ctx)).rejects.toThrow(/text required/);
    expect(() => registry.get('shred')).toThrow(/no handler/);
  });
});
