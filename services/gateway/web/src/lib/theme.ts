// Atrium's dark mode: a .dark class on <html>. The stored choice is the only input for now. Following the OS
// setting waits until the legacy screens, which have no dark styles, are retired.
export type ThemeMode = 'light' | 'dark';

const KEY = 'e2e-theme';

export function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private windows can refuse storage. The class still applies for this page.
  }
}

export function initTheme(): void {
  document.documentElement.classList.toggle('dark', readTheme() === 'dark');
}
