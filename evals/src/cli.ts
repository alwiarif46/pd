#!/usr/bin/env node
// CLI entry point for evaluation harness

import { runHarness } from './harness';
import type { HarnessConfig } from './harness';

const config: HarnessConfig = {
  goldenSetPath: process.env.GOLDEN_SET_PATH || './golden-set.json',
  heldOutIds: (process.env.HELD_OUT_IDS || '').split(',').filter(Boolean),
  tuningIds: (process.env.TUNING_IDS || '').split(',').filter(Boolean),
  models: [
    {
      provider: process.env.PROVIDER || 'deepinfra',
      model: process.env.MODEL || 'Qwen/Qwen2.5-72B-Instruct',
      apiKey: process.env.API_KEY,
    },
  ],
  pipelineConfig: {
    providerName: process.env.PROVIDER || 'deepinfra',
    model: process.env.MODEL || 'Qwen/Qwen2.5-72B-Instruct',
    maxOutputTokens: 4000,
  },
};

runHarness(config)
  .then((report) => {
    console.log('\nEvaluation complete!');
    console.log(`Recommendation: ${report.summary.recommendation}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Evaluation failed:', error);
    process.exit(1);
  });
