/**
 * Every BullMQ job id the api and the worker produce passes BullMQ's own id check. The Queue
 * class is replaced by one whose add() runs the real Job.prototype.validateOptions from the
 * installed bullmq (the check Queue.add makes before it writes to Redis), so no Redis is needed.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { legacyQueueJobId, queueJobId } from '@pd/core';

const added = vi.hoisted(() => [] as { queue: string; jobId: string | undefined }[]);

vi.mock('bullmq', async (importOriginal) => {
  const real = await importOriginal<typeof import('bullmq')>();
  /** Runs BullMQ's validation of the add options, as Queue.add does. */
  function validate(name: string, data: unknown, opts: { jobId?: string }) {
    const validateOptions = (real.Job.prototype as unknown as { validateOptions: (jobData: { data: string }) => void }).validateOptions;
    validateOptions.call({ name, opts }, { data: JSON.stringify(data) });
  }
  class Queue {
    constructor(readonly name: string) {}
    async add(name: string, data: unknown, opts: { jobId?: string } = {}) {
      validate(name, data, opts);
      added.push({ queue: this.name, jobId: opts.jobId });
      return { id: opts.jobId };
    }
    async close() {}
  }
  return { ...real, Queue, validateForTest: validate };
});

const STAGES = ['scan', 'file', 'marking', 'classify', 'ai:overview', 'ai:dates', 'ai:compliance', 'ai:amendment'];

describe('BullMQ job ids', () => {
  it('the check is real: the old two-part ids are refused', async () => {
    const bullmq = await import('bullmq') as unknown as { validateForTest: (name: string, data: unknown, opts: { jobId?: string }) => void };
    expect(() => bullmq.validateForTest('scan', {}, { jobId: `scan:${randomUUID()}` })).toThrow('Custom Id cannot contain :');
    expect(() => bullmq.validateForTest('scan', {}, { jobId: legacyQueueJobId('classify', randomUUID()) })).toThrow('Custom Id cannot contain :');
    expect(() => bullmq.validateForTest('scan', {}, { jobId: '12' })).toThrow('Custom Id cannot be integers');
  });

  it('queueJobId is accepted for every stage and holds no colon', async () => {
    const bullmq = await import('bullmq') as unknown as { validateForTest: (name: string, data: unknown, opts: { jobId?: string }) => void };
    for (const stage of STAGES) {
      const id = queueJobId(stage, randomUUID());
      expect(id).not.toContain(':');
      expect(() => bullmq.validateForTest(stage, {}, { jobId: id })).not.toThrow();
    }
    const jobId = randomUUID();
    expect(queueJobId('ai:amendment', jobId)).toBe(`ai-amendment-${jobId}`);
  });

  it('the api and worker producers add with accepted ids', async () => {
    const api = await import('../src/queue.js');
    const worker = await import('../../worker/src/enqueue.js');
    const payload = { orgId: randomUUID(), bidId: randomUUID(), documentId: randomUUID(), jobId: randomUUID(), storagePath: '', kind: 'amendment' as const };
    added.length = 0;
    await api.enqueueScan(payload);
    await api.enqueueClassify(payload);
    for (const stage of STAGES) {
      await worker.enqueue(stage, payload);
    }
    expect(added.map((item) => item.jobId)).toEqual([
      `scan-${payload.jobId}`,
      `classify-${payload.jobId}`,
      ...STAGES.map((stage) => queueJobId(stage, payload.jobId)),
    ]);
  });
});
