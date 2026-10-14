import { request, seg, type CallOptions } from './http';
import type { JobDto } from './types';

export function listJobs(bidId: string, opts?: CallOptions): Promise<JobDto[]> {
  return request(`/api/bids/${seg(bidId)}/jobs`, { signal: opts?.signal });
}

/** Queues a new job for the same work. Returns the new job id. */
export function retryJob(jobId: string, opts?: CallOptions): Promise<{ id: string }> {
  return request(`/api/jobs/${seg(jobId)}/retry`, { method: 'POST', signal: opts?.signal });
}
