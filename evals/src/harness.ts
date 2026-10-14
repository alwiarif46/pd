// Main evaluation harness
// Runs the full evaluation pipeline on the golden set

import { extractComplianceMatrix, getProvider, type ModelProvider, type ModelRequest, type ModelResponse, type PageText, type PipelineConfig } from '@pd/ai';
import { scoreAgainstGolden, aggregateResults, passesAcceptanceCriteria } from './scoring';
import { runBenchmark, getBenchmarkTestText, compareBenchmarks } from './benchmark';
import type { GoldenDocument, ComparisonReport, EvaluationResult, BenchmarkResult } from './types';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface HarnessConfig {
  goldenSetPath: string;
  heldOutIds: string[];
  tuningIds: string[];
  models: {
    provider: string;
    model: string;
    apiKey?: string;
  }[];
  pipelineConfig: PipelineConfig;
}

/**
 * Run the full evaluation harness
 */
export async function runHarness(config: HarnessConfig): Promise<ComparisonReport> {
  console.log('=== Model Evaluation Harness ===');
  console.log(`Golden set: ${config.goldenSetPath}`);
  console.log(`Held out: ${config.heldOutIds.join(', ')}`);
  console.log(`Tuning: ${config.tuningIds.join(', ')}`);
  console.log(`Models: ${config.models.map((m) => `${m.provider}/${m.model}`).join(', ')}`);

  // Load golden set
  const goldenSet = loadGoldenSet(config.goldenSetPath);

  // Split into held-out and tuning
  const heldOut = config.heldOutIds.length > 0
    ? goldenSet.filter((doc) => config.heldOutIds.includes(doc.id))
    : goldenSet;
  const tuning = goldenSet.filter((doc) => config.tuningIds.includes(doc.id));

  console.log(`\nHeld-out documents: ${heldOut.length}`);
  console.log(`Tuning documents: ${tuning.length}`);

  const benchmarks: BenchmarkResult[] = [];
  const liveKey = process.env.DEEPINFRA_API_KEY;
  if (!liveKey) {
    console.log('\nDEEPINFRA_API_KEY is unset. Skipping the live provider benchmark.');
  } else {
    for (const modelConfig of config.models) {
      console.log(`\nBenchmarking ${modelConfig.provider}/${modelConfig.model}...`);
      const benchmark = await runBenchmark({
        provider: modelConfig.provider,
        model: modelConfig.model,
        apiKey: modelConfig.apiKey || liveKey,
        testText: getBenchmarkTestText(),
        iterations: 5,
      });
      benchmarks.push(benchmark);
    }
    console.log(`\nBenchmark recommendation: ${compareBenchmarks(benchmarks).recommendation}`);
  }

  const bestModel = benchmarks[0] ?? {
    provider: config.models[0]?.provider ?? 'fixture',
    model: config.models[0]?.model ?? 'fixture',
  };

  // Evaluate on held-out documents
  const modelLabel = liveKey ? `${bestModel.provider}/${bestModel.model}` : 'fixture';
  console.log(`\nEvaluating ${modelLabel} on held-out set...`);
  const results: EvaluationResult[] = [];

  for (const goldenDoc of heldOut) {
    console.log(`  Processing ${goldenDoc.name}...`);

    const provider = liveKey
      ? undefined
      : new FixtureProvider(goldenDoc);
    const extractedRun = await extractComplianceMatrix({
      pages: pagesForGolden(goldenDoc),
      provider: provider ?? getProvider(bestModel.provider, liveKey),
      config: {
        ...config.pipelineConfig,
        providerName: bestModel.provider,
        model: bestModel.model,
      },
    });

    const result = scoreAgainstGolden(goldenDoc, {
      requirements: extractedRun.requirements,
      dueDate: extractedRun.dueDate,
      dueTime: extractedRun.dueTime,
      timeZone: extractedRun.timeZone,
      metadata: {
        model: bestModel.model,
        provider: liveKey ? bestModel.provider : 'fixture',
        skillName: extractedRun.metadata.skillName,
        skillVersion: extractedRun.metadata.skillVersion,
        processingTimeMs: extractedRun.metadata.processingTimeMs,
        tokensUsed: extractedRun.metadata.tokensUsed,
        costUsd: extractedRun.metadata.costUsd,
        droppedRows: extractedRun.metadata.droppedRows,
        quoteCheckFailureRate: extractedRun.metadata.quoteCheckFailureRate,
      },
    });
    results.push(result);

    console.log(`    Recall: ${(result.metrics.recall * 100).toFixed(1)}%`);
    console.log(`    Precision: ${(result.metrics.precision * 100).toFixed(1)}%`);
    console.log(`    Due date correct: ${result.metrics.dueDateCorrect}`);
  }

  // Aggregate results
  const aggregated = aggregateResults(results);
  console.log(`\nAggregated results:`);
  console.log(`  Average recall: ${(aggregated.avgRecall * 100).toFixed(1)}%`);
  console.log(`  Average precision: ${(aggregated.avgPrecision * 100).toFixed(1)}%`);
  console.log(`  Due date accuracy: ${(aggregated.avgDueDateCorrect * 100).toFixed(1)}%`);
  console.log(`  Quote check failure rate: ${(aggregated.avgQuoteCheckFailureRate * 100).toFixed(1)}%`);
  console.log(`  Total dropped rows: ${aggregated.totalDroppedRows}`);
  console.log(`  Avg processing time: ${(aggregated.avgProcessingTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Total tokens: ${aggregated.totalTokensUsed}`);
  console.log(`  Total cost: $${aggregated.totalCostUsd.toFixed(4)}`);

  // Check acceptance criteria
  const acceptance = passesAcceptanceCriteria(results);
  if (liveKey) {
    console.log(`\nAcceptance criteria: ${acceptance.passes ? 'PASS' : 'FAIL'}`);
    if (!acceptance.passes) {
      console.log('  Reasons:');
      for (const reason of acceptance.reasons) {
        console.log(`    - ${reason}`);
      }
    }
  }

  // Build report
  const report: ComparisonReport = {
    goldenSet: goldenSet.map((d) => d.id),
    heldOut: config.heldOutIds,
    tuning: config.tuningIds,
    results,
    benchmarks,
    summary: {
      bestModel: liveKey ? `${bestModel.provider}/${bestModel.model}` : 'fixture',
      bestRecall: aggregated.avgRecall,
      bestPrecision: aggregated.avgPrecision,
      recommendation: liveKey
        ? (acceptance.passes
          ? `${bestModel.provider}/${bestModel.model} passes all acceptance criteria and is recommended for production.`
          : `${bestModel.provider}/${bestModel.model} does not pass acceptance criteria. Reasons: ${acceptance.reasons.join(', ')}.`)
        : 'Scored the fixture with a fake provider. This is not a model selection. Set DEEPINFRA_API_KEY to run the live benchmark.',
    },
  };

  // Save report
  const reportPath = join(config.goldenSetPath, '../results/report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${reportPath}`);

  return report;
}

/**
 * Load golden set from JSON file
 */
function loadGoldenSet(path: string): GoldenDocument[] {
  const data = readFileSync(path, 'utf-8');
  return JSON.parse(data) as GoldenDocument[];
}

function pagesForGolden(doc: GoldenDocument): PageText[] {
  const byPage = new Map<number, string[]>();
  for (const requirement of doc.humanMatrix.requirements) {
    const existing = byPage.get(requirement.sourcePage) ?? [];
    existing.push(requirement.sourceQuote);
    byPage.set(requirement.sourcePage, existing);
  }
  return [...byPage.entries()].map(([pageNo, quotes]) => ({
    pageNo,
    text: quotes.join('\n\n'),
    ocrUsed: false,
  }));
}

class FixtureProvider implements ModelProvider {
  name = 'ollama' as const;

  constructor(private readonly golden: GoldenDocument) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const prompt = req.messages.map((message) => message.content).join('\n');
    let json: unknown = { requirements: [] };
    if (prompt.includes('Pass 1')) {
      json = {
        requirements: this.golden.humanMatrix.requirements.map((requirement) => ({
          sectionRef: requirement.sectionRef ?? null,
          requirementText: requirement.requirementText,
          sourceQuote: requirement.sourceQuote,
          sourcePage: requirement.sourcePage,
          reqType: requirement.reqType,
          confidence: 0.95,
        })),
        dueDate: this.golden.humanMatrix.dueDate ?? null,
        dueTime: this.golden.humanMatrix.dueTime ?? null,
        timeZone: this.golden.humanMatrix.timeZone ?? null,
      };
    } else if (prompt.includes('Pass 5')) {
      json = { rows: [] };
    }
    return {
      text: JSON.stringify(json),
      json,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

/**
 * Save evaluation results
 */
export function saveResults(results: EvaluationResult[], outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
}
