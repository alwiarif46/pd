import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractComplianceMatrix, type PipelineResult } from './compliance-pipeline.ts';
import type { ModelProvider, ModelRequest } from './providers.ts';

const pages = [
  { pageNo: 1, ocrUsed: false, text: 'Section L Instructions\nL.1 The offeror shall submit a technical volume.\nL.2 Proposals must not exceed 20 pages.' },
  { pageNo: 2, ocrUsed: false, text: 'Section M Evaluation criteria\nM.1 The technical approach will be evaluated for soundness.' },
  { pageNo: 3, ocrUsed: false, text: 'Section C Scope of work\nC.3.1 The contractor shall provide help desk support.\nC.3.2 The contractor shall maintain logs.\nThe contractor shall report weekly.' },
];

const row = (sectionRef: string | null, requirementText: string, sourceQuote: string, sourcePage: number, flags: string[] = []) => ({
  sectionRef, requirementText, sourceQuote, sourcePage, reqType: 'shall', confidence: 0.9, flags,
});

/** Answers each pass from a script, keyed by the pass named at the start of the prompt. */
export function scriptedProvider(script: Record<string, (prompt: string) => unknown>): ModelProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'ollama',
    prompts,
    async complete(request: ModelRequest) {
      const prompt = request.messages[0].content;
      prompts.push(prompt);
      const pass = Object.keys(script).find((key) => prompt.startsWith(key));
      if (!pass) {
        throw new Error(`No script for prompt: ${prompt.slice(0, 40)}`);
      }
      const json = script[pass](prompt);
      return { text: JSON.stringify(json), json, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
  };
}

function solicitationScript() {
  return scriptedProvider({
    'Pass 1 extract': () => ({
      requirements: [
        row('C.3.1', 'Provide help desk support', 'The contractor shall provide help desk support.', 3),
        row('C.3.1', 'Provide help desk support (duplicate)', 'The contractor shall provide help desk support.', 3),
        row('C.3.2', 'Maintain logs', 'The contractor shall maintain logs.', 3),
        row('L.1', 'Submit a technical volume', 'The offeror shall submit a technical volume.', 2),
        row('C.9', 'Invented', 'The contractor shall fly to the moon.', 3),
      ],
      dueDate: '2026-11-01',
      dueTime: null,
      timeZone: null,
    }),
    'Pass 3 verify': () => ({
      requirements: [
        row('C.3', 'Report weekly', 'The contractor shall report weekly.', 3),
        row('L.1', 'Submit a technical volume', 'The offeror shall submit a technical volume.', 1, ['maybe_not_requirement']),
      ],
    }),
    'Pass 5 map': () => ({
      rows: [
        { id: 'C.3.1-01', instrRef: 'L.1', evalRef: 'M.1', responseSection: '2.1' },
        { id: 'C.3-01', instrRef: null, evalRef: 'M.1', responseSection: null },
        { id: 'NOPE-01', instrRef: 'L.9', evalRef: null, responseSection: null },
      ],
    }),
  });
}

/** The result without the timing, which differs between runs. */
function stable(result: PipelineResult) {
  const { processingTimeMs: _ignored, ...metadata } = result.metadata;
  return { ...result, metadata };
}

describe('extractComplianceMatrix (passes 1 to 6)', () => {
  beforeAll(() => {
    process.env.PD_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../skills');
  });

  it('extracts, dedupes, verifies, quote-checks, maps and lists check-these exactly as before the passes were split', async () => {
    const provider = solicitationScript();
    const result = await extractComplianceMatrix({
      pages,
      provider,
      config: { providerName: 'ollama', model: 'test', maxOutputTokens: 1000 },
    });
    expect(stable(result)).toMatchSnapshot();
    expect(provider.prompts.map((prompt) => prompt.slice(0, 13))).toEqual(['Pass 1 extrac', 'Pass 3 verify', 'Pass 5 map. F']);
  });
});
