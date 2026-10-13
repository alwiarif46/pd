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

// Plan limits
export const PLAN_LIMITS = {
  free: {
    rfpCreditsFirstMonth: 2,
    rfpCreditsSubsequent: 1,
    maxUsers: 2,
    mbPerBid: 50,
    storageMb: 200,
  },
  starter: {
    rfpCreditsPerMonth: 10,
    maxUsers: 5,
    mbPerBid: 300,
    storageMb: 9000,
  },
  growth: {
    rfpCreditsPerMonth: 20,
    maxUsers: 5,
    mbPerBid: 300,
    storageMb: 18000,
  },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

// Database
export * from './db';
