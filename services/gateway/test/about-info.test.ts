import { describe, expect, it } from 'vitest';
import { activeModel } from '@pd/ai';
import { BASE_SUBPROCESSORS, processingInfo } from '../src/about.js';

const BASE = [...BASE_SUBPROCESSORS];

describe('processingInfo', () => {
  it('lists exactly the base subprocessors when nothing is configured', () => {
    expect(processingInfo({}).subprocessors).toEqual(['DeepInfra', 'Anthropic', 'Telnyx', 'Stripe']);
  });

  it('reports the provider, the model in use and the privacy path', () => {
    const info = processingInfo({});
    expect(info.provider).toBe('deepinfra');
    expect(info.model).toBe(activeModel());
    expect(info.privacyPath).toBe('/#/privacy');
    expect(processingInfo({ AI_PROVIDER: 'anthropic' }).provider).toBe('anthropic');
  });

  it('puts the hosting provider first and the backup target last', () => {
    const list = processingInfo({
      PD_HOSTING_SUBPROCESSOR: 'Hetzner Online GmbH (hosting)',
      PD_BACKUP_SUBPROCESSOR: 'Backblaze, Inc. (encrypted off-site backups)',
    }).subprocessors;
    expect(list).toEqual(['Hetzner Online GmbH (hosting)', ...BASE, 'Backblaze, Inc. (encrypted off-site backups)']);
  });

  it('shows only the entries that are set', () => {
    expect(processingInfo({ PD_HOSTING_SUBPROCESSOR: 'Contabo GmbH' }).subprocessors).toEqual(['Contabo GmbH', ...BASE]);
    expect(processingInfo({ PD_BACKUP_SUBPROCESSOR: 'Backblaze, Inc.' }).subprocessors).toEqual([...BASE, 'Backblaze, Inc.']);
  });

  it('trims, drops empty values and de-duplicates', () => {
    const list = processingInfo({ PD_HOSTING_SUBPROCESSOR: '   ', PD_BACKUP_SUBPROCESSOR: '  Stripe  ' }).subprocessors;
    expect(list).toEqual(BASE);
    expect(processingInfo({ PD_HOSTING_SUBPROCESSOR: '  X Co  ', PD_BACKUP_SUBPROCESSOR: 'X Co' }).subprocessors).toEqual(['X Co', ...BASE]);
  });

  it('strips control characters', () => {
    const list = processingInfo({ PD_HOSTING_SUBPROCESSOR: 'Evil\u0000Host\r\n\u001b[31m Inc\u007f' }).subprocessors;
    expect(list[0]).toBe('EvilHost[31m Inc');
    // eslint-disable-next-line no-control-regex
    expect(list.join('')).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('caps a name at 120 characters', () => {
    const list = processingInfo({ PD_HOSTING_SUBPROCESSOR: 'a'.repeat(500) }).subprocessors;
    expect(list[0]).toHaveLength(120);
  });
});
