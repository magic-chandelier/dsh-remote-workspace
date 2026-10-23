import { spawnSync } from 'node:child_process';
import { root, packArchive, listArchiveFiles } from './package-archive.mjs';
import { join } from 'node:path';
for (const args of [
  ['scripts/check-licenses.mjs','--source'],['scripts/build.mjs'],['scripts/verify-package.mjs']]) {
  const proc=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if (proc.status!==0) process.exit(proc.status||1);
}
const path=packArchive(root,root);
const files=listArchiveFiles(path);
if (files.has('lib/client.js')) throw new Error('Safe package leaked Web client');
console.log(`Host package ready: ${path} (${files.size} files)`);
