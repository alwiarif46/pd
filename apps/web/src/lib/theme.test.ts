// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, initTheme, readTheme } from './theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('theme', () => {
  it('defaults to light', () => {
    initTheme();
    expect(readTheme()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
  it('applies and remembers dark', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.documentElement.classList.remove('dark');
    initTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
