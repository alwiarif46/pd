import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '@pd/contracts';
import { SERVICE_PORTS, SERVICE_SCHEMAS, loadServiceConfig } from '../src/index';

describe('loadServiceConfig', () => {
  it('reads <ID>_DATABASE_URL, REDIS_URL and PORT', () => {
    const c = loadServiceConfig('modelgw', {
      MODELGW_DATABASE_URL: 'postgres://x/y',
      REDIS_URL: 'redis://r',
      PORT: '5000',
    });
    expect(c).toEqual({ id: 'modelgw', port: 5000, databaseUrl: 'postgres://x/y', redisUrl: 'redis://r' });
  });

  it('uses the default port and leaves unset values undefined', () => {
    const c = loadServiceConfig('identity', {});
    expect(c.port).toBe(4101);
    expect(c.databaseUrl).toBeUndefined();
    expect(c.redisUrl).toBeUndefined();
  });

  it('ignores another service\'s database url and rejects a bad PORT', () => {
    expect(loadServiceConfig('billing', { IDENTITY_DATABASE_URL: 'x' }).databaseUrl).toBeUndefined();
    expect(() => loadServiceConfig('billing', { PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadServiceConfig('nope', {})).toThrow(/No default port/);
  });
});

describe('port and schema tables', () => {
  it('give every service in services.json a distinct port: gateway 3001, the rest 4101 upward in file order', () => {
    const ids = SERVICES.map((s) => s.id);
    expect(Object.keys(SERVICE_PORTS)).toEqual(ids);
    expect(SERVICE_PORTS.gateway).toBe(3001);
    ids.filter((i) => i !== 'gateway').forEach((id, i) => expect(SERVICE_PORTS[id]).toBe(4101 + i));
  });

  it('matches the schemas in services.json', () => {
    for (const s of SERVICES) expect(SERVICE_SCHEMAS[s.id] ?? null).toBe(s.schema);
  });

  it('matches the ports in the Python skeletons and the .env.example files', () => {
    const root = join(__dirname, '..', '..', '..');
    for (const s of SERVICES.filter((x) => x.id !== 'gateway')) {
      const example = readFileSync(join(root, s.folder, '.env.example'), 'utf8');
      expect(example).toContain(`PORT=${SERVICE_PORTS[s.id]}\n`);
    }
  });
});
