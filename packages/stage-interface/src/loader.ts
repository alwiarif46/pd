import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Skill, SkillLoader } from './types.js';

const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_LINE = /^\*\*Version:\*\*\s*(\S+)\s*$/m;

/** Reads `skills/{name}/SKILL.md` under `skillsDir`. The version comes from the `**Version:**` line. */
export class FileSkillLoader implements SkillLoader {
  constructor(private readonly skillsDir: string) {}

  async load(name: string): Promise<Skill> {
    if (!VALID_NAME.test(name)) throw new Error(`invalid skill name: ${name}`);
    const text = await readFile(join(this.skillsDir, name, 'SKILL.md'), 'utf8');
    const version = VERSION_LINE.exec(text)?.[1];
    if (!version) throw new Error(`skill ${name} has no **Version:** line`);
    return { name, version, instructions: text };
  }
}
