// release/ledgerly-source.zip: the repository without node_modules, builds, coverage or DB files.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'release', '.git']);
const SKIP_FILE = /\.(db|db-wal|db-shm|db-journal)$|^\.env$/;
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
    } else if (!SKIP_FILE.test(name)) {
      files[`ledgerly-api/${relative(root, full).split(sep).join('/')}`] = readFileSync(full);
    }
  }
})(root);
mkdirSync('release', { recursive: true });
const zip = zipSync(files, { level: 9 });
writeFileSync('release/ledgerly-source.zip', zip);
console.log(
  `release/ledgerly-source.zip  ${Object.keys(files).length} files, ${(zip.length / 1024).toFixed(1)} KB`,
);
