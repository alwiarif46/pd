import type { GlobalSetupContext } from 'vitest/node';
import { guardDecision, refusalMessage, serviceRolesInUse } from './guard';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Set once, before any test file runs, so one file's migration cannot trip the guard of the next. */
    serviceRolesInUse: string[];
  }
}

/** Evaluated once per `vitest run`, before the first test file touches the cluster. */
export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  const optIn = process.env.SERVICE_KIT_TEST_RESETS_ROLES === '1';
  const inUse = url && !optIn ? await serviceRolesInUse(url) : [];
  const decision = guardDecision(inUse, process.env.CI === 'true', optIn);
  if (decision === 'fail') throw new Error(refusalMessage(inUse));
  if (decision === 'skip') console.warn(`\n!!!!!!!! ${refusalMessage(inUse)} !!!!!!!!\n`);
  provide('serviceRolesInUse', decision === 'skip' ? inUse : []);
}
