// Starts the three test doubles for the native stack (E2E_STACK=native): mock OIDC (stands in for Zitadel),
// in-memory S3 (for SeaweedFS), and a clamd stand-in (for ClamAV). Run by infra/local/native-stack.sh.
// Ports default to the real services' ports; override with PD_DOUBLE_OIDC_PORT, PD_DOUBLE_S3_PORT, PD_DOUBLE_CLAMD_PORT.
import { NATIVE_PORTS, startMockClamd, startMockOidc, startMockS3 } from '../src/index.js';

const host = process.env.PD_DOUBLE_HOST ?? '127.0.0.1';
const port = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} is not a port: ${raw}`);
  return n;
};

const bucket = process.env.S3_BUCKET || 'pd-local';
const oidc = await startMockOidc({
  host,
  port: port('PD_DOUBLE_OIDC_PORT', NATIVE_PORTS.oidc),
  ...(process.env.IDENTITY_ZITADEL_CLIENT_ID ? { clientId: process.env.IDENTITY_ZITADEL_CLIENT_ID } : {}),
});
const s3 = await startMockS3({ host, port: port('PD_DOUBLE_S3_PORT', NATIVE_PORTS.s3), buckets: [bucket] });
const clamd = await startMockClamd({ host, port: port('PD_DOUBLE_CLAMD_PORT', NATIVE_PORTS.clamd) });

// One line per double; native-stack.sh waits for the READY line.
console.log(`oidc ${oidc.url}`);
console.log(`s3 ${s3.url} bucket=${bucket}`);
console.log(`clamd ${clamd.host}:${clamd.port}`);
console.log('READY');

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.all([oidc.close(), s3.close(), clamd.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
