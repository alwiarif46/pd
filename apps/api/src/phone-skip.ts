/**
 * PD_SKIP_PHONE_VERIFY_EMAILS: testers whose phone verification is skipped. A comma-separated
 * list of exact email addresses, matched case-insensitively against the account's email (which
 * is stored lowercased). Off when unset or empty. No wildcards and no domain-wide entries: an
 * entry that is not one exact address stops the start. Email verification is still required.
 *
 * The addresses are personal data: they are never logged, and errors name an entry by its
 * position, not its value.
 */

const LOCAL = /^[a-z0-9_+'-]+(\.[a-z0-9_+'-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD = /^[a-z]{2,}$/;

function isExactAddress(entry: string): boolean {
  const parts = entry.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  const labels = domain.split('.');
  return LOCAL.test(local)
    && labels.length >= 2
    && labels.every((label) => LABEL.test(label))
    && TLD.test(labels[labels.length - 1]);
}

export function phoneSkipListFromEnv(value = process.env.PD_SKIP_PHONE_VERIFY_EMAILS): ReadonlySet<string> {
  const entries = (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  entries.forEach((entry, index) => {
    if (!isExactAddress(entry)) {
      throw new Error(`PD_SKIP_PHONE_VERIFY_EMAILS: entry ${index + 1} is not one exact email address (no wildcards or domains).`);
    }
  });
  return new Set(entries);
}

/** The one startup warning while the skip is on: the count only. */
export function warnPhoneSkip(list: ReadonlySet<string>): void {
  if (list.size > 0) {
    console.warn(`PD_SKIP_PHONE_VERIFY_EMAILS is set: phone verification is skipped for ${list.size} allow-listed account(s). Email verification is still required.`);
  }
}

/** Whether this account's email is on the list. */
export function skipsPhone(list: ReadonlySet<string>, email: string): boolean {
  return list.size > 0 && list.has(email.trim().toLowerCase());
}
