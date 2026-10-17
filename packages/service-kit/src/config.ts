/**
 * Per-service configuration read from the environment (09 s9.2).
 *
 * Default ports: the gateway keeps PD's 3001. The other 14 services take 4101 to 4114 in
 * packages/contracts/services.json order (gateway excluded). A PORT variable overrides the default.
 */
export const SERVICE_PORTS: Readonly<Record<string, number>> = {
  gateway: 3001,
  identity: 4101,
  billing: 4102,
  ingest: 4103,
  intel: 4104,
  orchestrator: 4105,
  modelgw: 4106,
  drafting: 4107,
  review: 4108,
  render: 4109,
  evidence: 4110,
  comms: 4111,
  portal: 4112,
  drive: 4113,
  notify: 4114,
};

export interface ServiceConfig {
  id: string;
  port: number;
  /** Value of `<ID>_DATABASE_URL`, or undefined when unset or empty. */
  databaseUrl: string | undefined;
  /** Value of `REDIS_URL`, or undefined when unset or empty. */
  redisUrl: string | undefined;
}

/** `modelgw` -> `MODELGW`. */
export function envPrefix(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function databaseUrlVar(id: string): string {
  return `${envPrefix(id)}_DATABASE_URL`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function loadServiceConfig(id: string, env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const defaultPort = SERVICE_PORTS[id];
  const rawPort = nonEmpty(env.PORT);
  let port: number;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`PORT must be an integer from 0 to 65535, got ${JSON.stringify(rawPort)}`);
    }
  } else if (defaultPort !== undefined) {
    port = defaultPort;
  } else {
    throw new Error(`No default port for service "${id}": set PORT or add it to SERVICE_PORTS`);
  }
  return {
    id,
    port,
    databaseUrl: nonEmpty(env[databaseUrlVar(id)]),
    redisUrl: nonEmpty(env.REDIS_URL),
  };
}
