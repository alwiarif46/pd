// Copies v0 screens from design/v0/<screen>/ into src/ui/<screen>/ by fixed rules (docs/plans/09-ui-workflow.md,
// CLAUDE.md "Integration task"). Nobody edits src/ui by hand: fixes go through v0, then this script runs again.
//
//   node apps/web/scripts/integrate-v0.mjs <screen> [<screen> ...]   integrate one or more screens
//   node apps/web/scripts/integrate-v0.mjs --all                      integrate every screen that has a manifest
//   node apps/web/scripts/integrate-v0.mjs --check [<screen> ...]     regenerate in memory and compare with src/ui
//
// Rules, per .ts/.tsx file (Preview.tsx is not copied):
//   1. Remove the "use client" directive and next/* imports. A removed binding that is still used fails the run.
//   2. Rewrite imports: ../common/types -> @/types, ../<x>/Y -> @/ui/<x>/Y. ./types and ./x stay. @/ imports must resolve.
//   3. Contract-type shim: a top-level type or interface whose name @/types exports is deleted and replaced by an
//      import (or re-export) from '@/types'. So v0's types.ts becomes a shim and tsc checks v0's code against the
//      real contract. Names in the manifest's keepLocal are not shimmed (owner approval only).
//   4. Format with src/ui/.prettierrc.json and write LF.
// The manifest apps/web/scripts/v0/<screen>.json holds { sourceCommit, files, keepLocal }.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const prettier = await import('prettier');

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..', '..');
const v0Root = path.join(repoRoot, 'design', 'v0');
const srcRoot = path.join(webRoot, 'src');
const uiRoot = path.join(srcRoot, 'ui');
const manifestRoot = path.join(here, 'v0');
const typesIndex = path.join(srcRoot, 'types', 'index.ts');

const SKIP_FILES = new Set(['Preview.tsx']);
const SOURCE_EXT = /\.(ts|tsx)$/;

const posix = (p) => p.split(path.sep).join('/');
const lf = (text) => text.replace(/\r\n?/g, '\n');

/* ------------------------------------------------------------------ helpers */

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function sourceFileOf(name, text) {
  const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
}

const isExported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

