import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/index';

// The test doubles (and everything else in @pd/testing) are for tests and local runs. Production code must never import them
// (BUILD-PLAN s8, stub rule). eslint.config.mjs has the same rule for the editor; this test also covers python/ and packages/.
const ROOT = repoRoot();
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]@pd\/testing(?:\/[^'"]*)?['"]/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
}

function productionSources(): string[] {
  const files: string[] = [];
  for (const svc of readdirSync(join(ROOT, 'services'))) {
    const src = join(ROOT, 'services', svc, 'src');
    try {
      walk(src, files);
    } catch {
      /* no src folder */
    }
  }
  // gateway/web and ingest/sandbox sit one level deeper
  for (const extra of ['services/gateway/web/src', 'services/ingest/sandbox/src', 'infra/sandbox-runner/src']) {
    try {
      walk(join(ROOT, extra), files);
    } catch {
      /* absent */
    }
  }
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (pkg === 'testing') continue;
    try {
      walk(join(ROOT, 'packages', pkg, 'src'), files);
    } catch {
      /* no src folder */
    }
  }
  return [...new Set(files)];
}

describe('production code does not import @pd/testing', () => {
  it('scans a real set of files', () => {
    expect(productionSources().length).toBeGreaterThan(20);
  });

  it('no file under services/*/src or packages/*/src imports it', () => {
    const offenders = productionSources().filter((f) => IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('the pattern itself matches the import forms we care about', () => {
    expect(IMPORT.test("import { x } from '@pd/testing';")).toBe(true);
    expect(IMPORT.test('import("@pd/testing/seed")')).toBe(true);
    expect(IMPORT.test("const t = require('@pd/testing')")).toBe(true);
    expect(IMPORT.test("import x from '@pd/testing-other'")).toBe(false);
  });

  it('no package other than testing lists @pd/testing as a runtime dependency', () => {
    const bad: string[] = [];
    const dirs = [
      ...readdirSync(join(ROOT, 'services')).map((s) => join('services', s)),
      ...readdirSync(join(ROOT, 'packages')).map((p) => join('packages', p)),
    ];
    for (const d of dirs) {
      let pkg: { dependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(join(ROOT, d, 'package.json'), 'utf8')) as typeof pkg;
      } catch {
        continue;
      }
      if (pkg.dependencies?.['@pd/testing']) bad.push(d);
    }
    expect(bad).toEqual([]);
  });
});
