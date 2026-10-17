import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'yahoo.com',
  'hotmail.com',
  'live.com',
  'aol.com',
  'icloud.com',
]);

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }
  const next = (await scryptAsync(password, salt, 32)) as Buffer;
  const current = Buffer.from(hash, 'hex');
  if (current.length !== next.length) {
    return false;
  }
  return timingSafeEqual(current, next);
}

export function isWorkEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain) && !FREE_EMAIL_DOMAINS.has(domain);
}

export function isUsPhone(phone: string): boolean {
  return /^\+1\d{10}$/.test(phone);
}

export function newPhoneCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Compares two hex digests (from hashToken) in constant time. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Keys are swept once a map holds this many, so unknown addresses cannot grow memory without bound. */
const SWEEP_AT = 10_000;

/**
 * Counts events per key over a sliding window, in this process's memory. It resets on restart
 * and is per instance; Cloudflare's rate limits on auth routes are the outer net (07 s5).
 */
class WindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  count(key: string): number {
    return this.recent(key).length;
  }

  record(key: string): void {
    const stamps = this.recent(key);
    stamps.push(Date.now());
    this.hits.set(key, stamps);
    if (this.hits.size > SWEEP_AT) {
      for (const other of [...this.hits.keys()]) {
        if (this.recent(other).length === 0) {
          this.hits.delete(other);
        }
      }
    }
  }

  clear(): void {
    this.hits.clear();
  }

  private recent(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    return (this.hits.get(key) ?? []).filter((stamp) => stamp >= cutoff);
  }
}

export type CapResult = { ok: true } | { ok: false; reason: string };

/**
 * A daily send cap per IP address and per account key (06 s1: 10 a day per IP, 5 a day per
 * account). Every key passed must be under its cap; then the send is recorded against all.
 */
function dailyCap(label: string, ipLimit: number, keyLimit: number) {
  const byIp = new WindowCounter(DAY_MS);
  const byKey = new WindowCounter(DAY_MS);
  return {
    record(ip: string, keys: string[]): CapResult {
      if (byIp.count(ip) >= ipLimit) {
        return { ok: false, reason: `Daily ${label} cap for this IP is ${ipLimit}` };
      }
      if (keys.some((key) => byKey.count(key) >= keyLimit)) {
        return { ok: false, reason: `Daily ${label} cap for this account is ${keyLimit}` };
      }
      byIp.record(ip);
      keys.forEach((key) => byKey.record(key));
      return { ok: true };
    },
    clear(): void {
      byIp.clear();
      byKey.clear();
    },
  };
}

const smsCap = dailyCap('SMS', 10, 5);
const emailCap = dailyCap('email', 10, 5);

/**
 * Records an SMS send against the caller's IP and each account key (signup passes the email and
 * the phone; resend-code passes the email, as the caller never names the phone), or says which
 * cap is reached.
 */
export function recordSmsSend(ip: string, accountKeys: string[]): CapResult {
  return smsCap.record(ip, accountKeys);
}

/** The same caps as SMS, for verification emails. */
export function recordEmailSend(ip: string, accountKeys: string[]): CapResult {
  return emailCap.record(ip, accountKeys);
}

/** Test hook: forgets every recorded send. */
export function resetSendCaps(): void {
  smsCap.clear();
  emailCap.clear();
}

// ---------------------------------------------------------------------------------------------
// Out-of-band delivery (email links and SMS codes)
// ---------------------------------------------------------------------------------------------

export interface OutOfBandMessage {
  channel: 'email' | 'sms';
  purpose: 'verify_email' | 'verify_phone' | 'reset_password' | 'invite';
  /** The email address or E.164 phone number. Never logged. */
  to: string;
  /** The token or code. Never logged. */
  secret: string;
}

export type OutOfBandSink = (message: OutOfBandMessage) => void | Promise<void>;

let sink: OutOfBandSink | null = null;
const warned = new Set<string>();

/**
 * Installs the delivery for email links and SMS codes (the email and Telnyx senders once they
 * exist; tests install a collector). `null` removes it.
 */
export function setOutOfBandSink(next: OutOfBandSink | null): void {
  sink = next;
}

/**
 * In production (NODE_ENV=production) the app must not start without a delivery installed:
 * signup, resends, resets and invites would answer success and send nothing.
 */
export function assertOutOfBandDelivery(): void {
  if (process.env.NODE_ENV === 'production' && !sink) {
    throw new Error('No email/SMS delivery is installed (setOutOfBandSink). Refusing to start with NODE_ENV=production.');
  }
}

/**
 * Printing secrets to stdout is a local-development aid only. It needs both
 * NODE_ENV=development and PD_DEV_PRINT_SECRETS=1; anything else prints nothing.
 */
function devPrintEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.PD_DEV_PRINT_SECRETS === '1';
}

function warnOnce(message: string): void {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(message);
  }
}

/**
 * Delivers an email link or SMS code. Never throws: a failed delivery is logged without the
 * destination or the secret, and the route answers as it would on success, so the response
 * does not depend on delivery (the user can ask for a resend).
 */
export async function sendOutOfBand(message: OutOfBandMessage): Promise<void> {
  try {
    if (sink) {
      await sink(message);
      return;
    }
    if (devPrintEnabled()) {
      console.log(`[dev only: PD_DEV_PRINT_SECRETS=1] ${message.channel} ${message.purpose} to ${message.to}: ${message.secret}`);
      return;
    }
    if (process.env.PD_DEV_PRINT_SECRETS === '1') {
      warnOnce('PD_DEV_PRINT_SECRETS=1 is ignored unless NODE_ENV=development.');
    }
    warnOnce(`No ${message.channel} delivery is configured: ${message.purpose} messages are not sent.`);
  } catch (error) {
    console.error(`Out-of-band delivery failed (${message.channel} ${message.purpose}): ${error instanceof Error ? error.name : 'error'}`);
  }
}
