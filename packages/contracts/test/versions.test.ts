import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, makeEvent, validateEvent } from '../src/index';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NAME = 'render.done';
type Api = typeof import('../src/index');

// Copies live inside the package so node resolves its node_modules. The real files are never changed.
const copies: string[] = [];
afterAll(() => {
  for (const c of copies) rmSync(c, { recursive: true, force: true });
});

function copyContracts(): string {
  const dir = mkdtempSync(join(PACKAGE_ROOT, '.tmp-'));
  copies.push(dir);
  for (const part of ['events', 'src', 'services.json']) cpSync(join(PACKAGE_ROOT, part), join(dir, part), { recursive: true });
  return dir;
}

function readSchema(dir: string, file = `${NAME}.schema.json`): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'events', file), 'utf8')) as Record<string, unknown>;
}

function writeSchema(dir: string, file: string, doc: Record<string, unknown>): void {
  writeFileSync(join(dir, 'events', file), JSON.stringify(doc, null, 2) + '\n');
}

/** Move the copy's current version of render.done. Optionally keep the old schema as the .v<N> file. */
function setCurrent(dir: string, version: string, keepOldAs?: number): void {
  const doc = readSchema(dir);
  if (keepOldAs !== undefined) {
    writeSchema(dir, `${NAME}.v${keepOldAs}.schema.json`, { ...doc, $id: `${String(doc.$id)}.v${keepOldAs}` });
  }
  const major = version.split('.')[0];
  const props = doc.properties as Record<string, unknown>;
  doc['x-schema-version'] = version;
  props.schema_version = { type: 'string', pattern: `^${major}\\.\\d+$` };
  writeSchema(dir, `${NAME}.schema.json`, doc);
}

async function load(dir: string): Promise<Api> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'src', 'index.ts')).href)) as Api;
}

describe('validateEvent versions', () => {
  it('stamps the schema current version', () => {
    expect(makeEvent(NAME, TENANT, {}).schema_version).toBe('1.0');
  });

  it('rejects 2.0 and malformed versions today', () => {
    const good = makeEvent(NAME, TENANT, {});
    for (const v of ['2.0', '0.9', '1', 'v1', '1.0.0', '', 'x.y', 7, null]) {
      expect(validateEvent(NAME, { ...good, schema_version: v }).valid).toBe(false);
    }
    expect(validateEvent(NAME, { ...good, schema_version: '1.7' }).valid).toBe(true);
  });

  it('rejects a document that is not an object', () => {
    for (const v of [null, 'text', 3, []]) expect(validateEvent(NAME, v).valid).toBe(false);
  });

  it('rejects an unknown top-level property such as tenantId', () => {
    const good = makeEvent(NAME, TENANT, {});
    const r = validateEvent(NAME, { ...good, tenantId: TENANT });
    expect(r.valid).toBe(false);
    expect(validateEvent(NAME, { ...good, payload: { anything: 1 } }).valid).toBe(true);
  });

  it('still accepts a 1.0 event when the schema moves to 1.1', async () => {
    const dir = copyContracts();
    setCurrent(dir, '1.1');
    const api = await load(dir);
    const old = { ...makeEvent(NAME, TENANT, {}), schema_version: '1.0' };
    expect(api.validateEvent(NAME, old).valid).toBe(true);
    const fresh = api.makeEvent(NAME as never, TENANT, {});
    expect(fresh.schema_version).toBe('1.1');
    expect(api.validateEvent(NAME, fresh).valid).toBe(true);
    expect(api.validateEvent(NAME, { ...old, schema_version: '2.0' }).valid).toBe(false);
  });

  it('after a move to 2.0 accepts 1.x only when a v1 schema exists', async () => {
    const without = copyContracts();
    setCurrent(without, '2.0');
    const apiWithout = await load(without);
    const one = { ...makeEvent(NAME, TENANT, {}), schema_version: '1.3' };
    expect(apiWithout.validateEvent(NAME, one).valid).toBe(false);
    expect(apiWithout.validateEvent(NAME, apiWithout.makeEvent(NAME as never, TENANT, {})).valid).toBe(true);

    const withV1 = copyContracts();
    setCurrent(withV1, '2.0', 1);
    const api = await load(withV1);
    expect(api.validateEvent(NAME, one).valid).toBe(true);
    expect(api.validateEvent(NAME, { ...one, schema_version: '2.4' }).valid).toBe(true);
    expect(api.validateEvent(NAME, { ...one, schema_version: '3.0' }).valid).toBe(false);
    expect(api.validateEvent(NAME, { ...one, schema_version: '0.9' }).valid).toBe(false);
    expect(api.validateEvent(NAME, { ...one, tenant_id: 'nope' }).valid).toBe(false);
  });

  it('rejects majors outside the window even when a v1 file exists at 3.0', async () => {
    const dir = copyContracts();
    setCurrent(dir, '2.0', 1);
    setCurrent(dir, '3.0');
    const api = await load(dir);
    const one = { ...makeEvent(NAME, TENANT, {}), schema_version: '1.0' };
    expect(api.validateEvent(NAME, one).valid).toBe(false);
  });
});
