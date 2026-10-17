import type { StageKey } from './stages.js';

/** The skill a stage ran, stored on the stage record (04 s4). */
export interface SkillRef {
  name: string;
  version: string;
}

export interface Skill extends SkillRef {
  /** SKILL.md body. Only the stage interface reads it. */
  instructions: string;
}

export interface SkillLoader {
  load(name: string): Promise<Skill>;
}

export interface StageContext {
  tenantId: string;
  runId: string;
  skills: SkillLoader;
  signal?: AbortSignal;
}

export interface GateResult {
  passed: boolean;
  /** Why the output failed the gate. Empty when it passed. */
  reasons: string[];
}

export interface StageResult<Output> {
  output: Output;
  skill: SkillRef;
}

/**
 * One handler per stage. The orchestrator calls handlers through this contract only,
 * so a rebuilt skill swaps in without touching the orchestrator or any other stage.
 */
export interface StageHandler<Input = unknown, Output = unknown> {
  readonly key: StageKey;
  /** Name of the skill this handler loads through the interface. */
  readonly skill: string;
  /** Throws on malformed input. */
  parseInput(raw: unknown): Input;
  run(input: Input, ctx: StageContext): Promise<StageResult<Output>>;
  gate(output: Output): GateResult;
}
