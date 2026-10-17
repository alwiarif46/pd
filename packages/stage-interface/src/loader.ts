import { loadSkill } from '@pd/ai';
import type { Skill, SkillLoader } from './types.js';

/**
 * Loads skills through the existing PD loader in `@pd/ai`, which reads `skills/{name}/SKILL.md`
 * from `PD_SKILLS_DIR` (default: `./skills`) and takes the version from its `**Version:**` line.
 */
export class AiSkillLoader implements SkillLoader {
  async load(name: string): Promise<Skill> {
    const skill = loadSkill(name);
    return {
      name: skill.name,
      version: cleanVersion(skill.version),
      instructions: skill.systemPrompt,
    };
  }
}

/**
 * `loadSkill` splits the line `**Version:** 1.0.0` on its first colon, so it returns `** 1.0.0`.
 * Strip the leftover markdown here until `@pd/ai` is fixed in its own PR (shared packages change alone).
 */
function cleanVersion(raw: string): string {
  return raw.replace(/^[*\s]+/, '');
}
