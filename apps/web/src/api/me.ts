import { request, type CallOptions } from './http';
import type { MeDto, MePatch, Ok } from './types';

export function getMe(opts?: CallOptions): Promise<MeDto> {
  return request('/api/me', { signal: opts?.signal });
}

export function updateMe(patch: MePatch, opts?: CallOptions): Promise<Ok> {
  return request('/api/me', { method: 'PATCH', json: patch, signal: opts?.signal });
}
