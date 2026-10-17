import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SERVICES as CONTRACT_SERVICES } from '@pd/contracts';
import { scramVerifier } from './scram.js';

/** The fixed order of 09 s9.3: later schemas carry ids that earlier services issue. */
export const MIGRATION_ORDER = [
  'app',
  'identity',
  'billing',
  'ingest',
  'intel',
  'orchestrator',
  'modelgw',
  'drafting',
  'review',
  'render',
  'evidence',
  'comms',
  'portal',
  'drive',
  'notify',
] as const;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The `app` step's SQL: the shared schema and `app_settings`. */
export const APP_MIGRATIONS_DIR = join(REPO_ROOT, 'infra', 'db', 'app');

export interface MigrationService {
  id: string;
  schema: string;
  /** Folder relative to the repo root; its `migrations/` holds the SQL files. */
  folder: string;
}

export interface ApplyMigrationsOptions {
  /** Connection string for a role that can create roles and schemas (the admin). */
  adminUrl: string;
  /** The services to migrate. Run in MIGRATION_ORDER whatever order they come in. */
  services: ReadonlyArray<MigrationService>;
  /** Migrate only these service ids (the `app` step and the role bootstrap still run for them). */
  only?: ReadonlyArray<string>;
  /** Service id to role password. Falls back to env `<SERVICE>_DB_PASSWORD`. No password: NOLOGIN. */
  passwords?: Readonly<Record<string, string>>;
  /** Password of the outbox relay role. Falls back to env `OUTBOX_RELAY_DB_PASSWORD`. None: NOLOGIN. */
  relayPassword?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  log?: (line: string) => void;
}

export interface StepResult {
  step: string;
  applied: string[];
  skipped: string[];
}

const IDENT = /^[a-z][a-z0-9_]*$/;
const LOCK_KEY = 7_450_901;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Not a safe identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export function roleName(schema: string): string {
  return `${schema}_svc`;
}

/**
 * The one cluster-wide role that reads every tenant's unpublished outbox rows (the rule 4
 * exception in CLAUDE.md). LOGIN NOINHERIT NOSUPERUSER; it holds CONNECT, USAGE on each service
 * schema, SELECT on each `<schema>.outbox` and UPDATE (published_at) on it, and nothing else.
 */
export const RELAY_ROLE = 'outbox_relay';

/** The services of services.json that have a schema (every service except the gateway). */
export function migrationServices(): MigrationService[] {
  return CONTRACT_SERVICES.flatMap((s) =>
    s.schema === null ? [] : [{ id: s.id, schema: s.schema, folder: s.folder }],
  );
}

export function migrationFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function ensureLedger(client: pg.Client, schema: string): Promise<void> {
  await client.query(`create schema if not exists ${ident(schema)}`);
  await client.query(
    `create table if not exists ${ident(schema)}.schema_migrations (
       id text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
}

async function runDir(client: pg.Client, schema: string, dir: string, step: string): Promise<StepResult> {
  await ensureLedger(client, schema);
  const done = new Set(
    (await client.query<{ id: string }>(`select id from ${ident(schema)}.schema_migrations`)).rows.map((r) => r.id),
  );
  const result: StepResult = { step, applied: [], skipped: [] };
  for (const file of migrationFiles(dir)) {
    if (done.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      // A file that names a table without a schema lands in its own schema, never another's.
      await client.query(`set local search_path = ${ident(schema)}`);
      await client.query(sql);
      await client.query(`insert into ${ident(schema)}.schema_migrations (id) values ($1)`, [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${step}: ${file} failed: ${(err as Error).message}`);
    }
    result.applied.push(file);
  }
  return result;
}

