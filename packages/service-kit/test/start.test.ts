import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { logPoolErrors } from '../src/start';

describe('logPoolErrors', () => {
  it('logs an idle client error as an object with a fixed message, and nothing else', () => {
    const pool = new EventEmitter();
    const lines: Array<{ obj: unknown; msg: string }> = [];
    logPoolErrors(pool, { error: (obj, msg) => lines.push({ obj, msg }) });
    const err = new Error('terminating connection due to administrator command');
    pool.emit('error', err);
    expect(lines).toEqual([{ obj: { err }, msg: 'idle client error' }]);
    expect(JSON.stringify(lines)).not.toMatch(/postgres:\/\//);
  });

  it('keeps the process alive: with a listener, an emitted error does not throw', () => {
    const pool = new EventEmitter();
    logPoolErrors(pool, { error: () => undefined });
    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
  });
});
