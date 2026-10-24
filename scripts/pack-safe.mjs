import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, packArchive, listArchiveFiles } from './package-archive.mjs';

for (const args of [
  ['scripts/check-licenses.mjs', '--source'],
  ['scripts/build.mjs'],
  ['scripts/verify-package.mjs'],
]) {
  const proc = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (proc.status !== 0) process.exit(proc.status || 1);
}

const work = mkdtempSync(join(tmpdir(), 'dsh-rw-safe-'));
try {
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'LICENSE.zh-CN.md', 'README.md', 'README.zh-CN.md', 'THIRD-PARTY-NOTICES.md']) {
    cpSync(join(root, file), join(work, file));
  }
  cpSync(join(root, 'lib'), join(work, 'lib'), { recursive: true });
  cpSync(join(root, 'third_party'), join(work, 'third_party'), { recursive: true });
  cpSync(join(root, 'docs'), join(work, 'docs'), { recursive: true });
  unlinkSync(join(work, 'lib', 'client.js'));

  const manifestPath = join(work, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.exports) delete manifest.exports['./client'];
  if (manifest.dsh) delete manifest.dsh.client;
  manifest.files = (manifest.files || []).filter(item => item !== 'lib/client.js');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const safeCheck = spawnSync(process.execPath, ['scripts/verify-package.mjs', '--target=safe', `--dir=${work}`], { cwd: root, stdio: 'inherit' });
  if (safeCheck.status !== 0) process.exit(safeCheck.status || 1);

  const path = packArchive(work, root);
  const files = listArchiveFiles(path);
  if (files.has('lib/client.js')) throw new Error('Safe package leaked Web client');
  console.log(`Host package ready: ${path} (${files.size} files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
