import { describe, expect, it } from 'vitest';
import { bidDto } from '@/test/fixtures';
import { planSave, settingsPatch, toCreditStatus, toSettingsValues } from './controller';

const values = toSettingsValues(bidDto());

describe('toSettingsValues', () => {
  it('maps the stored bid to the form', () => {
    expect(
      toSettingsValues(
        bidDto({
          startDate: '2026-10-01T00:00:00.000Z',
          dueTime: '14:00:00',
          retentionExtendedUntil: '2027-02-01T00:00:00.000Z',
          oralsEnabled: true,
        }),
      ),
    ).toEqual({
      name: 'VA EHR Support',
      agency: 'Department of Veterans Affairs',
      bidType: 'federal',
      solicitationNumber: '36C10B26R0001',
      startDate: '2026-10-01',
      dueDate: '2026-11-03',
      dueTime: '14:00',
      timeZone: 'America/New_York',
      oralsEnabled: true,
      keepFilesLiveUntil: '2027-02-01',
    });
  });

  it('maps nulls', () => {
    const v = toSettingsValues(bidDto({ agency: null, dueDate: null, dueTime: null, timeZone: null }));
    expect(v).toMatchObject({ agency: '', startDate: null, dueDate: null, dueTime: null, timeZone: '', keepFilesLiveUntil: null });
  });
});

describe('toCreditStatus', () => {
  it('keeps reserved and consumed, and shows nothing for released or none', () => {
    expect(toCreditStatus({ creditStatus: 'reserved' })).toBe('reserved');
    expect(toCreditStatus({ creditStatus: 'consumed' })).toBe('consumed');
    expect(toCreditStatus({ creditStatus: 'released' })).toBe('none');
    expect(toCreditStatus({ creditStatus: null })).toBe('none');
  });
});

describe('settingsPatch', () => {
  it('is empty when nothing changed', () => {
    expect(settingsPatch(values, { ...values }, true)).toEqual({});
  });

  it('sends only the changed fields, never the due date', () => {
    const after = { ...values, name: 'New name', oralsEnabled: true, dueTime: '15:30', dueDate: '2026-11-13', startDate: '2026-10-01' };
    expect(settingsPatch(values, after, true)).toEqual({ name: 'New name', oralsEnabled: true, dueTime: '15:30', startDate: '2026-10-01' });
  });

  it('clears an emptied agency', () => {
    expect(settingsPatch(values, { ...values, agency: '' }, true)).toEqual({ agency: null });
    expect(settingsPatch(values, { ...values, agency: 'GSA' }, true)).toEqual({ agency: 'GSA' });
  });

  it('sends the time zone only when changed to a zone', () => {
    expect(settingsPatch(values, { ...values, timeZone: 'America/Chicago' }, true)).toEqual({ timeZone: 'America/Chicago' });
    expect(settingsPatch(values, { ...values, timeZone: '' }, true)).toEqual({});
  });

  it('sends the live-until date only when the user may set it', () => {
    const after = { ...values, keepFilesLiveUntil: '2027-03-01' };
    expect(settingsPatch(values, after, true)).toEqual({ retentionExtendedUntil: '2027-03-01' });
    expect(settingsPatch(values, after, false)).toEqual({});
    expect(settingsPatch({ ...values, keepFilesLiveUntil: '2027-03-01' }, values, true)).toEqual({ retentionExtendedUntil: null });
  });
});

describe('planSave', () => {
  it('has no due change when the due date is the same', () => {
    expect(planSave(values, { ...values, name: 'X' }, true)).toEqual({ patch: { name: 'X' }, due: { kind: 'none' } });
  });

  it('writes a first or a cleared due date directly', () => {
    const none = { ...values, dueDate: null };
    expect(planSave(none, { ...none, dueDate: '2026-11-13' }, true).due).toEqual({ kind: 'direct', dueDate: '2026-11-13' });
    expect(planSave(values, { ...values, dueDate: null }, true).due).toEqual({ kind: 'direct', dueDate: null });
  });

  it('prompts when both dates are set and differ', () => {
    expect(planSave(values, { ...values, dueDate: '2026-11-13' }, true)).toEqual({
      patch: {},
      due: { kind: 'prompt', move: { previousDue: '2026-11-03', nextDue: '2026-11-13' } },
    });
  });
});
