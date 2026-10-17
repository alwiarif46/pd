import { afterEach, beforeEach, vi } from 'vitest';

/** In-memory `Storage` so tests get a fresh `sessionStorage` in the Node environment. */
export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.has(key) ? (this.values.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemoryStorage());
});

// Component tests (`// @vitest-environment jsdom`): what Radix needs that jsdom lacks, and unmounting
// after each test.
if (typeof window !== 'undefined') {
  const { installDomPolyfills } = await import('./dom');
  installDomPolyfills();
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
