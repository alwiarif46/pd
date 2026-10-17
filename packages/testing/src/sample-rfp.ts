import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { repoRoot } from './paths.js';

export const SAMPLE_RFP_SOLICITATION = '77344426Q0100';
export const SAMPLE_RFP_FOLDER = 'evals/fixtures/sample-rfp-77344426Q0100';

export type SampleFileKind = 'solicitation' | 'attachment' | 'amendment';

export interface SampleRfpFile {
  /** Path inside the sample folder, with forward slashes. */
  relPath: string;
  fileName: string;
  absPath: string;
  kind: SampleFileKind;
  /** 1 for P0001, 2 for P00002 and its revised attachments and Q&A sheet. Null for the original package. */
  amendmentNo: number | null;
  sizeBytes: number;
  sha256: string;
  mime: string;
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function sampleRfpDir(root: string = repoRoot()): string {
  return join(root, SAMPLE_RFP_FOLDER);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** An amendment document is named like `... P0001 ...` or `... P00002 ...`. */
const AMENDMENT_NAME = /\bP0*(\d+)\b/;

function classify(parts: string[]): { kind: SampleFileKind; amendmentNo: number | null } {
  const name = parts[parts.length - 1] as string;
  if (parts[0] !== 'Amendments') {
    return { kind: /^\d+Q\d+\s*-/.test(name) ? 'solicitation' : 'attachment', amendmentNo: null };
  }
  // Amendments/<file> or Amendments/<number>/<file>. The folder number wins for the files inside it.
  const folder = parts.length > 2 ? /^0*(\d+)$/.exec(parts[1] as string) : null;
  const fromName = AMENDMENT_NAME.exec(name);
  const amendmentNo = folder ? Number(folder[1]) : fromName ? Number(fromName[1]) : null;
  if (amendmentNo === null) throw new Error(`Cannot tell which amendment ${parts.join('/')} belongs to`);
  // The amendment itself is the file named P000n. Revised attachments and the Q&A sheet ride along as attachments.
  return { kind: fromName ? 'amendment' : 'attachment', amendmentNo };
}

/** The files of the sample RFP, sorted by path. The README is not part of the solicitation. */
export function listSampleRfpFiles(root: string = repoRoot()): SampleRfpFile[] {
  const dir = sampleRfpDir(root);
  if (!existsSync(dir)) throw new Error(`Sample RFP folder not found: ${dir}`);
  return walk(dir)
    .map((absPath) => ({ absPath, relPath: relative(dir, absPath).split(sep).join('/') }))
    .filter((f) => f.relPath !== 'README.md')
    .sort((x, y) => (x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0))
    .map(({ absPath, relPath }) => {
      const parts = relPath.split('/');
      const mime = MIME[extname(relPath).toLowerCase()];
      if (!mime) throw new Error(`No mime type for ${relPath}`);
      return {
        relPath,
        fileName: parts[parts.length - 1] as string,
        absPath,
        ...classify(parts),
        sizeBytes: statSync(absPath).size,
        sha256: createHash('sha256').update(readFileSync(absPath)).digest('hex'),
        mime,
      };
    });
}

/**
 * A stable uuid for a sample file, from its path. The seed uses it as the document id, so a
 * second run updates the same rows. Shaped like a version 4 uuid.
 */
export function sampleDocumentId(tenantId: string, relPath: string): string {
  const h = createHash('sha256').update(`pd-testing:document:${tenantId}:${relPath}`).digest('hex');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
