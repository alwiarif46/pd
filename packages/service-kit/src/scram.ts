import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * A SCRAM-SHA-256 verifier in the form Postgres stores in `pg_authid.rolpassword`
 * (RFC 5802 and RFC 7677): `SCRAM-SHA-256$<iterations>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>`.
 * Sending this instead of the plain password keeps the plain text out of the statement the
 * server sees and logs. `salt` and `iterations` are parameters for the known-answer test only.
 *
 * The password is used as UTF-8 bytes. Postgres runs SASLprep first; for the ASCII passwords the
 * migrator is given the two are the same.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
