import { describe, expect, it } from 'vitest';
import { SERVICES, acceptsSchemaVersion, eventNames, loadEventSchema, makeEvent, parseVersion, supportedMajorsFor, validateEvent } from '../src/index';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';

// Events whose payload is tight need a valid sample. All others take any object.
const SAMPLES: Record<string, Record<string, unknown>> = {
  'render.done': { render_id: ID, run_id: ID, volume_id: 'v1', page_count: 3, within_limit: true, pdf_key: 'k.pdf', docx_key: 'k.docx', issue_count: 0, vision_checked: true },
  'render.issue.found': { issue_id: ID, render_id: ID, run_id: ID, volume_id: 'v1', page: 1, kind: 'overflow', severity: 'blocker', detail: 'text past margin', source: 'geometry' },
  'render.package.ready': { package_id: ID, run_id: ID, file_count: 2 },
};

describe('event schemas', () => {
  it('has 53 events and 15 services', () => {
    expect(eventNames).toHaveLength(53);
    expect(SERVICES).toHaveLength(15);
  });

  it.each(eventNames)('%s accepts makeEvent output', (name) => {
    const result = validateEvent(name, makeEvent(name, TENANT, SAMPLES[name] ?? { any: 'thing' }));
    expect(result.valid).toBe(true);
  });

  it.each(eventNames)('%s rejects a missing tenant_id, a wrong type and a bad schema_version', (name) => {
    const good = makeEvent(name, TENANT, SAMPLES[name] ?? {});
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

  it.each(Object.keys(SAMPLES))('%s rejects an empty payload and an unknown payload field', (name) => {
    expect(validateEvent(name, makeEvent(name as never, TENANT, {})).valid).toBe(false);
    expect(validateEvent(name, makeEvent(name as never, TENANT, { ...SAMPLES[name], extra: 1 })).valid).toBe(false);
  });

  const BAD: Array<[string, Record<string, unknown>]> = [
    ['render.issue.found', { kind: 'colour' }],
    ['render.issue.found', { severity: 'fatal' }],
    ['render.issue.found', { source: 'guess' }],
    ['render.issue.found', { page: 0 }],
    ['render.issue.found', { issue_id: 'nope' }],
    ['render.done', { render_id: 'nope' }],
    ['render.package.ready', { file_count: 0 }],
  ];
  it.each(BAD)('%s rejects %j', (name, patch) => {
    const doc = makeEvent(name as never, TENANT, { ...SAMPLES[name], ...patch });
    expect(validateEvent(name, doc).valid).toBe(false);
  });

  it('render.done accepts a null page_limit and word_only', () => {
    const doc = makeEvent('render.done', TENANT, { ...SAMPLES['render.done'], page_limit: null, word_only: true });
    expect(validateEvent('render.done', doc).valid).toBe(true);
  });

  it('makeEvent honors options', () => {
    const e = makeEvent('notification.created', TENANT, {}, { eventId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-10-17T00:00:00.000Z' });
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
