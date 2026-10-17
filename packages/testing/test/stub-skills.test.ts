import { afterEach, describe, expect, it } from 'vitest';
import { loadSkill } from '@pd/stage-interface';
import { STUB_SKILL_NAMES, STUB_SKILLS_DIR, withStubSkills } from '../src/stub-skills';

const before = process.env.PD_SKILLS_DIR;
afterEach(() => {
  if (before === undefined) delete process.env.PD_SKILLS_DIR;
  else process.env.PD_SKILLS_DIR = before;
});

describe('stub skills', () => {
  it('load through the stage interface with PD_SKILLS_DIR', async () => {
    await withStubSkills(() => {
      const shred = loadSkill('stub-shred');
      expect(shred.version).toBe('0.0.1-stub');
      expect(shred.dir).toBe(STUB_SKILLS_DIR);
      expect(loadSkill('stub-compliance-matrix').version).toBe('0.0.1-stub');
    });
  });

  it('falls back to a content hash when there is no version line', async () => {
    await withStubSkills(() => {
      const summary = loadSkill('stub-bid-summary');
      expect(summary.version).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  it('has one stub per placeholder stage', async () => {
    await withStubSkills(() => {
      for (const name of STUB_SKILL_NAMES) expect(loadSkill(name).body.length).toBeGreaterThan(0);
    });
  });

  it('restores PD_SKILLS_DIR, set or unset, even when the callback throws', async () => {
    delete process.env.PD_SKILLS_DIR;
    await expect(withStubSkills(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(process.env.PD_SKILLS_DIR).toBeUndefined();

    process.env.PD_SKILLS_DIR = '/somewhere/else';
    const restore = withStubSkills();
    expect(process.env.PD_SKILLS_DIR).toBe(STUB_SKILLS_DIR);
    restore();
    expect(process.env.PD_SKILLS_DIR).toBe('/somewhere/else');
  });
});
