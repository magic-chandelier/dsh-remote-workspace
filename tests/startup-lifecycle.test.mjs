import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { createService } = require('../lib/server.cjs');

class FakeSSH extends EventEmitter {
  connect() { queueMicrotask(() => this.emit('ready')); }
  shell(_options, callback) {
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close', 0);
    callback(null, channel);
  }
  end() { this.emit('close'); }
}

test('Host startup creates no terminal sweep timer; it runs only while sessions exist', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = createService({}, { filename: join(dir, 'connections.json') });
  assert.equal(service.terminal.timer, null);
  service.terminal.Client = FakeSSH;
  service.store.upsert({
    id: 'dev', host: 'example.test', port: 22, username: 'deploy',
    protocol: 'ssh', terminalEnabled: true, remoteRoot: '/srv',
  });
  try {
    const session = await service.terminal.open('dev');
    assert.notEqual(service.terminal.timer, null);
    service.terminal.close(session.sessionId);
    assert.equal(service.terminal.timer, null);
  } finally { service.terminal.closeAll(); }
});

test('initial Client mount fetches local profile metadata, not SSH browse', async () => {
  const javascript = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const calls = [], effects = [];
  const React = {
    Fragment: Symbol('fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [init, () => {}],
    useEffect: fn => effects.push(fn),
    useRef: init => ({ current: init }),
    useCallback: fn => fn,
  };
  const browser = { __ModuleLoader__: { load: entry => { browser.entry = entry; } } };
  runInNewContext(javascript, {
    window: browser, console,
    fetch: async (_path, request) => {
      const action = JSON.parse(request.body).action;
      calls.push(action);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        active: 'dev', profiles: [{ id: 'dev', remoteRoot: '/srv', workspace: '/srv', host: 'example.test', username: 'deploy' }],
        dataDir: '/fake/profile', dataLocationReason: 'profile-local',
      } }) };
    },
  });
  const plugin = browser.entry.factory(() => React);
  let panel;
  plugin.apply({ slots: {
    inject: (_name, cb) => cb(),
    register: (options, component) => { if (options.name === 'main') panel = component; return () => {}; },
  } });
  panel({});
  for (const effect of effects) effect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['list']);
});

test('Host status reports package version without a separate stale constant', async () => {
  const manifest = require('../package.json');
  const server = readFileSync(new URL('../lib/server.cjs', import.meta.url), 'utf8');
  assert.match(server, /require\('\.\.\/package\.json'\)\.version/);
  assert.equal(manifest.version.split('-')[0], '0.5.26');
});
