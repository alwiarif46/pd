// pnpm contracts:check:bump -- --base origin/master [--repo <dir>]
// Exit 0: ok or skipped (base unavailable, not in CI). Exit 1: a contract changed without a version bump.
import { resolve } from 'node:path';
import { PACKAGE_ROOT } from '../src/index';
import { checkBump } from './bump';
import { printBump, readBase } from './bump-args';

const base = readBase(process.argv.slice(2));
if (!base) {
  console.error('usage: contracts:check:bump --base <ref> [--repo <dir>]');
  process.exit(2);
}
const result = checkBump({ repoRoot: base.repo ?? resolve(PACKAGE_ROOT, '..', '..'), base: base.ref, ci: process.env.CI === 'true' });
printBump(result);
process.exit(result.status === 'failed' ? 1 : 0);
