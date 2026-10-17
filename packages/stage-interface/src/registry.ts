import type { StageHandler } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = StageHandler<any, any>;

export class StageRegistry {
  private readonly handlers = new Map<string, AnyHandler>();

  register(handler: AnyHandler): void {
    if (this.handlers.has(handler.id)) throw new Error(`Stage handler already registered: ${handler.id}`);
    this.handlers.set(handler.id, handler);
  }

  get(id: string): AnyHandler | undefined {
    return this.handlers.get(id);
  }

  list(): AnyHandler[] {
    return [...this.handlers.values()];
  }
}
