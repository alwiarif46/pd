// UI contracts: docs/plans/09-ui-workflow.md section 5 (5.1 to 5.18), written once and complete.
// v0 and ui components import these from '@/types'; containers map API DTOs (`import type { BidDto } from '@/api'`) to them.
// Do not redefine these in design/v0 or src/ui: apps/web/scripts/integrate-v0.mjs replaces v0's copies with these.
export * from './shared';
export * from './auth';
export * from './bids';
export * from './overview';
export * from './schedule';
export * from './compliance';
export * from './outline';
export * from './resumes';
export * from './reviews';
export * from './production';
export * from './orals';
export * from './lessons';
export * from './documents';
export * from './organization';
export * from './account';
export * from './privacy';
export * from './row-detail';
export * from './source-viewer';
