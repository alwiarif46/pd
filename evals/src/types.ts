// Types for the model evaluation harness

export interface GoldenDocument {
  id: string;
  name: string;
  source: 'federal' | 'sled';
  filePath: string;
  humanMatrix: HumanMatrix;
}

export interface HumanMatrix {
  requirements: Requirement[];
  dueDate?: string;
  dueTime?: string;
  timeZone?: string;
}

export interface Requirement {
  id: string;
  sectionRef?: string;
  requirementText: string;
  instrRef?: string; // Section L reference (federal)
  evalRef?: string; // Section M factor (federal)
  responseSection?: string;
  sourcePage: number;
  sourcePageEnd?: number;
  sourceQuote: string;
  reqType: 'shall' | 'must' | 'will' | 'should' | 'other';
}

export interface ExtractedMatrix {
  requirements: ExtractedRequirement[];
  dueDate?: string;
  dueTime?: string;
  timeZone?: string;
  metadata: {
    model: string;
    provider: string;
    skillName: string;
    skillVersion: string;
    processingTimeMs: number;
    tokensUsed: number;
    costUsd: number;
    droppedRows: number;
    quoteCheckFailureRate: number;
  };
}

export interface ExtractedRequirement {
  id: string;
  sectionRef?: string;
  requirementText: string;
  instrRef?: string;
  evalRef?: string;
  responseSection?: string;
  sourcePage: number;
  sourcePageEnd?: number;
  sourceQuote: string;
  reqType: 'shall' | 'must' | 'will' | 'should' | 'other';
  confidence: number;
  amendmentNo: number;
  origin: 'ai' | 'user';
  flags: string[];
}

export interface MatchResult {
  goldenReq: Requirement;
  extractedReq?: ExtractedRequirement;
  matchType: 'exact' | 'partial' | 'none';
  overlapScore: number;
  quoteVerified: boolean;
  quoteMissing: boolean;
}

export interface EvaluationResult {
  documentId: string;
  documentName: string;
  matches: MatchResult[];
  metrics: {
    recall: number; // % of golden requirements found
    precision: number; // % of extracted requirements that match
    dueDateCorrect: boolean;
    quoteCheckFailureRate: number; // % of matches with quote verification failure
    droppedRows: number; // rows dropped before final output
    totalGolden: number;
    totalExtracted: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  };
  processingTimeMs: number;
  tokensUsed: number;
  costUsd: number;
}

export interface BenchmarkResult {
  provider: string;
  model: string;
  outputTokensPerSecond: number;
  latencyPerChunkMs: number;
  jsonValidityRate: number;
  concurrentCallLimit: number;
  costPerRfpUsd: number;
  timePer200PageTextLayerMs: number;
  timePerScannedDocumentMs: number;
}

export interface ComparisonReport {
  goldenSet: string[];
  heldOut: string[];
  tuning: string[];
  results: EvaluationResult[];
  benchmarks: BenchmarkResult[];
  summary: {
    bestModel: string;
    bestRecall: number;
    bestPrecision: number;
    recommendation: string;
  };
}
