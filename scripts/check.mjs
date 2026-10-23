import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const entries = [
  ...readdirSync(join(root, 'lib')).filter(name => /\.(cjs|js)$/.test(name)).map(name => `lib/${name}`),
  ...readdirSync(join(root, 'src')).filter(name => /\.(cjs|js)$/.test(name)).map(name => `src/${name}`),
  ...readdirSync(join(root, 'scripts')).filter(name => name.endsWith('.mjs')).map(name => `scripts/${name}`),
];
for (const file of entries) {
  const checked = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(1);
}
console.log(`Syntax OK: ${entries.length} files`);
