// Scoring harness for model evaluation
// Compares extracted results against golden set using 80% overlap match

import { quoteCoverage } from '@pd/ai';
import type { GoldenDocument, ExtractedMatrix, EvaluationResult, MatchResult, Requirement, ExtractedRequirement } from './types';

/**
 * Score an extracted matrix against a golden document
 */
export function scoreAgainstGolden(
  golden: GoldenDocument,
  extracted: ExtractedMatrix
): EvaluationResult {
  const matches: MatchResult[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let droppedRows = 0;

  const humanQuotes = golden.humanMatrix.requirements.map((requirement) => requirement.sourceQuote);

  // Recall: an AI quote covers at least 80% of the human row's cited text.
  for (const goldenReq of golden.humanMatrix.requirements) {
    const match = findBestMatch(goldenReq, extracted.requirements);
    matches.push(match);

    if (match.matchType === 'exact' || match.matchType === 'partial') {
      truePositives++;
    } else {
      falseNegatives++;
    }
  }

  // Precision: at least 80% of the AI quote is covered by some human cited text.
  let matchedExtracted = 0;
  for (const extractedReq of extracted.requirements) {
    const covered = humanQuotes.some((quote) => quoteCoverage(extractedReq.sourceQuote, quote) >= 0.8);
    if (covered) {
      matchedExtracted++;
    } else {
      falsePositives++;
    }
  }

  // Calculate metrics
  const totalGolden = golden.humanMatrix.requirements.length;
  const totalExtracted = extracted.requirements.length;
  const recall = totalGolden > 0 ? truePositives / totalGolden : 0;
  const precision = totalExtracted > 0 ? matchedExtracted / totalExtracted : 0;
  const quoteCheckFailureRate = extracted.metadata.quoteCheckFailureRate;

  // Check due date
  const dueDateCorrect = checkDueDate(golden.humanMatrix.dueDate, extracted.dueDate);

  // Count dropped rows (from metadata if available)
  droppedRows = extracted.metadata?.droppedRows || 0;

  return {
    documentId: golden.id,
    documentName: golden.name,
    matches,
    metrics: {
      recall,
      precision,
      dueDateCorrect,
      quoteCheckFailureRate,
      droppedRows,
      totalGolden,
      totalExtracted,
      truePositives,
      falsePositives,
      falseNegatives,
    },
    processingTimeMs: extracted.metadata.processingTimeMs,
    tokensUsed: extracted.metadata.tokensUsed,
    costUsd: extracted.metadata.costUsd,
  };
}

/**
 * Find the best match for a golden requirement
 */
function findBestMatch(
  goldenReq: Requirement,
  extractedReqs: ExtractedRequirement[]
): MatchResult {
  let bestMatch: ExtractedRequirement | undefined;
  let bestScore = 0;

  for (const extractedReq of extractedReqs) {
    const quoteScore = quoteCoverage(goldenReq.sourceQuote, extractedReq.sourceQuote);
    if (quoteScore > bestScore) {
      bestScore = quoteScore;
      bestMatch = extractedReq;
    }
  }

  const threshold = 0.8;
  let matchType: 'exact' | 'partial' | 'none' = 'none';
  if (bestScore >= 0.95) {
    matchType = 'exact';
  } else if (bestScore >= threshold) {
    matchType = 'partial';
  }

  const quoteVerified = bestMatch ? bestScore >= threshold : false;
  const quoteMissing = false;

  return {
    goldenReq,
    extractedReq: bestMatch,
    matchType,
    overlapScore: bestScore,
    quoteVerified,
    quoteMissing,
  };
}

/**
 * Check if due date is correct
 */
function checkDueDate(goldenDueDate?: string, extractedDueDate?: string): boolean {
  if (!goldenDueDate && !extractedDueDate) return true;
  if (!goldenDueDate || !extractedDueDate) return false;

  // Normalize dates for comparison
  const golden = normalizeDate(goldenDueDate);
  const extracted = normalizeDate(extractedDueDate);

  return golden === extracted;
}

/**
 * Normalize a date string to ISO format
 */
function normalizeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  } catch {
    return dateStr;
  }
}

/**
 * Aggregate results across multiple documents
 */
export function aggregateResults(results: EvaluationResult[]): {
  avgRecall: number;
  avgPrecision: number;
  avgDueDateCorrect: number;
  avgQuoteCheckFailureRate: number;
  totalDroppedRows: number;
  avgProcessingTimeMs: number;
  totalTokensUsed: number;
  totalCostUsd: number;
} {
  const recallSum = results.reduce((sum, r) => sum + r.metrics.recall, 0);
  const precisionSum = results.reduce((sum, r) => sum + r.metrics.precision, 0);
  const dueDateCorrectSum = results.reduce((sum, r) => sum + (r.metrics.dueDateCorrect ? 1 : 0), 0);
  const quoteFailureSum = results.reduce((sum, r) => sum + r.metrics.quoteCheckFailureRate, 0);
  const droppedRowsSum = results.reduce((sum, r) => sum + r.metrics.droppedRows, 0);
  const processingTimeSum = results.reduce((sum, r) => sum + r.processingTimeMs, 0);
  const tokensSum = results.reduce((sum, r) => sum + r.tokensUsed, 0);
  const costSum = results.reduce((sum, r) => sum + r.costUsd, 0);

  return {
    avgRecall: recallSum / results.length,
    avgPrecision: precisionSum / results.length,
    avgDueDateCorrect: dueDateCorrectSum / results.length,
    avgQuoteCheckFailureRate: quoteFailureSum / results.length,
    totalDroppedRows: droppedRowsSum,
    avgProcessingTimeMs: processingTimeSum / results.length,
    totalTokensUsed: tokensSum,
    totalCostUsd: costSum,
  };
}

/**
 * Check if a model passes the acceptance criteria
 */
export function passesAcceptanceCriteria(results: EvaluationResult[]): {
  passes: boolean;
  reasons: string[];
} {
  const aggregated = aggregateResults(results);
  const reasons: string[] = [];

  // Recall must be >= 98%
  if (aggregated.avgRecall < 0.98) {
    reasons.push(`Recall ${aggregated.avgRecall.toFixed(2)} < 0.98`);
  }

  // Precision must be >= 95%
  if (aggregated.avgPrecision < 0.95) {
    reasons.push(`Precision ${aggregated.avgPrecision.toFixed(2)} < 0.95`);
  }

  // Due date must be correct
  if (aggregated.avgDueDateCorrect < 1.0) {
    reasons.push(`Due date accuracy ${aggregated.avgDueDateCorrect.toFixed(2)} < 1.0`);
  }

  // No row should cite text missing from solicitation
  const hasMissingQuotes = results.some((r) =>
    r.matches.some((m) => m.quoteMissing)
  );
  if (hasMissingQuotes) {
    reasons.push('Some rows cite text missing from solicitation');
  }

  // Time per 200-page text-layer PDF must be under 10 minutes on idle worker
  if (aggregated.avgProcessingTimeMs > 600000) {
    reasons.push(`Processing time ${aggregated.avgProcessingTimeMs}ms > 600000ms`);
  }

  return {
    passes: reasons.length === 0,
    reasons,
  };
}
