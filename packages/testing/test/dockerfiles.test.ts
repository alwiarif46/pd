import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '@pd/contracts';
import { SERVICE_PORTS } from '@pd/service-kit';
import { REPO_ROOT } from '@pd/service-kit/migrate';

/** The 14 skeleton images (12 TypeScript, 2 Python). The gateway keeps PD's port 3001. */
const skeletons = SERVICES.filter((s) => s.skeleton);

function dockerfile(folder: string): string {
  const path = join(REPO_ROOT, folder, 'Dockerfile');
  expect(existsSync(path), `${path} exists`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('service Dockerfiles', () => {
  it('cover the 14 skeleton services', () => {
    expect(skeletons).toHaveLength(14);
  });

  for (const svc of skeletons) {
    it(`${svc.id}: real port in EXPOSE, ENV PORT and HEALTHCHECK, probing /healthz`, () => {
      const port = SERVICE_PORTS[svc.id];
      expect(port, 'port in SERVICE_PORTS').toBeGreaterThan(4100);
      const text = dockerfile(svc.folder);
      expect(text).toMatch(new RegExp(`^EXPOSE ${port}$`, 'm'));
      expect(text).toMatch(new RegExp(`^ENV PORT=${port}$`, 'm'));
      const health = text.split('\n').find((l) => l.startsWith('HEALTHCHECK')) ?? '';
      expect(health).toContain(`127.0.0.1:${port}/healthz`);
      expect(health).toContain('exit 1');
    });
  }
});
