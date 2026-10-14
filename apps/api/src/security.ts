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

const sendsByIp = new Map<string, number[]>();
const sendsByAccount = new Map<string, number[]>();

function recent(stamps: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return stamps.filter((stamp) => stamp >= cutoff);
}

export function recordSmsSend(ip: string, accountKey: string): { ok: true } | { ok: false; reason: string } {
  const day = 24 * 60 * 60 * 1000;
  const ipStamps = recent(sendsByIp.get(ip) ?? [], day);
  const accountStamps = recent(sendsByAccount.get(accountKey) ?? [], day);
  if (ipStamps.length >= 10) {
    return { ok: false, reason: 'Daily SMS cap for this IP is 10' };
  }
  if (accountStamps.length >= 5) {
    return { ok: false, reason: 'Daily SMS cap for this account is 5' };
  }
  ipStamps.push(Date.now());
  accountStamps.push(Date.now());
  sendsByIp.set(ip, ipStamps);
  sendsByAccount.set(accountKey, accountStamps);
  return { ok: true };
}

export function logOutOfBand(kind: 'email' | 'sms', destination: string, secret: string): void {
  console.log(`[${kind}] to ${destination}: ${secret}`);
}
