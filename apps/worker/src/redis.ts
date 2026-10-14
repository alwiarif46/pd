export const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
};

export const dataDir = process.env.DATA_DIR || '/data/files';

export interface JobPayload {
  orgId: string;
  bidId: string;
  documentId: string;
  jobId: string;
  storagePath: string;
  kind: 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
}
