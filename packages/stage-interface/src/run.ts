import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadSkill, type LoadSkillOptions } from './skills';
import type { GateResult, JSONSchema, LoadedSkill, StageContext, StageHandler, StageResult } from './types';

export interface RunStageOptions {
  /** Where to look for skills. Defaults to PD_SKILLS_DIR, then the repo's skills folder. */
  skills?: LoadSkillOptions;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

function check(schema: JSONSchema, value: unknown): string[] {
  const fn = ajv.compile(schema);
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error('Stage aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** Run one stage. Stage errors come back as a result with status 'failed'; this function does not throw for them. */
export async function runStage<I, O>(
  handler: StageHandler<I, O>,
  ctx: Omit<StageContext, 'skill'> & { skill?: LoadedSkill | null },
  inputs: I,
  opts: RunStageOptions = {},
): Promise<StageResult<O>> {
  let skill: LoadedSkill | null = null;
  const skillInfo = () => (skill ? { name: skill.name, version: skill.version } : null);
  const failed = (error: string): StageResult<O> => ({
    stageId: ctx.stageId,
    status: 'failed',
    gate: { pass: false, reasons: [error] },
    skill: skillInfo(),
    error,
  });

  try {
    if (ctx.signal?.aborted) return failed('Stage aborted');

    const inputErrors = check(handler.inputSchema, inputs);
    if (inputErrors.length > 0) return failed(`Invalid inputs for stage ${handler.id}: ${inputErrors.join('; ')}`);

    if (handler.skill) skill = loadSkill(handler.skill.name, opts.skills);

    const stageCtx: StageContext = { ...ctx, skill };
    const work = handler.run(stageCtx, inputs);
    const outputs = await (ctx.signal ? Promise.race([work, aborted(ctx.signal)]) : work);

    const outputErrors = check(handler.outputSchema, outputs);
    if (outputErrors.length > 0) return failed(`Invalid outputs from stage ${handler.id}: ${outputErrors.join('; ')}`);

    const gate: GateResult = handler.gateCheck(outputs);
    return {
      stageId: ctx.stageId,
      status: gate.pass ? 'done' : 'gate_failed',
      outputs,
      gate,
      skill: skillInfo(),
    };
  } catch (err) {
    return failed(message(err));
  }
}
