import { getEventListeners } from 'node:events';
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
    expect(r.outputs?.count).toBe('You are a stub skill with a declared version.\n'.length);
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
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^Stage aborted/);
  });

  it('puts an Error abort reason in the message', async () => {
    const ac = new AbortController();
    const slow = handler({ run: () => new Promise<Out>(() => {}) });
    const p = runStage(slow, { ...ctx, signal: ac.signal }, { text: 'a' }, { skills });
    ac.abort(new Error('deadline passed'));
    expect(await p).toMatchObject({ status: 'failed', error: 'Stage aborted: deadline passed' });
    const pre = new AbortController();
    pre.abort(new Error('too late'));
    expect(await runStage(handler(), { ...ctx, signal: pre.signal }, { text: 'a' }, { skills })).toMatchObject({ error: 'Stage aborted: too late' });
  });

  it('leaves no abort listeners behind after 100 completed stages on one signal', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 100; i++) {
      const r = await runStage(handler(), { ...ctx, signal: ac.signal }, { text: 'abc' }, { skills });
      expect(r.status).toBe('done');
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    const failing = handler({ run: async () => { throw new Error('boom'); } });
    await runStage(failing, { ...ctx, signal: ac.signal }, { text: 'abc' }, { skills });
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
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

describe('runStage schemas', () => {
  it('rejects a typo keyword in the input schema and does not throw', async () => {
    const h = handler({ inputSchema: { type: 'object', requird: ['text'] } });
    const r = await runStage(h, ctx, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('inputSchema');
    expect(r.error).toContain('requird');
  });

  it('rejects a typo keyword in the output schema before running the handler', async () => {
    let ran = false;
    const h = handler({ outputSchema: { type: 'object', propertees: {} }, run: async () => ((ran = true), { count: 1 }) });
    const r = await runStage(h, ctx, { text: 'a' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('outputSchema');
    expect(ran).toBe(false);
  });

  it('accepts union types', async () => {
    const h = handler({ inputSchema: { type: 'object', properties: { text: { type: ['string', 'null'] } } } });
    expect((await runStage(h, ctx, { text: 'abc' }, { skills })).status).toBe('done');
  });

  it('rebuilding a handler with the same $id many times works', async () => {
    for (let i = 0; i < 300; i++) {
      const h = handler({
        inputSchema: { $id: 'https://test.local/in', type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        outputSchema: { $id: 'https://test.local/out', type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
      });
      const r = await runStage(h, ctx, { text: 'abc' }, { skills });
      expect(r.status).toBe('done');
    }
  });

  it('does not reuse a cached schema for a different schema with the same $id', async () => {
    const a = handler({ inputSchema: { $id: 'https://test.local/clash', type: 'object', required: ['text'] } });
    const b = handler({ inputSchema: { $id: 'https://test.local/clash', type: 'object', required: ['other'] } });
    expect((await runStage(a, ctx, { text: 'x' }, { skills })).status).toBe('done');
    const r = await runStage(b, ctx, { text: 'x' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('other');
  });
});

describe('runStage skill version', () => {
  it('runs when the declared version matches', async () => {
    const r = await runStage(handler({ skill: { name: 'stub-versioned', version: '2.3.0' } }), ctx, { text: 'abc' }, { skills });
    expect(r.status).toBe('done');
  });

  it('fails when the loaded version differs', async () => {
    let ran = false;
    const h = handler({ skill: { name: 'stub-versioned', version: '9.9.9' }, run: async () => ((ran = true), { count: 1 }) });
    const r = await runStage(h, ctx, { text: 'abc' }, { skills });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('stub-versioned');
    expect(r.error).toContain('2.3.0');
    expect(r.error).toContain('9.9.9');
    expect(ran).toBe(false);
  });

  it('does not take a skill from the caller context', async () => {
    // @ts-expect-error runStage sets skill itself
    const r = await runStage(handler({ skill: null }), { ...ctx, skill: null }, { text: 'abc' });
    expect(r.status).toBe('done');
  });
});

describe('schema isolation', () => {
  it('a typo schema does not poison its $id for a corrected handler', async () => {
    const typo = handler({ inputSchema: { $id: 'https://test.local/typo', type: 'objekt' } as never });
    const bad = await runStage(typo, ctx, { text: 'a' }, { skills });
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('Invalid inputSchema');
    const fixed = handler({ inputSchema: { $id: 'https://test.local/typo', type: 'object', required: ['text'] } });
    const ok = await runStage(fixed, ctx, { text: 'a' }, { skills });
    expect(ok.status).toBe('done');
  });

  it('a $ref to another handler $id fails whatever the run order', async () => {
    const a = handler({ id: 'a', inputSchema: { $id: 'https://test.local/shared-a', type: 'object' } });
    const b = handler({ id: 'b', inputSchema: { type: 'object', properties: { text: { $ref: 'https://test.local/shared-a' } } } });
    for (const order of [[a, b], [b, a]]) {
      const results = [];
      for (const h of order) results.push(await runStage(h, ctx, { text: 'x' }, { skills }));
      const rb = results[order.indexOf(b)]!;
      expect(rb.status).toBe('failed');
      expect(rb.error).toContain('Invalid inputSchema');
    }
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