/** Creates the role if missing; sets LOGIN and the password when one is given, else NOLOGIN. */
async function bootstrapRole(client: pg.Client, svc: MigrationService, password: string | undefined): Promise<void> {
  const role = roleName(svc.schema);
  ident(role);
  await client.query(
    `do $$ begin
       create role ${ident(role)} nologin nosuperuser nobypassrls nocreatedb nocreaterole;
     exception when duplicate_object then null;
     end $$`,
  );
  if (password) {
    // DDL takes no bind parameters: let the server quote the literal. The literal is a SCRAM-SHA-256
    // verifier, not the plain password, so the plain text never reaches the server or its logs.
    const stmt = await client.query<{ sql: string }>(
      "select format('alter role %I login password %L', $1::text, $2::text) as sql",
      [role, scramVerifier(password)],
    );
    await client.query(stmt.rows[0]!.sql);
  }
  await client.query(`alter role ${ident(role)} set search_path = ${ident(svc.schema)}`);
  await client.query(`revoke all on schema public from ${ident(role)}`);
}

/**
 * Creates the relay role if missing. Postgres lets only a role with BYPASSRLS create one, so the
 * role gets BYPASSRLS when the migrator has it. Either way the two relay policies in `relayGrants`
 * open the unpublished rows to it, so the role works without BYPASSRLS too.
 */
async function bootstrapRelayRole(client: pg.Client, password: string | undefined): Promise<void> {
  const me = await client.query<{ can: boolean }>(
    'select rolsuper or rolbypassrls as can from pg_roles where rolname = current_user',
  );
  const attrs = me.rows[0]?.can ? 'bypassrls' : 'nobypassrls';
  await client.query(
    `do $$ begin
       create role ${ident(RELAY_ROLE)} nologin noinherit nosuperuser ${attrs} nocreatedb nocreaterole;
     exception when duplicate_object then null;
     end $$`,
  );
  if (!password) {
    // No password this run: an existing relay role stops being able to log in.
    await client.query(`alter role ${ident(RELAY_ROLE)} nologin`);
  } else {
    // Same as the service roles: a SCRAM-SHA-256 verifier, never the plain password.
    const stmt = await client.query<{ sql: string }>(
      "select format('alter role %I login password %L', $1::text, $2::text) as sql",
      [RELAY_ROLE, scramVerifier(password)],
    );
    await client.query(stmt.rows[0]!.sql);
  }
  await client.query(`revoke all on schema public from ${ident(RELAY_ROLE)}`);
  const grant = await client.query<{ sql: string }>(
    "select format('grant connect on database %I to %I', current_database(), $1::text) as sql",
    [RELAY_ROLE],
  );
  await client.query(grant.rows[0]!.sql);
}

