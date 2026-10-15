/**
 * BullMQ job ids. BullMQ refuses a custom job id that holds ':' unless it splits into exactly
 * three parts (a legacy repeatable-job format), so `scan:<uuid>` and `classify:<uuid>` were
 * refused on every add. Ids here hold no ':' at all: the stage name with ':' turned into '-',
 * then '-', then the jobs row id (a UUID). One id per stage and jobs row keeps BullMQ's dedupe:
 * a second add under an id it has seen is ignored.
 */
export function queueJobId(stage: string, jobId: string): string {
  return `${stage.replace(/:/g, '-')}-${jobId}`;
}

/**
 * The id the code used before this format, `${stage}:${jobId}`. BullMQ only ever accepted it for
 * the ai:* stages (three parts), so jobs queued before the change may still sit under it there.
 * Lookups (queue-stats) try it after the current id.
 */
export function legacyQueueJobId(stage: string, jobId: string): string {
  return `${stage}:${jobId}`;
}
