import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const { Store, normalizeProfile } = require('../lib/store.cjs');
const { authOptions, getPinned } = require('../lib/remote.cjs');
const { TerminalManager } = require('../lib/terminal.cjs');
const { makeRoute } = require('../lib/server.cjs');
function tempDB() { const dir=mkdtempSync(join(tmpdir(),'drw4-')); return {dir,db:new Store(join(dir,'connections.json')),cleanup:()=>rmSync(dir,{recursive:true,force:true})}; }
const profile = (changes={})=>({id:'my-server',protocol:'ssh',host:'example.net',username:'tester',remoteRoot:'/home/tester',terminalEnabled:true,readOnly:true,...changes});
test('optional SHA-256 defaults to TOFU, ssh uses port 22, terminal is opt-in',()=>{
  const p=normalizeProfile(profile());
  assert.equal(p.hostTrustMode,'tofu');assert.equal(p.port,22);
  assert.equal(getPinned(p),null);
  assert.equal(normalizeProfile(profile({protocol:'sftp'})).terminalEnabled,false);
  assert.throws(()=>normalizeProfile(profile({hostTrustMode:'pinned'})),/requires host fingerprint/);
  assert.equal(normalizeProfile(profile({hostKeySha256:'a'.repeat(64),hostTrustMode:'pinned'})).hostTrustMode,'pinned');
  assert.equal(normalizeProfile(profile({hostTrustMode:'insecure'})).hostTrustMode,'insecure');
});
test('TOFU saves first host key, accepts same key, rejects mismatch after restart',()=>{
  const {dir,db,cleanup}=tempDB();
  try{
    db.upsert(profile());
    const opts=authOptions(db.profile('my-server'),db);
    assert.equal(opts.hostHash,'sha256');
    assert.equal(opts.hostVerifier('a'.repeat(64)),true);
    assert.equal(opts.hostVerifier('a'.repeat(64)),true);
    assert.equal(opts.hostVerifier('b'.repeat(64)),false);
    const raw=readFileSync(join(dir,'connections.json'),'utf8');
    assert(raw.includes('trustedHostKeys'));
    const restart=new Store(join(dir,'connections.json'));
    assert.equal(authOptions(restart.profile('my-server'),restart).hostVerifier('b'.repeat(64)),false);
    assert.equal(authOptions(restart.profile('my-server'),restart).hostVerifier('a'.repeat(64)),true);
    assert.equal(raw.includes('secretpassword'),false);
  }finally{cleanup();}
});
test('editing host/port invalidates TOFU; pinned mismatches and insecure is explicit',()=>{
  const {db,cleanup}=tempDB();
  try{
    db.upsert(profile());
    assert(authOptions(db.profile('my-server'),db).hostVerifier('1'.repeat(64)));
    db.upsert(profile({host:'new.example.net'}));
    assert.equal(db.trustedHostKeys.size,0);
    assert(authOptions(db.profile('my-server'),db).hostVerifier('2'.repeat(64)));
    db.upsert(profile({host:'new.example.net',hostTrustMode:'pinned',hostKeySha256:'3'.repeat(64)}));
    assert.equal(authOptions(db.profile('my-server'),db).hostVerifier('3'.repeat(64)),true);
    assert.equal(authOptions(db.profile('my-server'),db).hostVerifier('4'.repeat(64)),false);
    db.upsert(profile({hostTrustMode:'insecure'}));
    assert.equal(authOptions(db.profile('my-server'),db).hostVerifier('4'.repeat(64)),true);
  }finally{cleanup();}
});
class FakeShell extends EventEmitter {
  constructor(){super();this.stderr=new EventEmitter();this.writes=[];this.resizes=[];}
  write(value){this.writes.push(value);this.emit('data','echo:'+value);}
  setWindow(...args){this.resizes.push(args);}
  close(){this.emit('close',0);}
}
class FakeSsh extends EventEmitter {
  static shells=[];
  connect(opts){this.options=opts;queueMicrotask(()=>this.emit('ready'));}
  shell(opts,callback){const shell=new FakeShell();FakeSsh.shells.push(shell);callback(null,shell);}
  end(){this.ended=true;this.emit('close');}
}
test('SSH PTY opens only when explicit opt-in; send/poll/resize/close; no auto command replay',async()=>{
  const {db,cleanup}=tempDB();const terminal=new TerminalManager(db,{Client:FakeSsh});
  try{
    db.upsert(profile({terminalEnabled:false}));
    await assert.rejects(terminal.open('my-server'),/disabled/);
    db.upsert(profile());
    const x=await terminal.open('my-server');
    assert.equal(x.connected,true);
    const sent=terminal.send(x.sessionId,'pwd\r');assert.equal(sent.sent,4);
    assert.match(terminal.poll(x.sessionId).output,/echo:pwd/);
    assert.equal(terminal.poll(x.sessionId).output,'');
    assert.deepEqual(terminal.resize(x.sessionId,88,28),{cols:88,rows:28});
    assert.equal(FakeSsh.shells.at(-1).resizes.at(-1)[0],28);
    terminal.close(x.sessionId);
    assert.throws(()=>terminal.send(x.sessionId,'anything'),/expired|not found/);
    await assert.rejects(terminal.open('not-exist'),/Unknown profile/);
  }finally{terminal.closeAll();cleanup();}
});
test('terminal input limit, readOnly does not imply shell safety, max active sessions',async()=>{
  const {db,cleanup}=tempDB();const terminal=new TerminalManager(db,{Client:FakeSsh});
  try {
    db.upsert(profile({terminalEnabled:true,readOnly:true}));
    const items=[];
    for(let i=0;i<4;i++)items.push(await terminal.open('my-server'));
    await assert.rejects(terminal.open('my-server'),/Maximum 4/);
    assert.throws(()=>terminal.send(items[0].sessionId,'x'.repeat(9000)),/exceeds/);
    assert.equal(db.profile('my-server').readOnly,true);
  }finally{terminal.closeAll();cleanup();}
});
test('authenticated API routes expose opt-in terminal actions and reject invalid sessions',async()=>{
  const {db,cleanup}=tempDB();const terminal=new TerminalManager(db,{Client:FakeSsh});
  try{
    db.upsert(profile());
    const route=makeRoute({store:db,remote:{},terminal,localRoot:'/tmp'});
    const ask=async(body)=>{
      const req=new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      return route.fetch(req);
    };
    const created=(await (await ask({action:'terminal_open',id:'my-server'})).json()).data;
    assert.equal(created.profile,'my-server');
    assert.equal((await (await ask({action:'terminal_send',sessionId:created.sessionId,input:'ls\r'})).json()).ok,true);
    assert.equal((await (await ask({action:'terminal_poll',sessionId:created.sessionId})).json()).data.output,'echo:ls\r');
    assert.equal((await (await ask({action:'terminal_close',sessionId:created.sessionId})).json()).ok,true);
    const missing=await ask({action:'terminal_send',sessionId:created.sessionId,input:'oops'});
    assert.equal(missing.status,400);
  }finally{terminal.closeAll();cleanup();}
});
test('improper host trust mode and invalid port are rejected before connection',()=>{
  assert.throws(()=>normalizeProfile(profile({hostTrustMode:'bogus'})),/Invalid SSH host trust mode/);
  assert.throws(()=>normalizeProfile(profile({port:70000})),/Invalid TCP port/);
});
test('a previously trusted SSH key may only be cleared by explicit reset action', async()=>{
  const {db,cleanup}=tempDB();const terminal=new TerminalManager(db,{Client:FakeSsh});
  try{
    db.upsert(profile());
    assert(authOptions(db.profile('my-server'),db).hostVerifier('c'.repeat(64)));
    assert.equal(authOptions(db.profile('my-server'),db).hostVerifier('d'.repeat(64)),false);
    const route=makeRoute({store:db,remote:{},terminal,localRoot:'/tmp'});
    const req=new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',body:JSON.stringify({action:'forget_host_key',id:'my-server'})});
    const out=await (await route.fetch(req)).json();
    assert.equal(out.data.forgotten,true);
    assert.equal(db.trustedHostKeys.size,0);
    assert(authOptions(db.profile('my-server'),db).hostVerifier('d'.repeat(64)));
  }finally{terminal.closeAll();cleanup();}
});
