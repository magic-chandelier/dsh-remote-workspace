import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

export const root = resolve(import.meta.dirname, '..');
export function archiveFilename(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return `${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}.tgz`;
}
export function packArchive(dir, destination) {
  const expected = archiveFilename(dir);
  const candidates = [
    ['pnpm', ['pack', '--ignore-scripts'], true],
    ['npm', ['pack', '--pack-destination', destination, '--ignore-scripts', '--silent'], false],
  ];
  let last = '';
  for (const [command, args, archiveInCwd] of candidates) {
    const result = spawnSync(command, args, {cwd:dir, encoding:'utf8',
      shell:process.platform==='win32',
      env:{...process.env,npm_config_ignore_scripts:'true'}});
    if (result.error?.code === 'ENOENT' || result.status === 127 || result.status === 9009) {
      last = `${command} unavailable`;
      continue;
    }
    if (result.status !== 0) {
      last = `${command} pack failed: ${result.error?.message || result.stderr || result.stdout}`;
      // Do not silently use another package manager if the installed one has failed.
      throw new Error(last);
    }
    if (archiveInCwd && readdirSync(dir).includes(expected))
      renameSync(join(dir, expected), join(destination, expected));
    const archive = join(destination, expected);
    if (!readdirSync(destination).includes(expected))
      throw new Error(`${command} succeeded but ${expected} was not created`);
    return archive;
  }
  throw new Error(`Neither pnpm nor npm is available (${last}); install one to pack the plugin`);
}
export function listArchiveFiles(archive) {
  const buffer = gunzipSync(readFileSync(archive));
  const files = new Set();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset+512);
    if (header.every(b=>b===0)) break;
    const str = (start,length)=>header.toString('utf8',start,start+length).replace(/\0.*$/s,'');
    const name = str(0,100), prefix = str(345,155);
    const length = Number.parseInt(str(124,12).trim() || '0',8);
    if (!name || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid tar header');
    const entry = (prefix ? `${prefix}/` : '') + name;
    if (!entry.startsWith('package/') || entry.includes('\\') || entry.split('/').includes('..'))
      throw new Error(`Unsafe package entry: ${entry}`);
    if (str(156,1) !== '5') files.add(entry.slice('package/'.length));
    offset += 512 + Math.ceil(length/512)*512;
  }
  if (files.size === 0) throw new Error('Empty package archive');
  return files;
}
export function inspectPackage(dir, required, forbidden = []) {
  const temp = mkdtempSync(join(tmpdir(),'dsh-package-inspect-'));
  try {
    const names = listArchiveFiles(packArchive(dir,temp));
    for (const filename of required) if (!names.has(filename)) throw new Error(`Missing archive file: ${filename}`);
    for (const name of names) {
      if (name.startsWith('node_modules/') || /credentials\.json|connections\.json|audit\.jsonl|\.pem$/i.test(name))
        throw new Error(`Unsafe archive file: ${name}`);
      if (forbidden.some(pattern=>pattern.test(name))) throw new Error(`Unexpected archive file: ${name}`);
    }
    return names;
  } finally { rmSync(temp,{recursive:true,force:true}); }
}
