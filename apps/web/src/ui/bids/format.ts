export const BYTES_PER_MB = 1024 * 1024;

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  // Date-only ISO strings are calendar dates; format them in UTC so they never shift a day.
  const isDateOnly = DATE_ONLY.test(iso);
  const date = new Date(isDateOnly ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(isDateOnly ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

export function formatMb(bytes: number): string {
  const mb = Math.max(0, bytes) / BYTES_PER_MB;
  return mb.toFixed(1).replace(/\.0$/, '');
}

export function formatFileSize(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${formatMb(bytes)} MB`;
}

export function creditsLine(creditsLeft: number, creditsResetOn: string): string {
  const noun = creditsLeft === 1 ? 'credit' : 'credits';
  return `${creditsLeft} RFP ${noun} left, resets on ${formatDate(creditsResetOn) ?? creditsResetOn}`;
}

export const outOfCreditsCopy = {
  title: 'You have no RFP credits left',
  body: (creditsResetOn: string) =>
    `Your credits reset on ${formatDate(creditsResetOn) ?? creditsResetOn}. Upgrade your plan to start a new bid before then. You can still open your existing bids.`,
};
