/**
 * One bare email address, the only form the API accepts wherever an address comes in (signup,
 * resend-email, resend-code, reset, org invites, PD_SKIP_PHONE_VERIFY_EMAILS) and the only form
 * the email sender will deliver to. Resend reads "Name <addr>" and comma lists as recipients,
 * and isWorkEmail only looks after the first "@", so anything looser lets a sign-up pass the
 * work-email rule with a free-mail inbox, store an address that reads like someone else's, or
 * send one link to several inboxes.
 *
 * The check is on the raw value, ASCII only, before lowercasing: "K" (KELVIN SIGN)
 * lowercases to "k", so it is refused rather than folded into another address.
 */

const LOCAL = /^[a-z0-9_+'-]+(\.[a-z0-9_+'-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD = /^[a-z]{2,}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** RFC 5321's limit for a forward path. */
const MAX_LENGTH = 254;

/** The trimmed, lowercased address, or null unless the value is exactly one bare address. */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH || !PRINTABLE_ASCII.test(value)) {
    return null;
  }
  const lower = value.toLowerCase();
  const parts = lower.split('@');
  if (parts.length !== 2) {
    return null;
  }
  const [local, domain] = parts;
  const labels = domain.split('.');
  const ok = LOCAL.test(local)
    && labels.length >= 2
    && labels.every((label) => LABEL.test(label))
    && TLD.test(labels[labels.length - 1]);
  return ok ? lower : null;
}
