// Core shared types and utilities

/** `bids.status` (5.2). Migration 0005 adds a CHECK on these values; new bids start in planning. */
export const BID_STATUSES = ['planning', 'writing', 'submitted', 'closed'] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export function isBidStatus(value: unknown): value is BidStatus {
  return typeof value === 'string' && (BID_STATUSES as readonly string[]).includes(value);
}

/** `documents.live_status` (03, 07 s2). */
export type DocumentLiveStatus = 'live' | 'archived' | 'restore_requested' | 'restoring' | 'restored' | 'deleted';

export interface Bid {
  id: string;
  orgId: string;
  name: string;
  agency: string | null;
  bidType: 'federal' | 'sled';
  solicitationNumber: string;
  solicitationKey: string;
  status: BidStatus;
  createdAt: Date;
  updatedAt: Date;
  startDate: Date | null;
  dueDate: Date | null;
  dueTime: string | null;
  timeZone: string | null;
  oralsEnabled: boolean;
  creditStatus: 'reserved' | 'consumed' | 'released' | null;
  keyOverridesUsed: number;
  retentionExtendedUntil: Date | null;
  /** The schedule's "Workdays only" setting (migration 0010). */
  scheduleWorkdaysOnly: boolean;
}

export interface Document {
  id: string;
  bidId: string;
  orgId: string;
  filename: string;
  sha256: string;
  size: number;
  docType: 'solicitation' | 'amendment' | 'attachment';
  uploadedAt: Date;
  status: 'uploading' | 'scanning' | 'processing' | 'ready' | 'error';
}

export interface UploadSession {
  id: string;
  bidId: string;
  orgId: string;
  filename: string;
  declaredSize: number;
  sha256: string;
  chunkCount: number;
  uploadedChunks: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface Job {
  id: string;
  bidId: string;
  orgId: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  queuePosition?: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export { PLAN_LIMITS, type Plan } from './limits';
export { resolveOrgPath } from './paths';
export * from './credits';
export * from './retention';
export * from './amendment-numbers';
export * from './job-ids';
export * from './schedule';

// Database
export * from './db';
