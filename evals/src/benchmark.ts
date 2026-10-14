// Benchmark measurements for model evaluation
// Measures performance metrics: tokens/sec, latency, JSON validity, etc.

import { getProvider, type ModelProvider } from '@pd/ai';
import type { BenchmarkResult } from './types';

export interface BenchmarkConfig {
  provider: string;
  model: string;
  apiKey?: string;
  testText: string;
  iterations: number;
}

/**
 * Run benchmark on a model
 */
export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const provider = getProvider(config.provider, config.apiKey);

  const timings: number[] = [];
  const tokenCounts: number[] = [];
  const jsonValidities: boolean[] = [];

  for (let i = 0; i < config.iterations; i++) {
    const startTime = Date.now();

    const response = await provider.complete({
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: config.testText },
      ],
      jsonSchema: { type: 'object', properties: { result: { type: 'string' } } },
      maxOutputTokens: 1000,
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    timings.push(duration);
    tokenCounts.push(response.usage.outputTokens);
    jsonValidities.push(response.json !== undefined);
  }

  // Calculate metrics
  const avgLatency = timings.reduce((a, b) => a + b, 0) / timings.length;
  const avgOutputTokens = tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length;
  const outputTokensPerSecond = (avgOutputTokens / avgLatency) * 1000;
  const jsonValidityRate = jsonValidities.filter((v) => v).length / jsonValidities.length;

  // Estimate concurrent call limit (this would need actual testing)
  const concurrentCallLimit = 3; // Default starting value

  // Estimate cost per RFP (rough calculation)
  const costPerRfpUsd = estimateCostPerRfp(config.provider, config.model, avgOutputTokens);

  // Estimate time for 200-page text-layer PDF
  const timePer200PageTextLayerMs = estimateTimePer200Page(avgLatency, avgOutputTokens);

  // Estimate time for scanned document (OCR adds time)
  const timePerScannedDocumentMs = timePer200PageTextLayerMs * 2.5; // OCR roughly 2.5x slower

  return {
    provider: config.provider,
    model: config.model,
    outputTokensPerSecond,
    latencyPerChunkMs: avgLatency,
    jsonValidityRate,
    concurrentCallLimit,
    costPerRfpUsd,
    timePer200PageTextLayerMs,
    timePerScannedDocumentMs,
  };
}

/**
 * Estimate cost per RFP based on token usage
 */
function estimateCostPerRfp(provider: string, model: string, avgTokens: number): number {
  // Rough estimates - will be refined with actual pricing
  const costPer1kTokens: Record<string, number> = {
    deepinfra: 0.0001,
    anthropic: 0.003,
    ollama: 0,
  };

  const rate = costPer1kTokens[provider] || 0.001;
  const tokensPerRfp = avgTokens * 10; // Rough estimate: 10 chunks per RFP
  return (tokensPerRfp / 1000) * rate;
}

/**
 * Estimate time to process a 200-page text-layer PDF
 */
function estimateTimePer200Page(avgLatency: number, avgTokens: number): number {
  // Assume 200 pages produce ~10 chunks
  const chunksPerPage = 0.05;
  const totalChunks = 200 * chunksPerPage;
  return avgLatency * totalChunks;
}

/**
 * Compare multiple benchmark results
 */
export function compareBenchmarks(results: BenchmarkResult[]): {
  fastest: BenchmarkResult;
  cheapest: BenchmarkResult;
  bestJsonValidity: BenchmarkResult;
  recommendation: string;
} {
  const fastest = results.reduce((best, current) =>
    current.outputTokensPerSecond > best.outputTokensPerSecond ? current : best
  );

  const cheapest = results.reduce((best, current) =>
    current.costPerRfpUsd < best.costPerRfpUsd ? current : best
  );

  const bestJsonValidity = results.reduce((best, current) =>
    current.jsonValidityRate > best.jsonValidityRate ? current : best
  );

  // Simple recommendation logic
  let recommendation = '';
  if (cheapest.costPerRfpUsd < 0.01 && fastest.outputTokensPerSecond > 50) {
    recommendation = `${cheapest.provider}/${cheapest.model} offers the best balance of cost and speed.`;
  } else if (fastest.outputTokensPerSecond > 100) {
    recommendation = `${fastest.provider}/${fastest.model} is the fastest, suitable for real-time processing.`;
  } else {
    recommendation = `${cheapest.provider}/${cheapest.model} is the most cost-effective option.`;
  }

  return {
    fastest,
    cheapest,
    bestJsonValidity,
    recommendation,
  };
}

/**
 * Get standard test text for benchmarking
 */
export function getBenchmarkTestText(): string {
  return `Extract the key information from this text and return it as JSON.

The solicitation requires that all offerors submit:
1. A technical proposal not exceeding 50 pages
2. A cost proposal with detailed breakdown
3. Past performance references from at least 3 clients
4. A small business participation plan

The due date is December 15, 2026 at 5:00 PM Eastern Time.

Respond with JSON in this format:
{
  "requirements": ["string"],
  "dueDate": "string",
  "dueTime": "string",
  "timeZone": "string"
}`;
}
