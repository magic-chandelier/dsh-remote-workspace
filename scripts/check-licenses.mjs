import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectPackage } from './package-archive.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceOnly = process.argv.includes('--source');
const installed = process.argv.includes('--installed');
if (sourceOnly === installed) throw new Error('Choose exactly one of --source or --installed');
const file = name=>join(root,name);
const read = name=>readFileSync(file(name),'utf8');
const failures = [];
const fail = message=>failures.push(message);
function checkSource() {
  const required = [
    'LICENSE','LICENSE.zh-CN.md','docs/WIKI.zh-CN.md','THIRD-PARTY-NOTICES.md','third_party/licenses/Apache-2.0.txt',
    'third_party/licenses/basic-ftp-MIT.txt',
    'third_party/notices/basic-ftp-Apache-Commons-Net-NOTICE.txt',
  ];
  for (const name of required) if (!existsSync(file(name))) fail(`Missing attribution: ${name}`);
  if (existsSync(file('LICENSE'))) {
    const license = read('LICENSE').replace(/\s+/g,' ');
    for (const phrase of ['DeepSeek Remote Workspace Personal Research License 1.1','All rights reserved.','organizational','non-commercial','No warranty'])
      if (!license.toLowerCase().includes(phrase.toLowerCase())) fail(`Project license incomplete: ${phrase}`);
  }
  if (existsSync(file(required[4])) && !read(required[4]).includes('END OF TERMS AND CONDITIONS')) fail('Apache-2.0 license incomplete');
  if (existsSync(file(required[6])) && !read(required[6]).includes('Apache Commons Net')) fail('Missing source-specific Apache NOTICE');
  if (JSON.parse(read('package.json')).license !== 'SEE LICENSE IN LICENSE') fail('Project license field must point to root LICENSE');
  try { inspectPackage(root, required, [/^docs\/(?!WIKI\.zh-CN\.md$)/,/^tests\//]); }
  catch (e) { fail(`Release archive inspection failed: ${e.message}`); }
}
checkSource();

const accepted = new Set(['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','0BSD','Unlicense','CC0-1.0']);
export function permittedSpdx(expr) {
  if (typeof expr !== 'string' || !expr.trim() || /\bWITH\b|SEE LICENSE|LicenseRef|https?:/i.test(expr)) return false;
  const tokens = expr.match(/[A-Za-z0-9.+-]+|[()]/g) || [];
  if (tokens.join('') !== expr.replace(/\s+/g,'')) return false;
  let index=0;
  const atom=()=>{
    if (tokens[index]==='(') {
      index++;
      if (!expression() || tokens[index]!==')') return false;
      index++;return true;
    }
    if (accepted.has(tokens[index])) {index++;return true;}
    return false;
  };
  const expression=()=>{
    if (!atom()) return false;
    while (tokens[index]==='AND' || tokens[index]==='OR') {
      index++;
      if (!atom()) return false;
    }
    return true;
  };
  return expression() && index===tokens.length;
}
function inspectDependency(path, name) {
  try {
    const meta = JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
    const entries = readdirSync(path);
    const hasLicenseText = entries.some(n=>/^(LICEN[CS]E|COPYING|UNLICENSE)(\..*)?$/i.test(n) && statSync(join(path,n)).isFile());
    if (installedPnpmLock && !installedPnpmLock.includes(`${meta.name}@${meta.version}`))
      fail(`Installed version not found in pnpm-lock.yaml: ${meta.name}@${meta.version}`);
    const info={name:meta.name,version:meta.version,path:name,license:meta.license??null,licenseFile:hasLicenseText};
    reviewed.push(info);
    if (!permittedSpdx(meta.license)) fail(`Manual license review required: ${meta.name}@${meta.version} (${String(meta.license)})`);
    if (!hasLicenseText) fail(`Missing full upstream license copy: ${meta.name}@${meta.version}`);
  } catch (e) { fail(`Cannot inspect installed dependency ${name}: ${e.message}`); }
}
const reviewed=[];
let installedPnpmLock = null;
if (installed) {
  const hasPnpm=existsSync(file('pnpm-lock.yaml'));
  const hasNpm=existsSync(file('package-lock.json'));
  if (hasPnpm && hasNpm) fail('Two lockfiles present: retain only the actual package manager lockfile');
  if (!hasPnpm && !hasNpm) fail('No pnpm-lock.yaml or package-lock.json: generate and commit a lockfile before release');
  if (!existsSync(file('node_modules'))) fail('No node_modules: run pnpm install --frozen-lockfile --ignore-scripts before installed audit');
  if (hasPnpm && !hasNpm && existsSync(file('node_modules'))) {
    const lock=read('pnpm-lock.yaml');
    installedPnpmLock=lock;
    if (!/^lockfileVersion:/m.test(lock) || !/^packages:/m.test(lock)) fail('Invalid or unsupported pnpm lockfile');
    const store=file('node_modules/.pnpm');
    if (!existsSync(store)) fail('pnpm virtual store missing; dependency tree cannot be audited');
    else {
      const seen=new Set();
      for (const storeEntry of readdirSync(store,{withFileTypes:true})) {
        if (!storeEntry.isDirectory()) continue;
        const nested=join(store,storeEntry.name,'node_modules');
        if (!existsSync(nested)) continue;
        for (const n of readdirSync(nested)) {
          if (n.startsWith('@')) {
            for (const child of readdirSync(join(nested,n))) {
              const name=`${n}/${child}`, dep=join(nested,name);
              if (existsSync(join(dep,'package.json'))) {
                const meta=JSON.parse(readFileSync(join(dep,'package.json'),'utf8'));
                const key=`${meta.name}@${meta.version}`;
                if (!seen.has(key)) {seen.add(key);inspectDependency(dep,name);}
              }
            }
          } else {
            const dep=join(nested,n);
            if (!existsSync(join(dep,'package.json'))) continue;
            const meta=JSON.parse(readFileSync(join(dep,'package.json'),'utf8'));
            const key=`${meta.name}@${meta.version}`;
            if (!seen.has(key)) {seen.add(key);inspectDependency(dep,n);}
          }
        }
      }
    }
    const pkg=JSON.parse(read('package.json'));
    for (const dep of Object.keys(pkg.dependencies||{}))
      if (!existsSync(file(`node_modules/${dep}/package.json`))) fail(`Declared runtime dependency missing: ${dep}`);
  }
  if (hasNpm && !hasPnpm && existsSync(file('node_modules'))) {
    const lock=JSON.parse(read('package-lock.json'));
    if (!lock.packages || typeof lock.packages !== 'object') fail('Invalid npm lockfile');
    else for (const [name,entry] of Object.entries(lock.packages)) {
      if (!name || !name.includes('node_modules/')) continue;
      const dep=file(name);
      if (!existsSync(dep)) {if (!entry.optional) fail(`Nonoptional package absent: ${name}`);continue;}
      inspectDependency(dep,name);
    }
  }
  if (!reviewed.length) fail('Installed dependency tree is empty');
}
const report={mode:sourceOnly?'source-only':'installed-dependency-tree',checkedAt:new Date().toISOString(),
  project:JSON.parse(read('package.json')).version,dependenciesInspected:reviewed.length,
  verified:failures.length===0,limitations:[
    'SPDX metadata alone does not prove code provenance or embedded third-party attribution',
    'Optional and platform-specific dependencies not installed on this platform are not scanned',
    'Host-provided peer dependencies can differ from the locally reviewed versions',
    'Run pnpm install --frozen-lockfile before installed audit to verify dependency resolution',
  ],failures,dependencies:reviewed};
if (installed) {
  mkdirSync(file('license-reports'),{recursive:true});
  writeFileSync(file('license-reports/dependency-license-audit.json'),JSON.stringify(report,null,2)+'\n');
}
if (failures.length) {
  for (const message of failures) console.error('LICENSE CHECK FAILED:',message);
  process.exitCode=1;
} else console.log(`License ${report.mode} check OK; inspected ${reviewed.length} installed packages${sourceOnly?' (NOT a full dependency audit)':''}.`);
