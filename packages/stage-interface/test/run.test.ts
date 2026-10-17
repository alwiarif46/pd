import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StageRegistry, runStage, type StageHandler } from '../src/index';

const skills = { dir: join(__dirname, 'fixtures', 'skills') };
const ctx = { tenantId: 't1', runId: 'r1', stageId: 's1' };

interface In {
  text: string;
}
interface Out {
  count: number;
}

function handler(over: Partial<StageHandler<In, Out>> = {}): StageHandler<In, Out> {
  return {
    id: 'demo',
    service: 'intel',
    skill: { name: 'stub-versioned' },
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
    run: async (c, i) => ({ count: i.text.length + (c.skill ? 0 : 100) }),
    gateCheck: (o) => (o.count > 0 ? { pass: true, reasons: [] } : { pass: false, reasons: ['empty'] }),
    ...over,
  };
}

describe('runStage', () => {
  it('happy path records the skill name and version', async () => {
    const r = await runStage(handler(), ctx, { text: 'abc' }, { skills });
    expect(r).toMatchObject({ stageId: 's1', status: 'done', outputs: { count: 3 }, skill: { name: 'stub-versioned', version: '2.3.0' } });
    expect(r.gate).toEqual({ pass: true, reasons: [] });
  });

  it('passes the loaded skill to the handler', async () => {
    const h = handler({ run: async (c) => ({ count: c.skill?.body.length ?? -1 }) });
    const r = await runStage(h, ctx, { text: 'x' }, { skills });
    expect(r.status).toBe('done');
    expect(r.outputs?.count).toBeGreaterThan(0);
  });

  it('runs a stage with no skill', async () => {
    const r = await runStage(handler({ skill: null }), ctx, { text: 'abc' });
    expect(r.status).toBe('done');
    expect(r.skill).toBeNull();
    expect(r.outputs).toEqual({ count: 103 });
  });

  it('fails on bad input without running the handler', async () => {
    let ran = false;
    const r = await runStage(handler({ run: async () => ((ran = true), { count: 1 }) }), ctx, { text: 5 } as unknown as In, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Invalid inputs');
    expect(ran).toBe(false);
  });

  it('fails on bad output', async () => {
    const r = await runStage(handler({ run: async () => ({ count: 'x' }) as unknown as Out }), ctx, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Invalid outputs');
    expect(r.skill).toEqual({ name: 'stub-versioned', version: '2.3.0' });
  });

  it('reports a gate failure with outputs and reasons', async () => {
    const r = await runStage(handler(), ctx, { text: '' }, { skills });
    expect(r.status).toBe('gate_failed');
    expect(r.outputs).toEqual({ count: 0 });
    expect(r.gate).toEqual({ pass: false, reasons: ['empty'] });
  });

  it('returns failed when the handler throws', async () => {
    const r = await runStage(handler({ run: async () => { throw new Error('boom'); } }), ctx, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('boom');
  });

  it('returns failed when gateCheck throws', async () => {
    const r = await runStage(handler({ gateCheck: () => { throw new Error('gate boom'); } }), ctx, { text: 'a' }, { skills });
    expect(r).toMatchObject({ status: 'failed', error: 'gate boom' });
  });

  it('returns failed when the skill is missing', async () => {
    const r = await runStage(handler({ skill: { name: 'ghost' } }), ctx, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('ghost');
    expect(r.skill).toBeNull();
  });

  it('honors an abort during the run', async () => {
    const ac = new AbortController();
    const slow = handler({ run: () => new Promise<Out>(() => {}) });
    const p = runStage(slow, { ...ctx, signal: ac.signal }, { text: 'a' }, { skills });
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ status: 'failed', error: 'Stage aborted' });
  });

  it('does not start when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    const r = await runStage(handler({ run: async () => ((ran = true), { count: 1 }) }), { ...ctx, signal: ac.signal }, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(ran).toBe(false);
  });
});

describe('StageRegistry', () => {
  it('registers, gets and lists', () => {
    const reg = new StageRegistry();
    const a = handler({ id: 'a' });
    const b = handler({ id: 'b' });
    reg.register(a);
    reg.register(b);
    expect(reg.get('a')).toBe(a);
    expect(reg.get('zzz')).toBeUndefined();
    expect(reg.list().map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids', () => {
    const reg = new StageRegistry();
    reg.register(handler({ id: 'a' }));
    expect(() => reg.register(handler({ id: 'a' }))).toThrow(/already registered/);
  });
});
