import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadSkill, type LoadSkillOptions } from './skills';
import type { GateResult, LoadedSkill, StageContext, StageHandler, StageResult } from './types';

export interface RunStageOptions {
  /** Where to look for skills. Defaults to PD_SKILLS_DIR, then the repo's skills folder. */
  skills?: LoadSkillOptions;
}

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  return ajv;
}

interface Compiled {
  input: ValidateFunction;
  output: ValidateFunction;
}

// Keyed by the handler object, so a handler is compiled once and the cache does not outlive it.
// Each handler gets its own Ajv, so one handler's schemas (a typo included) never affect another's,
// and a $ref to another handler's $id does not resolve.
const compiledByHandler = new WeakMap<object, Compiled>();

function compiledFor(handler: StageHandler<never, never>): Compiled {
  let entry = compiledByHandler.get(handler);
  if (entry) return entry;
  const ajv = newAjv();
  let input: ValidateFunction;
  let output: ValidateFunction;
  try {
    input = ajv.compile(handler.inputSchema);
  } catch (err) {
    throw new Error(`Invalid inputSchema for stage ${handler.id}: ${message(err)}`);
  }
  try {
    output = ajv.compile(handler.outputSchema);
  } catch (err) {
    throw new Error(`Invalid outputSchema for stage ${handler.id}: ${message(err)}`);
  }
  entry = { input, output };
  compiledByHandler.set(handler, entry);
  return entry;
}

function check(fn: ValidateFunction, value: unknown): string[] {
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? `Stage aborted: ${signal.reason.message}` : 'Stage aborted';
}

/** Wait for `work`, or reject when the signal aborts. The abort listener is always removed. */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(abortMessage(signal)));
    if (signal.aborted) fail();
    else {
      onAbort = fail;
      signal.addEventListener('abort', fail, { once: true });
    }
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Run one stage. Stage errors come back as a result with status 'failed'; this function does not throw for them. */
export async function runStage<I, O>(
  handler: StageHandler<I, O>,
  ctx: Omit<StageContext, 'skill'>,
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
    if (ctx.signal?.aborted) return failed(abortMessage(ctx.signal));

    const compiled = compiledFor(handler as StageHandler<never, never>);

    const inputErrors = check(compiled.input, inputs);
    if (inputErrors.length > 0) return failed(`Invalid inputs for stage ${handler.id}: ${inputErrors.join('; ')}`);

    if (handler.skill) {
      skill = loadSkill(handler.skill.name, opts.skills);
      const wanted = handler.skill.version;
      if (wanted !== undefined && wanted !== skill.version) {
        return failed(`Stage ${handler.id} needs skill ${skill.name} version ${wanted}, but version ${skill.version} is installed`);
      }
    }

    const stageCtx: StageContext = { ...ctx, skill };
    const work = handler.run(stageCtx, inputs);
    const outputs = await (ctx.signal ? raceAbort(work, ctx.signal) : work);

    const outputErrors = check(compiled.output, outputs);
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
