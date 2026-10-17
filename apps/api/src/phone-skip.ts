/**
 * PD_SKIP_PHONE_VERIFY_EMAILS: testers whose phone verification is skipped. A comma-separated
 * list of exact email addresses, matched case-insensitively against the account's email (which
 * is stored lowercased). Off when unset or empty. No wildcards and no domain-wide entries: an
 * entry that is not one exact address stops the start. Email verification is still required.
 *
 * The addresses are personal data: they are never logged, and errors name an entry by its
 * position, not its value.
 */
import { normalizeAddress } from './email-address.js';

export function phoneSkipListFromEnv(value = process.env.PD_SKIP_PHONE_VERIFY_EMAILS): ReadonlySet<string> {
  const raw = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return new Set(raw.map((entry, index) => {
    const address = normalizeAddress(entry);
    if (!address) {
      throw new Error(`PD_SKIP_PHONE_VERIFY_EMAILS: entry ${index + 1} is not one exact email address (no wildcards or domains).`);
    }
    return address;
  }));
}

/** The one startup warning while the skip is on: the count only. */
export function warnPhoneSkip(list: ReadonlySet<string>): void {
  if (list.size > 0) {
    console.warn(`PD_SKIP_PHONE_VERIFY_EMAILS is set: phone verification is skipped for ${list.size} allow-listed account(s). Email verification is still required.`);
  }
}

/**
 * Whether this account's email is on the list. `email` is the stored address, already
 * normalized at signup; it is compared exactly, with no case folding here (folding could map a
 * look-alike such as the Kelvin sign onto an entry).
 */
export function skipsPhone(list: ReadonlySet<string>, email: string): boolean {
  return list.size > 0 && list.has(email);
}
