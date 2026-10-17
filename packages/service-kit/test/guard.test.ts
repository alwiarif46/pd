import { describe, expect, it } from 'vitest';
import { guardDecision, refusalMessage } from './guard';

describe('guardDecision', () => {
  const used = ['billing_svc', 'identity_svc'];
  it('runs on a fresh cluster, in CI or not', () => {
    expect(guardDecision([], true, false)).toBe('run');
    expect(guardDecision([], false, false)).toBe('run');
  });
  it('refuses a cluster with login roles: skips locally, fails in CI', () => {
    expect(guardDecision(used, false, false)).toBe('skip');
    expect(guardDecision(used, true, false)).toBe('fail');
  });
  it('runs when the opt-in is set', () => {
    expect(guardDecision(used, true, true)).toBe('run');
  });
  it('names the env var in the message', () => {
    expect(refusalMessage(used)).toContain('SERVICE_KIT_TEST_RESETS_ROLES=1');
  });
});
