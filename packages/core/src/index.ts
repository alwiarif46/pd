// Core shared types and utilities

export interface Bid {
  id: string;
  orgId: string;
  name: string;
  solicitationKey: string;
  bidType: 'federal' | 'sled';
  status: 'draft' | 'active' | 'archived';
  createdAt: Date;
  dueDate?: Date;
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

// Database
export * from './db';
