import type { GlobalSetupContext } from 'vitest/node';
import { appRoleDecision, appRoleExists, appRoleSkipMessage } from './guard';

declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Decided once, before any test file runs (a per-file check would see the pd_app an earlier file made).
     * Empty when the row-level security tests can log in as pd_app; otherwise the reason they are skipped.
     */
    appRoleSkipReason: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // The database tests skip (or fail under CI) in db-helper; there is no cluster to ask.
    provide('appRoleSkipReason', 'TEST_DATABASE_URL is not set');
    return;
  }
  const decision = appRoleDecision({
    roleExists: await appRoleExists(url),
    hasPassword: Boolean(process.env.TEST_PD_APP_PASSWORD),
    ci: process.env.CI === 'true',
  });
  if (decision === 'fail') throw new Error(appRoleSkipMessage());
  if (decision === 'skip') console.warn(`\n!!!!!!!! ${appRoleSkipMessage()} !!!!!!!!\n`);
  provide('appRoleSkipReason', decision === 'skip' ? appRoleSkipMessage() : '');
}
