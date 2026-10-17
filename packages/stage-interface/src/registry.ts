import type { StageKey } from './stages.js';
import type { GateResult, StageContext, StageHandler, StageResult } from './types.js';

export class StageRegistry {
  private readonly handlers = new Map<StageKey, StageHandler>();

  register<I, O>(handler: StageHandler<I, O>): void {
    if (this.handlers.has(handler.key)) throw new Error(`stage ${handler.key} already registered`);
    this.handlers.set(handler.key, handler as unknown as StageHandler);
  }

  get(key: StageKey): StageHandler {
    const handler = this.handlers.get(key);
    if (!handler) throw new Error(`no handler for stage ${key}`);
    return handler;
  }

  /** Parses the input, runs the handler, and applies its gate. */
  async execute(
    key: StageKey,
    rawInput: unknown,
    ctx: StageContext,
  ): Promise<StageResult<unknown> & { gate: GateResult }> {
    const handler = this.get(key);
    const result = await handler.run(handler.parseInput(rawInput), ctx);
    return { ...result, gate: handler.gate(result.output) };
  }
}
