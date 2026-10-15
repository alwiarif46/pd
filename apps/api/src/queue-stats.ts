import { Queue } from 'bullmq';

/** Pipeline stages, each a BullMQ queue named after the stage. A job is `${stage}:${jobId}`. */
export const STAGES = ['scan', 'file', 'marking', 'classify', 'ai:overview', 'ai:dates', 'ai:compliance', 'ai:amendment'] as const;

export const MIN_SAMPLES = 5;
const SAMPLE_LIMIT = 100;
const MEDIAN_TTL_MS = 60_000;
const REDIS_TIMEOUT_MS = 2_000;

/** What the stats need from one stage queue. The default reads BullMQ; tests supply a fake. */
export interface StageQueue {
  /** Ids of waiting jobs (`${stage}:${jobId}`), next to run first, across all organizations. */
  waitingIds(): Promise<string[]>;
  /** BullMQ state of one job in this queue, or null if the queue does not hold it. */
  jobState(id: string): Promise<string | null>;
  /** finishedOn - processedOn, in milliseconds, of the latest completed jobs. */
  completedDurations(limit: number): Promise<number[]>;
}

export type QueueSource = (stage: string) => StageQueue;

const queues = new Map<string, Queue>();

function bullQueue(stage: string): StageQueue {
  let queue = queues.get(stage);
  if (!queue) {
    queue = new Queue(stage, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    });
    queues.set(stage, queue);
  }
  const q = queue;
  return {
    waitingIds: async () => (await q.getRanges(['waiting'], 0, -1, true)).map(String),
    jobState: async (id) => {
      const job = await q.getJob(id);
      return job ? await job.getState() : null;
    },
    completedDurations: async (limit) => {
      const jobs = await q.getCompleted(0, limit - 1);
      return jobs.flatMap((job) => (job.finishedOn && job.processedOn ? [job.finishedOn - job.processedOn] : []));
    },
  };
}

let source: QueueSource = bullQueue;
const medianCache = new Map<string, { at: number; value: number | null }>();

/** Test hook: replace the queue source (null restores BullMQ) and clear cached medians. */
export function setQueueSource(next: QueueSource | null): void {
  source = next ?? bullQueue;
  medianCache.clear();
}

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median run time of a stage in milliseconds, or null with fewer than MIN_SAMPLES. Cached 60 s. */
export async function stageMedianMs(stage: string, now = Date.now()): Promise<number | null> {
  const cached = medianCache.get(stage);
  if (cached && now - cached.at < MEDIAN_TTL_MS) {
    return cached.value;
  }
  const durations = (await source(stage).completedDurations(SAMPLE_LIMIT)).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const value = durations.length >= MIN_SAMPLES ? median(durations) : null;
  medianCache.set(stage, { at: now, value });
  return value;
}

/** Stages that follow `stage` for a document of this kind (the worker's hand-offs). */
export function stagesAfter(stage: string, documentKind: string | null): string[] {
  const chain = ['scan', 'file', 'marking', 'classify'];
  const tail = documentKind === 'amendment'
    ? ['ai:amendment']
    : documentKind === 'solicitation' || documentKind === 'attachment'
      ? ['ai:overview', 'ai:dates', 'ai:compliance']
      : [];
  const all = [...chain, ...tail];
  const index = all.indexOf(stage);
  // The ai:* stages run side by side; once one is reached the others are not "left".
  if (index < 0 || stage.startsWith('ai:')) {
    return [];
  }
  return all.slice(index + 1);
}

export interface JobStageInfo {
  stage: string | null;
  queuePosition: number | null;
  queueDepth: number;
  etaSeconds: number | null;
}

export interface StatsInput {
  id: string;
  documentKind: string | null;
}

const EMPTY: JobStageInfo = { stage: null, queuePosition: null, queueDepth: 0, etaSeconds: null };
const HOLDING = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Queue lookup timed out')), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stage, position, depth and ETA for unfinished jobs. If the queue cannot be reached the
 * jobs come back with nulls, so the list still loads. `concurrency` is
 * provider_settings.maxConcurrent.
 */
export async function queueInfo(jobs: StatsInput[], concurrency: number): Promise<Map<string, JobStageInfo>> {
  const result = new Map<string, JobStageInfo>();
  if (jobs.length === 0) {
    return result;
  }
  try {
    return await withTimeout(compute(jobs, Math.max(1, concurrency), result));
  } catch {
    for (const job of jobs) {
      result.set(job.id, EMPTY);
    }
    return result;
  }
}

async function compute(jobs: StatsInput[], concurrency: number, result: Map<string, JobStageInfo>) {
  const waitingByStage = new Map<string, string[]>();
  const waiting = async (stage: string) => {
    let ids = waitingByStage.get(stage);
    if (!ids) {
      ids = await source(stage).waitingIds();
      waitingByStage.set(stage, ids);
    }
    return ids;
  };
  for (const job of jobs) {
    let found: { stage: string; state: string } | null = null;
    for (const stage of STAGES) {
      const state = await source(stage).jobState(`${stage}:${job.id}`);
      if (state && HOLDING.has(state)) {
        found = { stage, state };
        break;
      }
    }
    if (!found) {
      result.set(job.id, EMPTY);
      continue;
    }
    const ids = await waiting(found.stage);
    const index = found.state === 'waiting' ? ids.indexOf(`${found.stage}:${job.id}`) : -1;
    const queuePosition = index >= 0 ? index + 1 : null;
    let etaSeconds: number | null = null;
    if (queuePosition !== null) {
      const stages = [found.stage, ...stagesAfter(found.stage, job.documentKind)];
      const medians = await Promise.all(stages.map((stage) => stageMedianMs(stage)));
      if (medians.every((value): value is number => value !== null)) {
        const [own, ...rest] = medians;
        etaSeconds = Math.ceil((Math.ceil(queuePosition / concurrency) * own + rest.reduce((a, b) => a + b, 0)) / 1000);
      }
    }
    result.set(job.id, { stage: found.stage, queuePosition, queueDepth: ids.length, etaSeconds });
  }
  return result;
}
