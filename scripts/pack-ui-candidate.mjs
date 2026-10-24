import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packArchive, listArchiveFiles } from './package-archive.mjs';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'dsh-rw-ui-'));
try {
  const compliance = spawnSync(process.execPath, [join(root, 'scripts/check-licenses.mjs'), '--source'], { cwd: root, stdio: 'inherit' });
  if (compliance.status !== 0) throw new Error('Source license check failed');
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Client build failed');

  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE', 'LICENSE.zh-CN.md', 'README.md', 'README.zh-CN.md', 'THIRD-PARTY-NOTICES.md']) {
    cpSync(join(root, file), join(work, file));
  }
  cpSync(join(root, 'lib'), join(work, 'lib'), { recursive: true });
  cpSync(join(root, 'third_party'), join(work, 'third_party'), { recursive: true });
  mkdirSync(join(work, 'docs'), { recursive: true });
  cpSync(join(root, 'docs', 'WIKI.zh-CN.md'), join(work, 'docs', 'WIKI.zh-CN.md'), { recursive: true, force: true });

  const filename = join(work, 'package.json');
  const manifest = JSON.parse(readFileSync(filename, 'utf8'));
  const base = manifest.version.split('-')[0];
  manifest.version = `${base}-ui.1`;
  manifest.description += ' — EXPERIMENTAL Web UI';
  manifest.exports = { ...(manifest.exports || {}), './client': './lib/client.js' };
  manifest.dsh = { ...(manifest.dsh || {}), client: { platform: 'web' } };
  manifest.files = Array.from(new Set([...(manifest.files || []), 'lib/client.js']));
  writeFileSync(filename, JSON.stringify(manifest, null, 2) + '\n');

  const packed = packArchive(work, root);
  const included=listArchiveFiles(packed);
  if (!included.has('lib/client.js') || !included.has('third_party/licenses/Apache-2.0.txt') || !included.has('LICENSE.zh-CN.md') || !included.has('docs/WIKI.zh-CN.md'))
    throw new Error('UI archive missing client or license attribution');
  console.log(`UI package ready: ${packed} (${included.size} files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
