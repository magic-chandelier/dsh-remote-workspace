import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('root Personal Research License reserves rights and preserves third-party licenses', () => {
  const text = read('LICENSE');
  assert.match(text,/Personal Research License 1\.1/);
  assert.match(text,/All rights reserved/);
  assert.match(text,/organizational use/i);
  assert.match(text,/internal evaluation/i);
  assert.match(text,/NO WARRANTY|WITHOUT WARRANTIES/i);
  assert.match(text,/third.party/i);
  assert.equal(JSON.parse(read('package.json')).license, 'SEE LICENSE IN LICENSE');
});

test('third-party notices retain Apache Commons Net attribution and complete Apache license', () => {
  assert.match(read('third_party/notices/basic-ftp-Apache-Commons-Net-NOTICE.txt'),/Copyright 2001-2019 The Apache Software Foundation/);
  assert.match(read('third_party/licenses/Apache-2.0.txt'),/END OF TERMS AND CONDITIONS/);
  assert.match(read('THIRD-PARTY-NOTICES.md'),/BSD-3-Clause/);
});

test('source-only compliance passes while full dependency audit remains separate', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/check-licenses.mjs', root)), '--source'],{cwd:root,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/NOT a full dependency audit/);
});


function withPnpmFixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),'dsh-license-pnpm-test-'));
  const project=join(dir,'project');mkdirSync(project);
  for (const name of ['package.json','LICENSE','LICENSE.zh-CN.md','THIRD-PARTY-NOTICES.md','README.md','cordis.patch.yml'])
    cpSync(new URL(name,root),join(project,name));
  for (const name of ['lib','third_party','scripts','docs'])
    cpSync(new URL(name+'/',root),join(project,name),{recursive:true});
  const pkg=JSON.parse(readFileSync(join(project,'package.json'),'utf8'));
  const versions=[];
  for (const depName of Object.keys(pkg.dependencies)) {
    const version='1.0.0'; versions.push(`${depName}@${version}`);
    const pnpmPath=join(project,'node_modules','.pnpm',depName.replace(/[@\/]/g,'+')+'@'+version,'node_modules',depName);
    mkdirSync(pnpmPath,{recursive:true});
    const meta={name:depName,version,license:'MIT'};
    writeFileSync(join(pnpmPath,'package.json'),JSON.stringify(meta));
    writeFileSync(join(pnpmPath,'LICENSE'),'MIT License\nPermission is hereby granted');
    const direct=join(project,'node_modules',depName);
    mkdirSync(direct,{recursive:true});writeFileSync(join(direct,'package.json'),JSON.stringify(meta));
  }
  writeFileSync(join(project,'pnpm-lock.yaml'),"lockfileVersion: '9.0'\npackages:\n"+versions.map(v=>`  '${v}':\n    resolution: {}\n`).join(''));
  const run=()=>spawnSync(process.execPath,[join(project,'scripts','check-licenses.mjs'),'--installed'],{cwd:project,encoding:'utf8'});
  try { return fn({project,run}); } finally { rmSync(dir,{recursive:true,force:true}); }
}
// Test lockfile absence in an isolated fixture, not in the real project checkout.
// CI legitimately commits pnpm-lock.yaml and installs node_modules before running tests.
test('full installed dependency license gate fails closed without reviewed lockfile',()=>withPnpmFixture(({project,run})=>{
  rmSync(join(project,'pnpm-lock.yaml'));
  const result=run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/No pnpm-lock\.yaml or package-lock\.json/);
}));

test('full installed dependency license gate fails closed without node_modules',()=>withPnpmFixture(({project,run})=>{
  rmSync(join(project,'node_modules'),{recursive:true,force:true});
  const result=run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/No node_modules/);
}));

test('pnpm virtual store and committed lockfile can pass the full license gate',()=>withPnpmFixture(({project,run})=>{
  const result=run();
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(readFileSync(join(project,'license-reports','dependency-license-audit.json'),'utf8'));
  assert.equal(report.verified,true);
  assert.equal(report.dependenciesInspected,4);
}));
test('pnpm full gate rejects copyleft and missing license text',()=>withPnpmFixture(({project,run})=>{
  const dep=join(project,'node_modules','.pnpm','basic-ftp@1.0.0','node_modules','basic-ftp');
  const pkg=JSON.parse(readFileSync(join(dep,'package.json'),'utf8'));
  pkg.license='GPL-3.0-only';writeFileSync(join(dep,'package.json'),JSON.stringify(pkg));
  rmSync(join(dep,'LICENSE'));
  const result=run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Manual license review required/);
  assert.match(result.stderr,/Missing full upstream license copy/);
}));
test('pnpm installed tree fails when versions do not match committed lockfile',()=>withPnpmFixture(({project,run})=>{
  const lock=join(project,'pnpm-lock.yaml');
  writeFileSync(lock,readFileSync(lock,'utf8').replace('basic-ftp@1.0.0','basic-ftp@0.0.0'));
  const result=run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Installed version not found in pnpm-lock/);
}));

test('all operational documentation resolves to one Wiki, without stale legacy references', () => {
  assert.deepEqual(readdirSync(new URL('docs/',root)),['WIKI.zh-CN.md']);
  for (const name of ['README.md','README.zh-CN.md','THIRD-PARTY-NOTICES.md','SECURITY.md']) {
    const text=read(name);
    assert.doesNotMatch(text,/docs\/(?:INSTALL|ARCHITECTURE|RELEASING|MONITORING|LIFECYCLE|AI-CONNECTION|OPEN-SOURCE-RELEASE)/);
  }
});
