import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOrgPath } from '@pd/core';

const dataDir = resolve('/data/files');
const orgId = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';

describe('resolveOrgPath', () => {
  it('resolves a path inside the organization folder', () => {
    expect(resolveOrgPath(dataDir, orgId, 'docs/a.pdf')).toBe(join(dataDir, orgId, 'docs', 'a.pdf'));
  });

  it('refuses paths that leave the organization folder', () => {
    expect(resolveOrgPath(dataDir, orgId, '../../etc/passwd')).toBeNull();
    expect(resolveOrgPath(dataDir, orgId, `../${otherOrg}/docs/a.pdf`)).toBeNull();
    expect(resolveOrgPath(dataDir, orgId, 'docs/../../x')).toBeNull();
    expect(resolveOrgPath(dataDir, orgId, resolve('/etc/passwd'))).toBeNull();
    expect(resolveOrgPath(dataDir, orgId, '')).toBeNull();
    expect(resolveOrgPath(dataDir, orgId, '.')).toBeNull();
    expect(resolveOrgPath(dataDir, 'not-a-uuid', 'docs/a.pdf')).toBeNull();
  });
});
