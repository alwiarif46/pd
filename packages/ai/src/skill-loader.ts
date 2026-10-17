import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Skill {
  name: string;
  version: string;
  instructions: string;
  metadata: {
    purpose: string;
    status: string;
  };
}

export interface LoadedSkill {
  name: string;
  version: string;
  systemPrompt: string;
  promptVersion: string;
}

export function skillsRoot(): string {
  if (process.env.PD_SKILLS_DIR) {
    return process.env.PD_SKILLS_DIR;
  }
  return join(process.cwd(), 'skills');
}

export function loadSkill(skillName: string): LoadedSkill {
  const skillPath = join(skillsRoot(), skillName, 'SKILL.md');
  if (!existsSync(skillPath)) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  const skill = parseSkillMarkdown(readFileSync(skillPath, 'utf-8'), skillName);
  return {
    name: skill.name,
    version: skill.version,
    systemPrompt: skill.instructions,
    promptVersion: skill.version,
  };
}

function sectionBody(lines: string[], heading: string): string {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return '';
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    body.push(line);
  }
  return body.join('\n').trim();
}

function parseSkillMarkdown(content: string, skillName: string): Skill {
  const lines = content.split(/\r?\n/);
  let version = '';
  let status = '';
  for (const line of lines) {
    if (line.startsWith('## ')) {
      break;
    }
    if (!version && line.startsWith('**Version:**')) {
      version = line.slice('**Version:**'.length).trim();
    } else if (!status && line.startsWith('**Status:**')) {
      status = line.slice('**Status:**'.length).trim();
    }
  }
  version ||= '1.0.0';
  status ||= 'draft';
  return {
    name: skillName,
    version,
    instructions: sectionBody(lines, '## Instructions'),
    metadata: {
      purpose: sectionBody(lines, '## Purpose'),
      status,
    },
  };
}

export function listSkills(): string[] {
  const root = skillsRoot();
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function buildSystemPrompt(skill: LoadedSkill, taskPrompt: string): string {
  return `${skill.systemPrompt}\n\n${taskPrompt}`;
}

export function getSkillVersion(skillName: string): string {
  return loadSkill(skillName).version;
}
