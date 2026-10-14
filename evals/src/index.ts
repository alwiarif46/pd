// Evaluation harness entry point

import { runHarness, saveResults } from './harness';
import type { HarnessConfig } from './harness';
import type { GoldenDocument } from './types';

export { runHarness, saveResults };
export * from './types';
export * from './scoring';
export * from './benchmark';
