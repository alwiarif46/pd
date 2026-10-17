import { describe, expect, it } from 'vitest';
import { seedTargetDecision } from '../src/seed-guard';
import { runSeedCli } from '../src/seed-cli';
import { seedAll } from '../src/seed';

const url = (host: string, db: string) => `postgres://u:p@${host}:5432/${db}`;
const ok = (u: string, allow?: string) => seedTargetDecision(u, allow).ok;

describe('seedTargetDecision', () => {
  it('refuses a production-looking database on a remote host', () => {
    const d = seedTargetDecision(url('db.example.com', 'pd_production'));
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.message).toContain('pd_production');
    expect(d.ok === false && d.message).toContain('PD_SEED_ALLOW=pd_production');
    expect(d.ok === false && d.message).not.toContain(':p@');
  });

  it('allows names that say they are not production, on any host', () => {
    for (const name of ['seed_scratch_x', 'pd_test', 'pd_dev', 'pd_local', 'test_pd', 'scratch_1', 'local_pd', 'dev_pd', 'pd_scratch', 'test_ab12cd', 'pd-dev']) {
      expect(ok(url('db.example.com', name)), name).toBe(true);
    }
  });

  it('allows an unremarkable name on a loopback host', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) expect(ok(url(host, 'pd')), host).toBe(true);
  });

  it('refuses the maintenance database and names with prod, even on loopback', () => {
    expect(ok(url('127.0.0.1', 'postgres'))).toBe(false);
    expect(ok(url('localhost', 'pd_prod'))).toBe(false);
    expect(ok(url('localhost', 'production_copy'))).toBe(false);
    // A test-looking suffix does not excuse prod in the name.
    expect(ok(url('localhost', 'prod_test'))).toBe(false);
    expect(ok(url('db.example.com', 'prod_dev'))).toBe(false);
  });

  it('refuses an unremarkable name on a remote host', () => {
    expect(ok(url('db.example.com', 'pd'))).toBe(false);
    expect(ok(url('10.0.0.5', 'customers'))).toBe(false);
    expect(ok(url('localhost.example.com', 'pd'))).toBe(false);
  });

  it('allows anything when PD_SEED_ALLOW is the exact database name', () => {
    expect(ok(url('db.example.com', 'pd_production'), 'pd_production')).toBe(true);
    expect(ok(url('127.0.0.1', 'postgres'), 'postgres')).toBe(true);
    expect(ok(url('db.example.com', 'pd_production'), 'pd_prod')).toBe(false);
    expect(ok(url('db.example.com', 'pd_production'), 'PD_PRODUCTION')).toBe(false);
    expect(ok(url('db.example.com', 'pd_production'), '')).toBe(false);
  });

  it('judges the host and database that pg will dial, not the ones in the authority', () => {
    // pg-connection-string lets ?host= override the authority and ?db= name the database of a socket: URL.
    const bypass = [
      'postgres://u:p@127.0.0.1:5432/pd?host=db.example.com',
      'postgres:///pd?host=db.example.com',
      'socket:/var/run/postgresql?db=pd_production',
      'postgres://u:p@127.0.0.1/pd?hostaddr=10.1.2.3',
      'postgres://u:p@127.0.0.1/pd_dev?hostaddr=10.1.2.3',
      'postgres://u:p@127.0.0.1/pd?dbname=pd_production',
      'postgres://u:p@127.0.0.1/pd_dev?dbname=pd_production',
      'postgres://u:p@127.0.0.1,db.example.com/pd',
      'postgres://u:p@db.example.com,127.0.0.1/pd_dev',
      'postgres://u:p@127.0.0.1:5432,db.example.com:5432/pd_dev',
      'postgres://u:p@127.0.0.1/pd?service=prod',
    ];
    for (const u of bypass) expect(ok(u), u).toBe(false);
  });

  it('still allows a safe name when ?host= names a remote host, because the name is judged on its own', () => {
    expect(ok('postgres://u:p@127.0.0.1/pd_dev?host=db.example.com')).toBe(true);
    expect(ok('postgres://u:p@127.0.0.1/pd?host=localhost')).toBe(true);
    expect(ok('postgres:///pd?host=/var/run/postgresql')).toBe(true);
    expect(ok('socket:/var/run/postgresql?db=pd_scratch')).toBe(true);
    expect(ok('socket:/var/run/postgresql?db=pd')).toBe(true);
  });

  it('refuses a socket URL with no db, and a URL with no host at all', () => {
    expect(ok('socket:/var/run/postgresql')).toBe(false);
    expect(ok('postgres:///pd')).toBe(false); // PGHOST would decide
  });

  it('prints the host and database pg will use, never the password', () => {
    const d = seedTargetDecision('postgres://u:hunter2@127.0.0.1/pd?host=db.example.com');
    expect(d.ok).toBe(false);
    const m = d.ok === false ? d.message : '';
    expect(m).toContain('db.example.com');
    expect(m).toContain('"pd"');
    expect(m).not.toContain('hunter2');
    const bad = seedTargetDecision('postgres://u:hunter2@a,b/pd');
    expect(bad.ok === false && bad.message).not.toContain('hunter2');
  });

  it('does not take a name that merely contains a keyword as a test database (devices, testimonials)', () => {
    for (const name of ['devices', 'localization', 'testimonials', 'contest', 'pddevices', 'protest']) {
      expect(ok(url('db.example.com', name)), name).toBe(false);
    }
    for (const name of ['dev', 'test', 'pd-dev', 'pd_test', 'dev_pd', 'test-1', 'local', 'scratch_2']) {
      expect(ok(url('db.example.com', name)), name).toBe(true);
    }
  });

  it('refuses a URL without a database name or one that does not parse', () => {
    expect(ok('postgres://127.0.0.1:5432')).toBe(false);
    expect(ok('not a url')).toBe(false);
  });
});

describe('runSeedCli without a database', () => {
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const code = await runSeedCli(argv, env, (l) => out.push(l));
    return { code, text: out.join('\n') };
  };

  it('needs PD_ADMIN_DATABASE_URL', async () => {
    const r = await run([], {});
    expect(r.code).toBe(1);
    expect(r.text).toContain('PD_ADMIN_DATABASE_URL');
  });

  it('refuses a production-looking URL before it connects', async () => {
    const r = await run([], { PD_ADMIN_DATABASE_URL: url('db.example.com', 'pd_production') });
    expect(r.code).toBe(1);
    expect(r.text).toContain('refusing');
    expect(r.text).toContain('PD_SEED_ALLOW');
  });

  it('does not fall back to TEST_DATABASE_URL when that database fails the guard', async () => {
    const r = await run([], { TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:54329/postgres' });
    expect(r.code).toBe(1);
    expect(r.text).toContain('TEST_DATABASE_URL');
    expect(r.text).toContain('refusing');
  });

  it('rejects an unknown flag', async () => {
    const r = await run(['--wipe'], { PD_ADMIN_DATABASE_URL: url('127.0.0.1', 'pd_dev') });
    expect(r.code).toBe(1);
    expect(r.text).toContain('--wipe');
  });
});

describe('seedAll without a database', () => {
  it('refuses a production-looking URL before it connects', async () => {
    await expect(seedAll(url('db.example.com', 'pd_production'))).rejects.toThrow(/refusing.*pd_production/s);
    await expect(seedAll(url('db.example.com', 'pd_production'), undefined, { allow: 'other' })).rejects.toThrow(/refusing/);
  });
});
