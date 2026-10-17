import { describe, expect, it } from 'vitest';
import { type EventName, SERVICES, acceptsSchemaVersion, eventNames, loadEventSchema, makeEvent, parseVersion, supportedMajorsFor, validateEvent } from '../src/index';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UUID = '33333333-3333-4333-8333-333333333333';

/** Events whose payload the contract pins need a valid sample; the rest take any object. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  'render.done': { render_id: UUID, run_id: UUID, volume_id: 'v1', page_count: 12, within_limit: true, pdf_key: 'a.pdf', docx_key: 'a.docx', issue_count: 0, vision_checked: true },
  'render.issue.found': { render_id: UUID, run_id: UUID, volume_id: 'v1', page: 3, kind: 'cut_graphic', severity: 'blocker', detail: 'Table runs past the margin.', source: 'geometry' },
  'render.package.ready': { package_id: UUID, run_id: UUID, file_count: 2 },
};
const sample = (name: string): Record<string, unknown> => SAMPLES[name] ?? { any: 'thing' };

describe('event schemas', () => {
  it('has 53 events and 15 services', () => {
    expect(eventNames).toHaveLength(53);
    expect(SERVICES).toHaveLength(15);
  });

  it.each(eventNames)('%s accepts makeEvent output', (name) => {
    const result = validateEvent(name, makeEvent(name, TENANT, sample(name)));
    expect(result.valid).toBe(true);
  });

  it.each(eventNames)('%s rejects a missing tenant_id, a wrong type and a bad schema_version', (name) => {
    const good = makeEvent(name, TENANT, sample(name));
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
    const e = makeEvent('orchestrator.run.started', TENANT, {}, { eventId: '22222222-2222-4222-8222-222222222222', occurredAt: '2026-10-17T00:00:00.000Z' });
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

const FULL: Record<string, Record<string, unknown>> = {
  'render.done': { ...SAMPLES['render.done'], page_limit: 30, round: 2, word_only: true },
  'render.issue.found': { ...SAMPLES['render.issue.found'], block_id: 'b-7' },
  'render.package.ready': { ...SAMPLES['render.package.ready'], word_only_note: 'Check the page limit in Word.' },
};
const NULLS: Record<string, Record<string, unknown>> = {
  'render.done': { ...SAMPLES['render.done'], page_limit: null },
  'render.issue.found': { ...SAMPLES['render.issue.found'], block_id: null },
  'render.package.ready': { ...SAMPLES['render.package.ready'], word_only_note: null },
};

describe('render event payloads', () => {
  it.each(Object.keys(SAMPLES) as EventName[])('%s accepts every optional field, and nulls where allowed', (name) => {
    expect(validateEvent(name, makeEvent(name, TENANT, FULL[name]!)).valid).toBe(true);
    expect(validateEvent(name, makeEvent(name, TENANT, NULLS[name]!)).valid).toBe(true);
  });

  it.each(Object.keys(SAMPLES) as EventName[])('%s rejects each missing required field and a bad uuid', (name) => {
    for (const key of Object.keys(SAMPLES[name]!)) {
      const { [key]: _gone, ...rest } = SAMPLES[name]!;
      expect(validateEvent(name, makeEvent(name, TENANT, rest)).valid, `${name} without ${key}`).toBe(false);
    }
    const idKey = name === 'render.package.ready' ? 'package_id' : 'render_id';
    expect(validateEvent(name, makeEvent(name, TENANT, { ...SAMPLES[name]!, [idKey]: 'not-a-uuid' })).valid).toBe(false);
  });

  const bad: Record<string, Record<string, unknown>> = {
    'render.done': { ...SAMPLES['render.done'], page_count: -1 },
    'render.issue.found': { ...SAMPLES['render.issue.found'], kind: 'smudge' },
    'render.package.ready': { ...SAMPLES['render.package.ready'], file_count: 0 },
  };
  it.each(Object.keys(SAMPLES) as EventName[])('%s rejects an empty, an extra-field and an out-of-range payload', (name) => {
    expect(validateEvent(name, makeEvent(name, TENANT, {})).valid).toBe(false);
    expect(validateEvent(name, makeEvent(name, TENANT, { ...SAMPLES[name]!, extra: 1 })).valid).toBe(false);
    expect(validateEvent(name, makeEvent(name, TENANT, bad[name]!)).valid).toBe(false);
  });
});
