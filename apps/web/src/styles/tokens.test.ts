import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  // The legacy layer declares --muted and --card on :root. Unlayered Atrium values would beat them and break
  // legacy text, so the variable blocks must sit in a layer above legacy (src/styles/globals.css).
  it('declares the Atrium variables inside @layer base', () => {
    const root = css.indexOf(':root,');
    const layer = css.indexOf('@layer base {');
    expect(layer).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(layer);
    expect(css.indexOf('@theme')).toBeGreaterThan(root);
  });
  it('keeps the dark values under .dark', () => {
    expect(css).toMatch(/\n\s*\.dark \{/);
  });
});