function resolveModule(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${fromDir}`);
}

/** Type and interface names that @/types exports, following `export * from` and `export type { } from`. */
function contractTypeNames() {
  const names = new Set();
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = sourceFileOf(file, lf(readFileSync(file, 'utf8')));
    for (const stmt of sf.statements) {
      if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && isExported(stmt)) {
        names.add(stmt.name.text);
      } else if (ts.isExportDeclaration(stmt)) {
        const spec = stmt.moduleSpecifier?.text;
        if (!stmt.exportClause && spec?.startsWith('.')) {
          visit(resolveModule(path.dirname(file), spec));
        } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) names.add(el.name.text);
        }
      }
    }
  }
  visit(typesIndex);
  return names;
}

/** True when an `@/...` import points at a real module or file under src/. */
function atImportResolves(spec) {
  const base = path.join(srcRoot, spec.slice(2));
  return (
    ['.ts', '.tsx', '.css'].some((ext) => existsSync(base + ext)) ||
    existsSync(path.join(base, 'index.ts')) ||
    existsSync(path.join(base, 'index.tsx')) ||
    (existsSync(base) && statSync(base).isFile())
  );
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/* ------------------------------------------------------------ one-file transform */

function transform({ screen, rel, text, contract, keepLocal, copied }) {
  const label = `design/v0/${screen}/${rel}`;
  const sf = sourceFileOf(rel, text);
  const edits = [];
  const problems = [];

  // 1. "use client" directive.
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === 'use client') edits.push({ start: stmt.getFullStart(), end: stmt.end, text: '' });
    } else break;
  }

  // Every identifier, so a removed Next.js binding that is still used can be found.
  const identifierUses = new Map();
  (function collect(node) {
    if (ts.isIdentifier(node)) {
      const list = identifierUses.get(node.text) ?? [];
      list.push(node);
      identifierUses.set(node.text, list);
    }
    ts.forEachChild(node, collect);
  })(sf);

  // 2. Imports and exports with a module specifier.
  const specEdits = new Map();
  for (const stmt of sf.statements) {
    if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) || !stmt.moduleSpecifier) continue;
    const spec = stmt.moduleSpecifier.text;
    const replaceSpec = (next) => {
      const edit = { start: stmt.moduleSpecifier.getStart(sf), end: stmt.moduleSpecifier.end, text: JSON.stringify(next) };
      specEdits.set(stmt, edit);
      edits.push(edit);
    };

    if (spec === 'next' || spec.startsWith('next/')) {
      const bindings = [];
      const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : null;
      if (clause?.name) bindings.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) bindings.push(el.name.text);
      }
      for (const name of bindings) {
        const outside = (identifierUses.get(name) ?? []).filter(
          (id) => id.getStart(sf) < stmt.getStart(sf) || id.end > stmt.end,
        );
        if (outside.length > 0) {
          problems.push(`${label}:${lineOf(sf, outside[0])}: uses "${name}" from "${spec}" (Next.js); v0 must remove it`);
        }
      }
      edits.push({ start: stmt.getFullStart(), end: stmt.end, text: '' });
    } else if (spec === '../common/types') {
      replaceSpec('@/types');
    } else if (/^\.\.\/[^/]+\/.+/.test(spec)) {
      replaceSpec(`@/ui/${spec.slice(3)}`);
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const ok = [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].some((c) =>
        copied.has(c),
      );
      if (!ok) problems.push(`${label}:${lineOf(sf, stmt)}: "${spec}" is not one of the copied files`);
    } else if (spec.startsWith('@/components/ui/')) {
      const name = spec.slice('@/components/ui/'.length);
      if (!existsSync(path.join(srcRoot, 'components', 'ui', `${name}.tsx`))) {
        problems.push(
          `${label}:${lineOf(sf, stmt)}: src/components/ui/${name}.tsx does not exist; add it with the shadcn CLI`,
        );
      }
    } else if (spec.startsWith('@/')) {
      if (!atImportResolves(spec)) problems.push(`${label}:${lineOf(sf, stmt)}: "${spec}" does not resolve under src/`);
    }
  }

  // 3. Contract-type shim.
  const removed = sf.statements.filter(
    (stmt) =>
      (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) &&
      contract.has(stmt.name.text) &&
      !keepLocal.has(stmt.name.text),
  );
  if (removed.length > 0) {
    const inRemoved = (id) => removed.some((r) => id.getStart(sf) >= r.getStart(sf) && id.end <= r.end);
    const importNames = [];
    const exportNames = [];
    for (const r of removed) {
      const name = r.name.text;
      const usedLocally = (identifierUses.get(name) ?? []).some((id) => id !== r.name && !inRemoved(id));
      if (isExported(r)) {
        exportNames.push(name);
        if (usedLocally) importNames.push(name);
      } else {
        importNames.push(name);
      }
    }
    const lines = [];
    if (importNames.length) lines.push(`import type { ${importNames.join(', ')} } from '@/types';`);
    if (exportNames.length) lines.push(`export type { ${exportNames.join(', ')} } from '@/types';`);
    removed.forEach((r, i) => {
      edits.push({ start: r.getFullStart(), end: r.end, text: i === 0 ? `\n${lines.join('\n')}\n` : '' });
    });

    // Imports that only the removed declarations used (for example `React` for `React.ReactNode`) go with them.
    for (const stmt of sf.statements) {
      const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : null;
      if (!clause) continue;
      const unusedNow = (id) => {
        const uses = (identifierUses.get(id.text) ?? []).filter((n) => n !== id);
        return uses.length > 0 && uses.every(inRemoved);
      };
      const named =
        clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const star = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : null;
      const keepDefault = clause.name && !unusedNow(clause.name);
      const keepStar = star && !unusedNow(star.name);
      const keepNamed = named.filter((el) => !unusedNow(el.name));
      const total = (clause.name ? 1 : 0) + (star ? 1 : 0) + named.length;
      const kept = (keepDefault ? 1 : 0) + (keepStar ? 1 : 0) + keepNamed.length;
      if (kept === total) continue;
      const specEdit = specEdits.get(stmt);
      if (specEdit) edits.splice(edits.indexOf(specEdit), 1);
      if (kept === 0) {
        edits.push({ start: stmt.getFullStart(), end: stmt.end, text: '' });
        continue;
      }
      const parts = [];
      if (keepDefault) parts.push(clause.name.text);
      if (keepStar) parts.push(`* as ${star.name.text}`);
      if (keepNamed.length) parts.push(`{ ${keepNamed.map((el) => el.getText(sf)).join(', ')} }`);
      const spec = specEdit ? specEdit.text : JSON.stringify(stmt.moduleSpecifier.text);
      edits.push({
        start: stmt.getStart(sf),
        end: stmt.end,
        text: `import ${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${spec};`,
      });
    }
  }

  if (problems.length) return { problems };
  return { text: applyEdits(text, edits), problems };
}

/* ------------------------------------------------------------------- generate */

async function generate(screen, keepLocal, contract) {
  const srcDir = path.join(v0Root, screen);
  if (!existsSync(srcDir)) return { problems: [`design/v0/${screen} does not exist`], files: new Map() };
  const sources = walk(srcDir)
    .map((full) => posix(path.relative(srcDir, full)))
    .filter((rel) => SOURCE_EXT.test(rel) && !SKIP_FILES.has(path.posix.basename(rel)))
    .sort();
  const copied = new Set(sources);
  const problems = [];
  const files = new Map();
  const config = (await prettier.resolveConfig(path.join(uiRoot, screen, 'x.tsx'))) ?? {};
  for (const rel of sources) {
    const text = lf(readFileSync(path.join(srcDir, rel), 'utf8'));
    const result = transform({ screen, rel, text, contract, keepLocal, copied });
    problems.push(...result.problems);
    if (result.text === undefined) continue;
    const dest = path.join(uiRoot, screen, rel);
    try {
      files.set(rel, await prettier.format(result.text, { ...config, filepath: dest, endOfLine: 'lf' }));
    } catch (error) {
      problems.push(`design/v0/${screen}/${rel}: prettier failed: ${error.message}`);
    }
  }
  return { problems, files };
}

function readManifest(screen) {
  const file = path.join(manifestRoot, `${screen}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function manifestScreens() {
  if (!existsSync(manifestRoot)) return [];
  return readdirSync(manifestRoot)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .sort();
}

function sourceCommit(screen) {
  try {
    const args = ['log', '-1', '--format=%H', '--', `design/v0/${screen}`];
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ----------------------------------------------------------------------- main */

async function integrate(screen, contract) {
  const previous = readManifest(screen);
  const keepLocal = previous?.keepLocal ?? [];
  const { problems, files } = await generate(screen, new Set(keepLocal), contract);
  if (problems.length) return problems;
  const destDir = path.join(uiRoot, screen);
  for (const full of walk(destDir)) {
    if (!files.has(posix(path.relative(destDir, full)))) rmSync(full);
  }
  for (const [rel, text] of files) {
    const dest = path.join(destDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text, 'utf8');
  }
  const manifest = { sourceCommit: sourceCommit(screen), files: [...files.keys()].sort(), keepLocal };
  mkdirSync(manifestRoot, { recursive: true });
  writeFileSync(path.join(manifestRoot, `${screen}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`integrated ${screen}: ${files.size} files`);
  return [];
}

async function check(screen, contract) {
  const manifest = readManifest(screen);
  if (!manifest) return [`${screen}: no manifest at apps/web/scripts/v0/${screen}.json`];
  const { problems, files } = await generate(screen, new Set(manifest.keepLocal ?? []), contract);
  if (problems.length) return problems;
  const out = [];
  const destDir = path.join(uiRoot, screen);
  const existing = new Map();
  for (const full of walk(destDir)) existing.set(posix(path.relative(destDir, full)), lf(readFileSync(full, 'utf8')));
  for (const [rel, text] of files) {
    if (!existing.has(rel)) out.push(`src/ui/${screen}/${rel}: missing`);
    else if (existing.get(rel) !== text) out.push(`src/ui/${screen}/${rel}: differs from what v0 generates`);
  }
  for (const rel of existing.keys()) {
    if (!files.has(rel)) out.push(`src/ui/${screen}/${rel}: extra file, not in design/v0/${screen}`);
  }
  const listed = [...files.keys()].sort().join('\n');
  if (listed !== [...(manifest.files ?? [])].sort().join('\n')) {
    out.push(`apps/web/scripts/v0/${screen}.json: files list is stale`);
  }
  return out;
}

const args = process.argv.slice(2);
const checking = args.includes('--check');
const all = args.includes('--all');
const named = args.filter((a) => !a.startsWith('--'));
const screens = all || (checking && named.length === 0) ? manifestScreens() : named;

if (screens.length === 0) {
  console.error('usage: integrate-v0.mjs <screen> [...] | --all | --check [<screen> ...]');
  process.exit(2);
}

const contract = contractTypeNames();
let failed = false;
for (const screen of screens) {
  const problems = checking ? await check(screen, contract) : await integrate(screen, contract);
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(p);
  } else if (checking) {
    console.log(`ok ${screen}`);
  }
}
if (failed) {
  if (checking) {
    console.error(
      '\nsrc/ui is generated from design/v0. Fix the cause in v0, then run: pnpm --filter @pd/web v0:integrate <screen>',
    );
  }
  process.exit(1);
}
