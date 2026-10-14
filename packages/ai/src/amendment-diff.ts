import {
  extractComplianceMatrix,
  type ComplianceRequirement,
  type PipelineConfig,
} from './compliance-pipeline';
import { preScan, type PageText } from './document-processor';
import type { ModelProvider } from './providers';
import { quoteCoverage } from './quote-normalizer';

export interface AmendmentLink {
  oldRowId: string | null;
  newRowId: string | null;
  action: 'supersede' | 'withdraw' | 'add';
  confidence: number;
  status: 'auto' | 'proposed' | 'confirmed' | 'rejected';
}

export interface DateChange {
  field: string;
  oldValue: string;
  newValue: string;
  pageNo: number;
}

export interface AmendmentDiffResult {
  requirements: ComplianceRequirement[];
  links: AmendmentLink[];
  dateChanges: DateChange[];
}

const DEFAULT_CONFIDENCE = 0.8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function candidatesFor(original: ComplianceRequirement[], row: ComplianceRequirement): ComplianceRequirement[] {
  return original.filter((existing) => {
    if (existing.supersedeStatus === 'superseded' || existing.supersedeStatus === 'withdrawn') {
      return false;
    }
    if (existing.sectionRef && existing.sectionRef === row.sectionRef) {
      return true;
    }
    return quoteCoverage(existing.sourceQuote, row.sourceQuote) >= 0.5
      || quoteCoverage(row.sourceQuote, existing.sourceQuote) >= 0.5;
  });
}

export async function processAmendment(input: {
  original: ComplianceRequirement[];
  amendmentPages: PageText[];
  provider: ModelProvider;
  config: PipelineConfig;
  amendmentNo: number;
  confidenceThreshold?: number;
}): Promise<AmendmentDiffResult> {
  const threshold = input.confidenceThreshold ?? DEFAULT_CONFIDENCE;
  const extracted = await extractComplianceMatrix({
    pages: input.amendmentPages,
    provider: input.provider,
    config: input.config,
    amendmentNo: input.amendmentNo,
    stopAfterQuoteCheck: true,
  });

  const candidateSets = extracted.requirements.map((row) => ({
    row,
    candidates: candidatesFor(input.original, row),
  }));

  const response = await input.provider.complete({
    system: 'You compare an amendment with existing compliance rows. Return only JSON. Do not guess a link you cannot support from the quotes.',
    messages: [
      {
        role: 'user',
        content: `For each amendment row, name the existing row it supersedes, or mark it as add. Name existing rows the amendment withdraws with no replacement. JSON shape: {"links":[{"oldRowId":null,"newRowId":null,"action":"supersede","confidence":0.9}]}\nAmendment rows:\n${JSON.stringify(candidateSets)}`,
      },
    ],
    jsonSchema: { type: 'object', properties: { links: { type: 'array' } }, required: ['links'] },
    maxOutputTokens: input.config.maxOutputTokens,
  });

  if (!isRecord(response.json) || !Array.isArray(response.json.links)) {
    throw new Error('Amendment diff JSON is missing links');
  }

  const links: AmendmentLink[] = response.json.links.map((item) => {
    if (!isRecord(item)) {
      throw new Error('Amendment link is not an object');
    }
    const action = item.action;
    if (action !== 'supersede' && action !== 'withdraw' && action !== 'add') {
      throw new Error('Amendment link has an invalid action');
    }
    if (typeof item.confidence !== 'number') {
      throw new Error('Amendment link is missing confidence');
    }
    return {
      oldRowId: typeof item.oldRowId === 'string' ? item.oldRowId : null,
      newRowId: typeof item.newRowId === 'string' ? item.newRowId : null,
      action,
      confidence: item.confidence,
      status: item.confidence >= threshold ? 'auto' : 'proposed',
    };
  });

  const requirements = applyAmendmentChanges(input.original, extracted.requirements, links);
  const dateChanges = preScan(input.amendmentPages).dates.map((hit) => ({
    field: 'date',
    oldValue: '',
    newValue: hit.text,
    pageNo: hit.pageNo,
  }));

  return { requirements, links, dateChanges };
}

export function confirmAmendmentLink(link: AmendmentLink): AmendmentLink {
  return { ...link, status: 'confirmed' };
}

export function rejectAmendmentLink(link: AmendmentLink): AmendmentLink {
  return { ...link, status: 'rejected' };
}

/**
 * Applies auto, confirmed supersede, withdraw, and add links.
 * Superseded and withdrawn rows stay in the list.
 */
export function applyAmendmentChanges(
  original: ComplianceRequirement[],
  added: ComplianceRequirement[],
  links: AmendmentLink[],
): ComplianceRequirement[] {
  const result = original.map((row) => ({ ...row, flags: [...row.flags] }));
  const applied = links.filter((link) => link.status === 'auto' || link.status === 'confirmed');

  for (const link of applied) {
    if (link.action === 'supersede' && link.oldRowId) {
      const row = result.find((item) => item.id === link.oldRowId);
      if (row) {
        row.supersedeStatus = 'superseded';
        row.supersededByRowId = link.newRowId ?? undefined;
      }
    } else if (link.action === 'withdraw' && link.oldRowId) {
      const row = result.find((item) => item.id === link.oldRowId);
      if (row) {
        row.supersedeStatus = 'withdrawn';
      }
    } else if (link.action === 'add' && link.newRowId) {
      const row = added.find((item) => item.id === link.newRowId);
      if (row && !result.some((item) => item.id === row.id)) {
        result.push(row);
      }
    }
  }

  for (const link of applied) {
    if (link.action !== 'supersede' || !link.newRowId) {
      continue;
    }
    const row = added.find((item) => item.id === link.newRowId);
    if (row && !result.some((item) => item.id === row.id)) {
      result.push(row);
    }
  }

  return result;
}
