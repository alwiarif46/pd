import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The repo root: the nearest folder above this file that holds pnpm-workspace.yaml. */
export function repoRoot(from: string = here): string {
  let dir = resolve(from);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No pnpm-workspace.yaml found above ${from}`);
}

/** The root of the @pd/testing package. */
export const TESTING_ROOT = resolve(here, '..');
