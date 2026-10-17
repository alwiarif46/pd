import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { checkContracts, checkServiceDrift, contractsRoot } from './check.js';

function copyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
  cpSync(join(contractsRoot, 'openapi'), join(dir, 'openapi'), {
    recursive: true,
  });
  cpSync(join(contractsRoot, 'events'), join(dir, 'events'), {
    recursive: true,
  });
  return dir;
}

describe('checkContracts', () => {
  it('passes on the checked-in contracts', () => {
    expect(checkContracts()).toEqual([]);
  });

  it('reports a service with no OpenAPI file', () => {
    const dir = copyRoot();
    writeFileSync(join(dir, 'openapi/billing.yaml'), '');
    expect(checkContracts(dir).map((p) => p.file)).toContain('openapi/billing.yaml');
  });

  it('rejects a misnamed event file', () => {
    const dir = copyRoot();
    writeFileSync(join(dir, 'events/bad-name.schema.json'), '{}');
    expect(checkContracts(dir)).toContainEqual({
      file: 'events/bad-name.schema.json',
      message: 'name must be <service>.<entity>.<verb>.schema.json',
    });
  });
});

describe('event schemas', () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const read = (n: string) => JSON.parse(readFileSync(join(contractsRoot, 'events', n), 'utf8'));
  ajv.addSchema(read('envelope.schema.json'));
  const validate = ajv.compile(read('identity.tenant.created.schema.json'));
  const event = {
    event_id: '7b0f3c1e-2a4d-4f6a-9d3e-1c2b3a4d5e6f',
    tenant_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    schema_version: 1,
    occurred_at: '2026-10-17T14:00:00Z',
    payload: { name: 'Acme' },
  };

  it('accepts a well-formed event', () => {
    expect(validate(event)).toBe(true);
  });

  it('rejects an event without tenant_id', () => {
    const { tenant_id: _omit, ...rest } = event;
    expect(validate(rest)).toBe(false);
  });
});

describe('checkServiceDrift', () => {
  it('passes when routes match the contract', () => {
    expect(checkServiceDrift('identity', ['GET /health'])).toEqual([]);
  });

  it('reports a route missing from the contract and one missing from the code', () => {
    expect(checkServiceDrift('identity', ['GET /tenants']).map((p) => p.message)).toEqual([
      'route GET /tenants is not in the contract',
      'contract route GET /health is not implemented',
    ]);
  });
});
