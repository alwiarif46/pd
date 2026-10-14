import { defineConfig } from 'drizzle-kit';

// Migrations run as the owner role `pd_owner` (02 s4), never as `pd_app`.
// `DATABASE_URL` here must be the owner connection string.
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/core/src/db/schema.ts',
  out: './packages/core/src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
