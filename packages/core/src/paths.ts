import { isAbsolute, relative, resolve } from 'node:path';
import { isUuid } from './db/tenant';

/**
 * The absolute path of `storedPath` inside the organization's folder `dataDir/orgId`, or
 * null when it would land outside that folder (`..`, an absolute path, another org's
 * folder) or names the folder itself. Use it for every path read from the database or a
 * job payload before opening the file.
 */
export function resolveOrgPath(dataDir: string, orgId: string, storedPath: string): string | null {
  if (!isUuid(orgId) || !storedPath) {
    return null;
  }
  const base = resolve(dataDir, orgId);
  const full = resolve(base, storedPath);
  const inside = relative(base, full);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    return null;
  }
  return full;
}
