import { pbkdf2Sync, createHmac, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { scramVerifier } from '../src/scram';
import { BASE_URL, SKIP_DB, useTestDatabase } from './db-helper';

function independent(password: string, salt: Buffer, iterations: number): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const server = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${server.toString('base64')}`;
}

describe('scramVerifier', () => {
  it('has the Postgres layout with a fresh 16 byte salt and 4096 iterations', () => {
    const v = scramVerifier('pw');
    const m = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(v);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(m![2]!, 'base64')).toHaveLength(32);
    expect(Buffer.from(m![3]!, 'base64')).toHaveLength(32);
    expect(scramVerifier('pw')).not.toBe(v);
    expect(v).not.toContain('pw$');
  });

  it('matches a verifier computed independently with the same salt', () => {
    const salt = Buffer.from('0123456789abcdef');
    expect(scramVerifier('correct horse', salt, 4096)).toBe(independent('correct horse', salt, 4096));
    expect(scramVerifier('correct horse', salt, 4096)).not.toBe(independent('wrong horse', salt, 4096));
  });
});

describe.skipIf(SKIP_DB)('scramVerifier against Postgres', () => {
  useTestDatabase();

  it('equals the verifier Postgres stores for the same password, salt and iteration count', async () => {
    const base = new pg.Client({ connectionString: BASE_URL });
    await base.connect();
    const role = `sk_scram_${randomBytes(5).toString('hex')}`;
    try {
      await base.query(`create role "${role}" login`);
      await base.query("set password_encryption = 'scram-sha-256'");
      await base.query(`alter role "${role}" password 'pa55 word'`);
      const stored = (await base.query<{ p: string }>('select rolpassword as p from pg_authid where rolname = $1', [role])).rows[0]!.p;
      const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored);
      expect(m, stored).not.toBeNull();
      const mine = scramVerifier('pa55 word', Buffer.from(m![2]!, 'base64'), Number(m![1]));
      expect(mine).toBe(stored);
      // And Postgres accepts the verifier as given, without re-hashing it.
      const other = `sk_scram2_${randomBytes(5).toString('hex')}`;
      try {
        await base.query(`create role "${other}" login`);
        const stmt = await base.query<{ sql: string }>("select format('alter role %I password %L', $1::text, $2::text) as sql", [other, mine]);
        await base.query(stmt.rows[0]!.sql);
        const kept = await base.query('select rolpassword as p from pg_authid where rolname = $1', [other]);
        expect(kept.rows[0].p).toBe(mine);
      } finally {
        await base.query(`drop role if exists "${other}"`);
      }
    } finally {
      await base.query(`drop role if exists "${role}"`);
      await base.end();
    }
  });

  it('is what the migrator stored for every service role', async () => {
    const base = new pg.Client({ connectionString: BASE_URL });
    await base.connect();
    try {
      const r = await base.query("select rolname, rolpassword from pg_authid where rolname like '%\\_svc' and rolcanlogin");
      expect(r.rows.length).toBeGreaterThanOrEqual(14);
      for (const row of r.rows) expect(row.rolpassword, row.rolname).toMatch(/^SCRAM-SHA-256\$4096:/);
    } finally {
      await base.end();
    }
  });
});
