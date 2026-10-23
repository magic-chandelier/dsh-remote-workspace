import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { root, inspectPackage } from './package-archive.mjs';
import { join } from 'node:path';
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const names=inspectPackage(root,[
  'lib/index.js','lib/server.cjs','README.md','README.zh-CN.md','LICENSE','LICENSE.zh-CN.md','docs/WIKI.zh-CN.md','THIRD-PARTY-NOTICES.md',
  'third_party/licenses/Apache-2.0.txt','third_party/licenses/basic-ftp-MIT.txt',
  'third_party/notices/basic-ftp-Apache-Commons-Net-NOTICE.txt',
], [/^docs\/(?!WIKI\.zh-CN\.md$)/,/^tests\//]);
assert.equal(manifest.dsh.client,undefined,'Safe package must not activate Web UI');
assert(!names.has('lib/client.js'),'Safe package must not bundle experimental Client');
console.log(`Safe package verified: ${names.size} files`);
