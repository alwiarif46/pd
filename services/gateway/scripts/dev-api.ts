/**
 * Local dev API against the database `pnpm dev:db` started: reads <root>/dev-db.json and
 * runs the API in watch mode on port 3001. Sign-up, reset and invite codes print to this
 * console (NODE_ENV=development with PD_DEV_PRINT_SECRETS=1), since nothing is sent locally.
 *
 *   pnpm dev:api                      with the database in <repo>/.dev/pg
 *   PD_DEV_DB_ROOT=<dir> pnpm dev:api with the database in <dir>
 *
 * Uploaded files go to <root>/files unless DATA_DIR is set.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.PD_DEV_DB_ROOT || join(apiDir, '../..', '.dev', 'pg'));
const configPath = join(root, 'dev-db.json');
if (!existsSync(configPath)) {
  console.error(`No ${configPath}. Start the database first with: pnpm dev:db`);
  process.exit(1);
}
const { databaseUrl } = JSON.parse(readFileSync(configPath, 'utf8')) as { databaseUrl: string };
const dataDir = process.env.DATA_DIR || join(root, 'files');
mkdirSync(dataDir, { recursive: true });

// tsx's CLI through this Node, so pnpm need not be on PATH.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const child = spawn(process.execPath, [tsxCli, 'watch', 'src/index.ts'], {
  cwd: apiDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PD_DEV_PRINT_SECRETS: '1',
    DATABASE_URL: databaseUrl,
    PORT: process.env.PORT || '3001',
    DATA_DIR: dataDir,
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
