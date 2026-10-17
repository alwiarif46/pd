import { describe, expect, it } from 'vitest';
import { SERVICES, acceptsSchemaVersion, eventNames, loadEventSchema, makeEvent, parseVersion, supportedMajorsFor, validateEvent } from '../src/index';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const BID = '44444444-4444-4444-8444-444444444444';
const AUDIT = { action: 'confirm_marking', target_type: 'document', target_id: ID };

// Events whose payload is tightened. Every other event still takes any object.
const TIGHT: Record<string, Record<string, unknown>> = {
  'ingest.document.classified': { document_id: ID, bid_id: BID, kind: 'amendment', amendment_no: 2 },
  'ingest.document.deleted': { document_id: ID, bid_id: BID, kind: 'attachment', reason: 'user' },
  'intel.bid.deleted': { bid_id: BID },
  'identity.audit.recorded': AUDIT,
  'ingest.audit.recorded': AUDIT,
  'intel.audit.recorded': AUDIT,
};

describe('event schemas', () => {
  it('has 58 events and 15 services', () => {
    expect(eventNames).toHaveLength(58);
    expect(SERVICES).toHaveLength(15);
  });

  it.each(eventNames)('%s accepts makeEvent output', (name) => {
    const result = validateEvent(name, makeEvent(name, TENANT, TIGHT[name] ?? { any: 'thing' }));
    expect(result.valid).toBe(true);
  });

  it.each(Object.keys(TIGHT))('%s rejects a payload missing its required fields', (name) => {
    expect(validateEvent(name as never, makeEvent(name as never, TENANT, {})).valid).toBe(false);
  });

  it('ingest.document.classified rejects an amendment_no outside 1 to 999', () => {
    const bad = makeEvent('ingest.document.classified', TENANT, { ...TIGHT['ingest.document.classified'], amendment_no: 1000 });
    expect(validateEvent('ingest.document.classified', bad).valid).toBe(false);
  });

  it.each(eventNames)('%s rejects a missing tenant_id, a wrong type and a bad schema_version', (name) => {
    const good = makeEvent(name, TENANT, {});
    const { tenant_id: _t, ...noTenant } = good;
    expect(validateEvent(name, noTenant).valid).toBe(false);
    expect(validateEvent(name, { ...good, type: 'not.this.event' }).valid).toBe(false);
    expect(validateEvent(name, { ...good, schema_version: 'v1' }).valid).toBe(false);
    expect(validateEvent(name, { ...good, schema_version: '2.0' }).valid).toBe(false);
    expect(validateEvent(name, { ...good, tenant_id: 'not-a-uuid' }).valid).toBe(false);
    expect(validateEvent(name, { ...good, payload: 'text' }).valid).toBe(false);
  });

  it('loadEventSchema rejects unknown names and path tricks', () => {
    expect(() => loadEventSchema('nope.nothing')).toThrow(/Unknown event/);
    expect(() => loadEventSchema('../services')).toThrow(/Unknown event/);
  });

  it('makeEvent honors options', () => {
    const e = makeEvent('render.done', TENANT, {}, { eventId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-10-17T00:00:00.000Z' });
    expect(e.event_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(e.occurred_at).toBe('2026-10-17T00:00:00.000Z');
    expect(e.schema_version).toBe('1.0');
  });
});

describe('versions', () => {
  it('parses versions', () => {
    expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2 });
    expect(parseVersion('3.0.1')).toEqual({ major: 3, minor: 0 });
    expect(() => parseVersion('x')).toThrow();
  });

  it('accepts the current and the previous major only', () => {
    const majors = supportedMajorsFor('3.1');
    expect(majors).toEqual([3, 2]);
    expect(acceptsSchemaVersion('3.4', majors)).toBe(true);
    expect(acceptsSchemaVersion('2.9', majors)).toBe(true);
    expect(acceptsSchemaVersion('1.0', majors)).toBe(false);
    expect(acceptsSchemaVersion('4.0', majors)).toBe(false);
    expect(acceptsSchemaVersion('garbage', majors)).toBe(false);
  });

  it('at major 1 only major 1 is accepted', () => {
    expect(supportedMajorsFor('1.0')).toEqual([1]);
    expect(acceptsSchemaVersion('0.9', [1])).toBe(false);
  });
});
