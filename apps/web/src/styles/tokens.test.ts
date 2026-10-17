import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  it('declares the Atrium variables inside @layer base', () => {
    const root = css.indexOf(':root,');
    const layer = css.indexOf('@layer base {');
    expect(layer).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(layer);
    expect(css.indexOf('@theme static')).toBeGreaterThan(root);
  });
  it('keeps the dark values under .dark', () => {
    expect(css).toMatch(/\n\s*\.dark \{/);
  });
});

describe('legacy stylesheet', () => {
  // Atrium owns --muted and --card. The legacy file must not declare them, or Atrium's values would change
  // legacy text colors (near-white muted text on a white card).
  it('does not declare Atrium variable names', () => {
    const legacy = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(legacy).not.toMatch(/--(muted|card|background|foreground|border|primary|accent):/);
    expect(legacy).not.toMatch(/var\(--(muted|card)\)/);
  });
});