/** Runs after the service migrations, because it grants on the tables they create. */
async function relayGrants(client: pg.Client, services: ReadonlyArray<MigrationService>): Promise<void> {
  const role = ident(RELAY_ROLE);
  for (const svc of services) {
    const s = ident(svc.schema);
    // A schema without an outbox (a test fixture) has nothing to grant.
    const has = await client.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${s}.outbox`]);
    if (!has.rows[0]?.ok) continue;
    await client.query(`grant usage on schema ${s} to ${role}`);
    await client.query(`revoke all on ${s}.outbox from ${role}`);
    await client.query(`grant select on ${s}.outbox to ${role}`);
    await client.query(`grant update (published_at) on ${s}.outbox to ${role}`);
    // Permissive policies add up per row. The tenant policy stays closed to this role; these two
    // open every tenant's rows to it. They test current_user, not role membership, so the
    // migrator (a member of this role) still obeys the tenant policy. Postgres checks the new row
    // of an UPDATE against the SELECT policy too, so the read policy cannot hide published rows.
    // relay_no_unsend is restrictive, so it ANDs with the permissive policies. Without it the
    // tenant policy would let the relay write a null published_at whenever app.tenant_id is set,
    // because permissive WITH CHECKs are OR'd. Limit: no policy applies to a BYPASSRLS relay (the
    // role has that attribute when the migrator had it). Then only the column grant protects the
    // outbox, and that relay can still set published_at back to null.
    const me = `current_user = '${RELAY_ROLE}'`;
    await client.query(`drop policy if exists relay_read on ${s}.outbox`);
    await client.query(`create policy relay_read on ${s}.outbox for select using (${me})`);
    await client.query(`drop policy if exists relay_publish on ${s}.outbox`);
    await client.query(
      `create policy relay_publish on ${s}.outbox for update
         using (${me} and published_at is null) with check (${me} and published_at is not null)`,
    );
    await client.query(`drop policy if exists relay_no_unsend on ${s}.outbox`);
    await client.query(
      `create policy relay_no_unsend on ${s}.outbox as restrictive for update
         using (true) with check (current_user <> '${RELAY_ROLE}' or published_at is not null)`,
    );
  }
}

/**
 * The `app` step. Roles first, then the shared schema, then one read-only `app_settings` view in
 * each service schema. Service roles get no access to `app` itself: the view runs with its
 * owner's rights.
 */
async function appStep(
  client: pg.Client,
  services: ReadonlyArray<MigrationService>,
  passwords: (id: string) => string | undefined,
  relayPassword: string | undefined,
  repoRoot: string,
  log: (line: string) => void,
): Promise<StepResult> {
  await client.query('revoke all on schema public from public');
  // Roles can otherwise connect to every database of the cluster through PUBLIC. Only this
  // database, which the migrator was pointed at on purpose, is changed.
  const revoke = await client.query<{ sql: string }>(
    "select format('revoke connect on database %I from public', current_database()) as sql",
  );
  await client.query(revoke.rows[0]!.sql);
  for (const svc of services) {
    await bootstrapRole(client, svc, passwords(svc.id));
    const grant = await client.query<{ sql: string }>(
      "select format('grant connect on database %I to %I', current_database(), $1::text) as sql",
      [roleName(svc.schema)],
    );
    await client.query(grant.rows[0]!.sql);
    log(`role ${roleName(svc.schema)}: ready`);
  }
  await bootstrapRelayRole(client, relayPassword);
  log(`role ${RELAY_ROLE}: ready`);
  await client.query('create schema if not exists app');
  await client.query('revoke all on schema app from public');
  const appDir = repoRoot === REPO_ROOT ? APP_MIGRATIONS_DIR : join(repoRoot, 'infra', 'db', 'app');
  const result = await runDir(client, 'app', appDir, 'app');
  for (const svc of services) {
    await client.query(`create schema if not exists ${ident(svc.schema)}`);
    await client.query(
      `create or replace view ${ident(svc.schema)}.app_settings as
         select key, value, updated_at from app.app_settings`,
    );
    await client.query(`revoke all on ${ident(svc.schema)}.app_settings from public`);
    await client.query(`grant select on ${ident(svc.schema)}.app_settings to ${ident(roleName(svc.schema))}`);
  }
  return result;
}

export async function applyMigrations(options: ApplyMigrationsOptions): Promise<StepResult[]> {
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const known = new Map(options.services.map((s) => [s.id, s]));
  for (const id of options.only ?? []) {
    if (!known.has(id)) throw new Error(`Unknown service in "only": ${id}`);
  }
  const rank = (id: string): number => {
    const i = MIGRATION_ORDER.indexOf(id as (typeof MIGRATION_ORDER)[number]);
    if (i < 0) throw new Error(`Service ${id} is not in the migration order`);
    return i;
  };
  const selected = options.services
    .filter((s) => !options.only || options.only.includes(s.id))
    .sort((a, b) => rank(a.schema) - rank(b.schema));
  const passwords = (id: string): string | undefined =>
    options.passwords?.[id] ?? (env[`${id.toUpperCase()}_DB_PASSWORD`] || undefined);

  const relayPassword = options.relayPassword ?? (env.OUTBOX_RELAY_DB_PASSWORD || undefined);

  const client = new pg.Client({ connectionString: options.adminUrl });
  await client.connect();
  const results: StepResult[] = [];
  try {
    // One migrator at a time per database.
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      const app = await appStep(client, selected, passwords, relayPassword, repoRoot, log);
      results.push(app);
      log(`app: applied ${app.applied.length}, skipped ${app.skipped.length}`);
      for (const svc of selected) {
        const dir = join(repoRoot, svc.folder, 'migrations');
        const r = await runDir(client, svc.schema, dir, svc.id);
        results.push(r);
        log(`${svc.id}: applied ${r.applied.length}, skipped ${r.skipped.length}`);
      }
      await relayGrants(client, selected);
      log(`${RELAY_ROLE}: granted on ${selected.length} outbox tables`);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
  return results;
}
