// Which local stack a run uses (BUILD-PLAN s3 and s8). `compose` is the real stack from infra/compose/local.yml;
// `native` is infra/local/native-stack.sh with the test doubles. Production code never reads E2E_STACK.
export type StackMode = 'compose' | 'native';

export function stackMode(env: NodeJS.ProcessEnv = process.env): StackMode {
  const v = (env.E2E_STACK ?? 'compose').trim().toLowerCase();
  if (v === 'compose' || v === 'native') return v;
  throw new Error(`E2E_STACK must be "compose" or "native", got "${env.E2E_STACK}"`);
}

/** Default ports of the native doubles. They match the real services so the same URLs work in both modes. */
export const NATIVE_PORTS = { oidc: 8080, s3: 8333, clamd: 3310, redis: 6379, postgres: 54329 } as const;
