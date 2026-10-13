import type { Config } from 'drizzle-kit';

export default {
  schema: './packages/core/src/db/schema.ts',
  out: './packages/core/src/db/migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
} satisfies Config;
