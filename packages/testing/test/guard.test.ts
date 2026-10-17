import { describe, expect, it } from 'vitest';
import { appRoleDecision, appRoleSkipMessage } from './guard';

describe('appRoleDecision', () => {
  it('runs when pd_app does not exist, because the tests create it, in CI or not', () => {
    expect(appRoleDecision({ roleExists: false, hasPassword: false, ci: true })).toBe('run');
    expect(appRoleDecision({ roleExists: false, hasPassword: false, ci: false })).toBe('run');
  });
  it('runs when pd_app exists and its password is given', () => {
    expect(appRoleDecision({ roleExists: true, hasPassword: true, ci: true })).toBe('run');
    expect(appRoleDecision({ roleExists: true, hasPassword: true, ci: false })).toBe('run');
  });
  it('skips visibly outside CI when pd_app exists and no password is given', () => {
    expect(appRoleDecision({ roleExists: true, hasPassword: false, ci: false })).toBe('skip');
  });
  it('fails in CI in the same case, so the row-level security tests cannot pass by not running', () => {
    expect(appRoleDecision({ roleExists: true, hasPassword: false, ci: true })).toBe('fail');
  });
  it('tells the reader what to do', () => {
    const message = appRoleSkipMessage();
    expect(message).toContain('TEST_PD_APP_PASSWORD');
    expect(message).toContain('pd_app');
  });
});
