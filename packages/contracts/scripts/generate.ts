import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from '../src/index';
import { buildGenerated } from './lib';

const files = await buildGenerated();
rmSync(join(PACKAGE_ROOT, 'generated'), { recursive: true, force: true });
for (const [rel, text] of files) {
  const path = join(PACKAGE_ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
console.log(`generated ${files.size} files`);
