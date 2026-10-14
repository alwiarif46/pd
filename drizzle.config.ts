import { defineConfig } from 'drizzle-kit';

// Migrations run as the owner role `pd_owner` (02 s4), never as `pd_app`.
// `DATABASE_URL` here must be the owner connection string. pd_owner must own the database and
// have CREATEROLE (or find pd_app and pd_system already created); it need not be a superuser.
// Tenant tables FORCE row-level security and no policy names the owner, so a migration that
// backfills tenant data sees zero rows unless it sets app.org_id under a role a policy covers.
// See the header of migrations/0001_tenant_rls.sql.
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/core/src/db/schema.ts',
  out: './packages/core/src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
