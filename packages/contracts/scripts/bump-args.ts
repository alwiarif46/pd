import type { BumpResult } from './bump';

/** Reads --base <ref> (or --base=<ref>) and --repo <dir>. A bare "--" from pnpm is ignored. */
export function readBase(argv: string[]): { ref: string; repo?: string } | undefined {
  let ref: string | undefined;
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--base') ref = argv[++i];
    else if (a.startsWith('--base=')) ref = a.slice('--base='.length);
    else if (a === '--repo') repo = argv[++i];
    else if (a.startsWith('--repo=')) repo = a.slice('--repo='.length);
  }
  return ref ? { ref, repo } : undefined;
}

export function printBump(r: BumpResult): void {
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  if (r.status === 'skipped') console.log(r.messages.join('\n'));
  else if (r.status === 'failed') {
    console.error(`contracts:check:bump failed with ${r.messages.length} problem(s):`);
    for (const m of r.messages) console.error(`  - ${m}`);
  } else console.log(`contracts:check:bump ok: ${r.checked} changed contract file(s) carry a version bump`);
}
