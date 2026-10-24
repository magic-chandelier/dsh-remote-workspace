import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { inspectPackage, root as repoRoot } from './package-archive.mjs';

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'ui' },
    dir: { type: 'string' },
  },
});
const root = values.dir ? resolve(values.dir) : repoRoot;
const target = values.target;
if (!['ui', 'safe'].includes(target)) throw new Error(`Unknown --target ${target}`);

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = [
  'lib/index.js',
  'lib/server.cjs',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'LICENSE.zh-CN.md',
  'docs/WIKI.zh-CN.md',
  'THIRD-PARTY-NOTICES.md',
  'third_party/licenses/Apache-2.0.txt',
  'third_party/licenses/basic-ftp-MIT.txt',
  'third_party/notices/basic-ftp-Apache-Commons-Net-NOTICE.txt',
];
const names = inspectPackage(root, target === 'ui' ? [...required, 'lib/client.js'] : required, [
  /^docs\/(?!WIKI\.zh-CN\.md$)/,
  /^tests\//,
]);

assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'Host patch metadata must remain');
if (target === 'ui') {
  assert.equal(manifest.exports['./client'], './lib/client.js', 'UI package must export client entry');
  assert.deepEqual(manifest.dsh.client, { platform: 'web' }, 'UI package must declare web client metadata');
  assert(names.has('lib/client.js'), 'UI package must include lib/client.js');
  verifyClientArtifact(join(root, 'lib/client.js'));
  console.log(`UI package verified: ${names.size} files`);
} else {
  assert.equal(manifest.dsh.client, undefined, 'Safe package must not activate Web UI');
  assert.equal(manifest.exports['./client'], undefined, 'Safe package must not export Web client');
  assert(!names.has('lib/client.js'), 'Safe package must not bundle Web client');
  console.log(`Safe package verified: ${names.size} files`);
}

function verifyClientArtifact(filename) {
  const code = readFileSync(filename, 'utf8');
  assert(code.startsWith('window.__ModuleLoader__.load('), 'Client must use ModuleLoader wrapper');
  const entries = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [init, () => {}],
    useEffect: () => {},
    useRef: init => ({ current: init }),
    useCallback: fn => fn,
  };
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load: entry => entries.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 599, json: async () => ({}) }),
  });
  assert.equal(entries.length, 1, 'Client bundle must register one ModuleLoader entry');
  const plugin = entries[0];
  assert.equal(plugin.id, 'dsh-remote-workspace', 'Client bundle id mismatch');
  const mod = plugin.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  assert.deepEqual(Array.from(mod.inject), ['slots']);
  const injectCalls = [];
  const registrations = [];
  mod.apply({
    slots: {
      inject: (name, register) => {
        injectCalls.push(name);
        return register();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  });
  assert.deepEqual(injectCalls, ['sidebar.panellist', 'main']);
  assert.equal(registrations[0].options.id, 'remote-workspace');
  assert.equal(registrations[0].options.label, '远程工作区');
  assert.equal(registrations[1].options.key, 'remote-workspace');
  const rendered = registrations[1].component({});
  assert.equal(rendered.type, 'div');
  assert.equal(rendered.props.className, 'dr3-root');
}
