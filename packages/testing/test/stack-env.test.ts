import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_ORDER } from '@pd/service-kit/migrate';
import { repoRoot, stackMode } from '../src/index';

const ROOT = repoRoot();

describe('infra/compose/stack.env.example', () => {
  const plan = readFileSync(join(ROOT, 'docs', 'plans', '09-repo-and-services.md'), 'utf8');
  const section = plan.slice(plan.indexOf('### 9.2 Environment variables'), plan.indexOf('### 9.3 Migrations'));
  const names = new Set<string>();
  for (const m of section.matchAll(/`([A-Z][A-Z0-9_<>]+)`/g)) names.add(m[1] as string);
  const file = readFileSync(join(ROOT, 'infra', 'compose', 'stack.env.example'), 'utf8');
  const defined = new Set([...file.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  it('reads a real list of names from 09 s9.2', () => {
    expect(names.size).toBeGreaterThanOrEqual(15);
    expect(names.has('REDIS_URL')).toBe(true);
  });

  it('defines every variable name of the table', () => {
    const missing: string[] = [];
    for (const n of names) {
      if (n === '<SERVICE>_DATABASE_URL') {
        for (const s of MIGRATION_ORDER.filter((x) => x !== 'app')) if (!defined.has(`${s.toUpperCase()}_DATABASE_URL`)) missing.push(`${s.toUpperCase()}_DATABASE_URL`);
      } else if (!defined.has(n)) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it('has no real-looking secret: provider and Stripe keys are empty', () => {
    for (const k of ['MODELGW_ANTHROPIC_API_KEY', 'MODELGW_REVIEWER_API_KEY', 'MODELGW_IMAGE_API_KEY', 'BILLING_STRIPE_SECRET_KEY', 'BILLING_STRIPE_WEBHOOK_SECRET', 'COMMS_INBOUND_WEBHOOK_SECRET']) {
      expect(file).toMatch(new RegExp(`^${k}=$`, 'm'));
    }
  });
});

describe('stackMode', () => {
  it('defaults to compose, accepts native, rejects anything else', () => {
    expect(stackMode({})).toBe('compose');
    expect(stackMode({ E2E_STACK: 'native' })).toBe('native');
    expect(stackMode({ E2E_STACK: ' Compose ' })).toBe('compose');
    expect(() => stackMode({ E2E_STACK: 'k8s' })).toThrow(/E2E_STACK/);
  });
});
