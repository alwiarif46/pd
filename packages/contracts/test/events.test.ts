import { describe, expect, it } from 'vitest';
import { SERVICES, acceptsSchemaVersion, eventNames, loadEventSchema, makeEvent, parseVersion, supportedMajorsFor, validateEvent } from '../src/index';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('event schemas', () => {
  it('has 53 events and 15 services', () => {
    expect(eventNames).toHaveLength(53);
    expect(SERVICES).toHaveLength(15);
  });

  it.each(eventNames)('%s accepts makeEvent output', (name) => {
    const result = validateEvent(name, makeEvent(name, TENANT, { any: 'thing' }));
    expect(result.valid).toBe(true);
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
