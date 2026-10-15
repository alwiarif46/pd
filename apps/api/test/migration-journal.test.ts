/**
 * The migration chain is consistent: the journal is strictly increasing by idx and by when
 * (the migrator skips a migration whose `when` is not after the last one applied), every tag
 * names a .sql file on disk and every .sql file is in the journal, and each snapshot's prevId is
 * the previous snapshot's id (drizzle-kit refuses colliding snapshots).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const folder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/src/db/migrations');

interface Entry { idx: number; when: number; tag: string }

async function journal(): Promise<Entry[]> {
  return (JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf-8')) as { entries: Entry[] }).entries;
}

describe('migration journal and snapshots', () => {
  it('is strictly increasing by idx and by when', async () => {
    const entries = await journal();
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, index) => {
      expect(entry.idx, entry.tag).toBe(index);
      if (index > 0) {
        expect(entry.when, entry.tag).toBeGreaterThan(entries[index - 1].when);
      }
      expect(entry.tag.startsWith(String(index).padStart(4, '0')), entry.tag).toBe(true);
    });
  });

  it('names exactly the .sql files on disk', async () => {
    const files = (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort();
    expect((await journal()).map((entry) => `${entry.tag}.sql`)).toEqual(files);
  });

  it('chains each snapshot to the previous one', async () => {
    const entries = await journal();
    const snapshots = await Promise.all(entries.map(async (entry) => {
      const prefix = entry.tag.slice(0, 4);
      return JSON.parse(await readFile(join(folder, `meta/${prefix}_snapshot.json`), 'utf-8')) as { id: string; prevId: string };
    }));
    expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(snapshots.length);
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index].prevId, entries[index].tag).toBe(snapshots[index - 1].id);
    }
  });
});
