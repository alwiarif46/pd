import { join } from 'node:path';
import { TESTING_ROOT } from './paths.js';

/** Stub skills for the placeholder stages. Load them through @pd/stage-interface only. */
export const STUB_SKILLS_DIR = join(TESTING_ROOT, 'skills');

/** The stub skill names. `stub-bid-summary` has no `version` line, so it exercises the hash fallback. */
export const STUB_SKILL_NAMES = ['stub-shred', 'stub-compliance-matrix', 'stub-bid-summary'] as const;

const ENV = 'PD_SKILLS_DIR';

function point(): () => void {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV);
  const before = process.env[ENV];
  process.env[ENV] = STUB_SKILLS_DIR;
  return () => {
    if (had && before !== undefined) process.env[ENV] = before;
    else delete process.env[ENV];
  };
}

/**
 * Points PD_SKILLS_DIR at the stub skills.
 * - `withStubSkills()` returns a function that restores the old value (use it in afterEach).
 * - `withStubSkills(fn)` runs `fn`, restores the old value even if `fn` throws, and returns its result.
 */
export function withStubSkills(): () => void;
export function withStubSkills<T>(fn: () => T | Promise<T>): Promise<T>;
export function withStubSkills<T>(fn?: () => T | Promise<T>): (() => void) | Promise<T> {
  const restore = point();
  if (!fn) return restore;
  return (async () => {
    try {
      return await fn();
    } finally {
      restore();
    }
  })();
}
