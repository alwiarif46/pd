import { activeModel } from '@pd/ai';

/**
 * What the app tells anyone (signed out too) about who processes their files. It reads only the environment and a
 * static list, never the database or the request, so it cannot reach any organization's data.
 */
export interface ProcessingInfo {
  provider: string;
  model: string;
  subprocessors: string[];
  privacyPath: string;
}

/** The AI, messaging and payment subprocessors the product itself integrates. */
export const BASE_SUBPROCESSORS = ['DeepInfra', 'Anthropic', 'Telnyx', 'Stripe'] as const;

const MAX_NAME_LENGTH = 120;

/**
 * Clean one deployment-supplied name: no control characters (the value comes from an environment variable that
 * ends up in a public JSON response), trimmed, capped. Returns '' for a missing or blank value.
 */
function cleanName(value: string | undefined): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME_LENGTH).trim();
}

/**
 * The list is: the hosting provider (PD_HOSTING_SUBPROCESSOR, set by infra/scripts/deploy.sh from the tenant file),
 * then the base list, then the off-site backup target (PD_BACKUP_SUBPROCESSOR). Empty values are dropped and
 * duplicates removed, so an unset deployment shows exactly the base list.
 */
export function processingInfo(env: NodeJS.ProcessEnv = process.env): ProcessingInfo {
  const names = [cleanName(env.PD_HOSTING_SUBPROCESSOR), ...BASE_SUBPROCESSORS, cleanName(env.PD_BACKUP_SUBPROCESSOR)];
  const seen = new Set<string>();
  const subprocessors: string[] = [];
  for (const name of names) {
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    subprocessors.push(name);
  }
  return {
    provider: env.AI_PROVIDER || 'deepinfra',
    model: activeModel(),
    subprocessors,
    privacyPath: '/#/privacy',
  };
}
