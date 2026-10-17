export type JSONSchema = Record<string, unknown> | boolean;

export interface LoadedSkill {
  name: string;
  /** The frontmatter `version`, or the first 12 hex characters of the SHA-256 of the file. */
  version: string;
  /** SKILL.md text after the frontmatter. */
  body: string;
  /** The skills directory the skill was read from. */
  dir: string;
}

export interface StageContext {
  tenantId: string;
  runId: string;
  stageId: string;
  /** Set by runStage from the handler's skill declaration. Callers do not pass it. */
  skill: LoadedSkill | null;
  signal?: AbortSignal;
  // The model gateway client joins this context in chat 3.
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

export interface StageHandler<I = unknown, O = unknown> {
  id: string;
  /** The service that owns the handler. */
  service: string;
  /**
   * The skill that supplies the stage prompt, or null for a stage with no skill.
   * When `version` is set and the loaded skill has a different version, the stage fails.
   */
  skill: { name: string; version?: string } | null;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  run(ctx: StageContext, inputs: I): Promise<O>;
  gateCheck(outputs: O): GateResult;
}

export interface StageResult<O = unknown> {
  stageId: string;
  status: 'done' | 'failed' | 'gate_failed';
  outputs?: O;
  gate: GateResult;
  /** The skill name and version the stage ran with. Null when the handler declares no skill. */
  skill: { name: string; version: string } | null;
  error?: string;
}
