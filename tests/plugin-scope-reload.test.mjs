import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createService, makeRoute, toolsFor } = require('../lib/server.cjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rw-lifecycle-'));
  const service = createService({}, { filename: join(dir, 'connections.json') });
  service.store.upsert({ id:'prod', host:'example.test', username:'deploy', port:22,
    protocol:'ssh', terminalEnabled:true, remoteRoot:'/srv/project' });
  return { service, cleanup:() => rmSync(dir,{recursive:true,force:true}) };
}

class PendingClient extends EventEmitter {
  static clients = [];
  connect() { PendingClient.clients.push(this); }
  end() { this.ended = true; this.emit('close'); }
}

async function status(route) {
  return route.fetch(new Request('http://localhost/api/dsh-remote-workspace', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({action:'status'}),
  }));
}

test('unloading one plugin closes only its terminals and disables its API, not other plugin instances', async () => {
  const a = fixture(), b = fixture();
  try {
    const routeA = makeRoute(a.service), routeB = makeRoute(b.service);
    assert.equal((await status(routeA)).status, 200);
    assert.equal((await status(routeB)).status, 200);
    a.service.store.sessionPasswords.set('prod','session-password');
    a.service.dispose();
    a.service.dispose();
    assert.equal(a.service.store.sessionPasswords.size,0);
    assert.equal(a.service.stopped, true);
    assert.equal(a.service.terminal.stopped, true);
    assert.equal(a.service.terminal.timer, null);
    assert.equal((await status(routeA)).status, 503);
    await assert.rejects(toolsFor(a.service).find(x=>x.name==='remote_profiles').execute(), /stopped/);
    assert.equal((await status(routeB)).status, 200);
    assert.equal(b.service.stopped, false);
    assert.equal(b.service.store.profile('prod').host, 'example.test');
  } finally { a.cleanup(); b.cleanup(); }
});

test('pending SSH handshake is cancelled on plugin dispose, without leaving sockets or sweeper', async () => {
  const f = fixture();
  try {
    f.service.terminal.Client = PendingClient;
    const opening = f.service.terminal.open('prod');
    for (let i=0; i<8 && !PendingClient.clients.length; i++) await Promise.resolve();
    assert.equal(PendingClient.clients.length > 0, true);
    f.service.dispose();
    await assert.rejects(opening, /stopped/);
    assert.equal(PendingClient.clients.at(-1).ended, true);
    assert.equal(f.service.terminal.sessions.size, 0);
    assert.equal(f.service.terminal.pending.size, 0);
    assert.equal(f.service.terminal.timer, null);
    await assert.rejects(f.service.terminal.open('prod'), /stopped/);
  } finally { f.cleanup(); }
});

test('SSH authorization cannot be granted after plugin unload during verification', async () => {
  const f = fixture();
  try {
    f.service.store.upsert({ id:'prod', host:'example.test', username:'deploy', port:22,
      protocol:'ssh', remoteRoot:'/srv/project', rememberMode:'obfuscate', password:'test-password' });
    f.service.questions={ask:async()=>({ answers:[{id:'rw-connect-approval',selected:['允许连接']}] })};
    let resolveRemote;
    f.service.remote.test=()=>new Promise(resolve=>{resolveRemote=resolve;});
    const exec={agent:{session:{id:'sess-1'}},signal:new AbortController().signal};
    const pending=f.service.connectionGate.ensure('prod',exec);
    for(let i=0;i<20 && !resolveRemote;i++) await Promise.resolve();
    assert.equal(typeof resolveRemote,'function');
    f.service.dispose();
    resolveRemote({connected:true});
    await assert.rejects(pending,/stopped/);
  } finally { f.cleanup(); }
});
