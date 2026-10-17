import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANTS } from '../src/fixtures';
import { repoRoot } from '../src/paths';
import { listSampleRfpFiles, sampleDocumentId } from '../src/sample-rfp';

describe('sample RFP files', () => {
  const files = listSampleRfpFiles();
  const byName = (part: string) => files.filter((f) => f.relPath.includes(part));

  it('finds the repo root by pnpm-workspace.yaml', () => {
    expect(repoRoot()).toMatch(/[\\/]/);
    expect(listSampleRfpFiles(repoRoot())).toHaveLength(files.length);
  });

  it('lists the 10 files and not the README', () => {
    expect(files).toHaveLength(10);
    expect(files.some((f) => f.fileName === 'README.md')).toBe(false);
  });

  it('has one solicitation, with no amendment number', () => {
    const s = files.filter((f) => f.kind === 'solicitation');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ amendmentNo: null, mime: 'application/pdf' });
    expect(s[0]?.fileName).toContain('DFC ISSO');
  });

  it('has the original attachments 1 to 3 with no amendment number', () => {
    const originals = files.filter((f) => f.kind === 'attachment' && f.amendmentNo === null);
    expect(originals.map((f) => f.fileName.slice(0, 12))).toEqual(['Attachment 1', 'Attachment 2', 'Attachment 3']);
  });

  it('maps P0001 to amendment 1 and P00002 to amendment 2', () => {
    const amendments = files.filter((f) => f.kind === 'amendment').map((f) => [f.amendmentNo, f.fileName.match(/P0+\d+/)?.[0]] as const)
      .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
    expect(amendments).toEqual([
      [1, 'P0001'],
      [2, 'P00002'],
    ]);
  });

  it('files the revised attachments and the Q&A sheet as attachments of amendment 2', () => {
    const rides = byName('Amendments/0002/').filter((f) => f.kind === 'attachment');
    expect(rides).toHaveLength(4);
    expect(rides.every((f) => f.amendmentNo === 2)).toBe(true);
    expect(rides.map((f) => f.fileName.slice(0, 12))).toEqual(['Attachment 1', 'Attachment 2', 'Attachment 3', 'Attachment 4']);
    expect(rides.find((f) => f.fileName.startsWith('Attachment 4'))?.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('reports size, sha256 and mime that match the bytes', () => {
    for (const f of files) {
      const bytes = readFileSync(f.absPath);
      expect(f.sizeBytes).toBe(bytes.length);
      expect(f.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(f.mime).toMatch(/^application\//);
    }
  });

  it('gives each file a stable uuid per tenant', () => {
    const ids = files.map((f) => sampleDocumentId(TENANT_A.id, f.relPath));
    expect(new Set(ids).size).toBe(files.length);
    expect(ids).toEqual(files.map((f) => sampleDocumentId(TENANT_A.id, f.relPath)));
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
    expect(sampleDocumentId(TENANT_B.id, files[0]!.relPath)).not.toBe(ids[0]);
  });
});

describe('tenant fixtures', () => {
  it('use v4-shaped uuids that differ everywhere', () => {
    const ids = TENANTS.flatMap((t) => [t.id, t.admin.id, t.membershipId, t.bid.id]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('carry the names, emails and bids from the build plan', () => {
    expect([TENANT_A.name, TENANT_B.name]).toEqual(['Tenant A', 'Tenant B']);
    expect([TENANT_A.admin.email, TENANT_B.admin.email]).toEqual(['admin-a@example.test', 'admin-b@example.test']);
    expect(TENANT_A.bid).toMatchObject({ solicitationNumber: '77344426Q0100', name: 'DFC ISSO RFQ', bidType: 'federal' });
    expect(TENANT_B.bid).toMatchObject({ solicitationNumber: 'TENANT-B-0001', bidType: 'federal' });
  });
});
