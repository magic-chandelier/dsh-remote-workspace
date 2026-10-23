import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { RemoteManager, localPath } = require('../lib/remote.cjs');
const { TransferSessions } = require('../lib/transfer-sessions.cjs');
const { Store } = require('../lib/store.cjs');
const profile = (extra = {}) => ({
  id:'q',protocol:'sftp',host:'host.example',port:22,username:'user',remoteRoot:'/remote',
  readOnly:false,hostTrustMode:'pinned',hostKeySha256:'a'.repeat(64),execAllowlist:['uptime'], ...extra,
});
const fakeStore = p => ({profile:id => {assert.equal(id,'q');return p;}, workspace:()=>p.remoteRoot, sessionPasswords:new Map()});
const temp = () => mkdtempSync(join(tmpdir(),'dsh-final-'));
const deferred = () => {let resolve;let reject;const promise = new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('remote rename refuses overwriting an existing remote file', async () => {
  const p=profile(); const calls=[];
  const client={realPath:async target=>target,exists:async()=>true,rename:async()=>calls.push('rename')};
  const remote=new RemoteManager(fakeStore(p),{connect:async(_p,_s,fn)=>fn({kind:'sftp',client})});
  await assert.rejects(remote.rename('q','old.txt','new.txt'),/already exists/);
  assert.deepEqual(calls,[]);
});

test('local transfer rejects symlink source and symlink root', t => {
  const base=temp();
  try {
    writeFileSync(join(base,'actual'),'keep');
    try { symlinkSync(join(base,'actual'),join(base,'link')); }
    catch (e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) {t.skip('symlink creation restricted');return;} throw e; }
    assert.throws(()=>localPath(base,'link'),/symbolic link/);
    const alias=base+'-alias'; try { symlinkSync(base,alias,'dir'); }
    catch (e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) {t.skip('directory symlink restricted');return;} throw e; }
    try {assert.throws(()=>localPath(alias,'actual'),/symbolic link/);} finally {rmSync(alias,{force:true});}
  } finally {rmSync(base,{recursive:true,force:true});}
});

test('exec rejects malformed or disallowed commands before dialing', async () => {
  const p=profile({execAllowlist:['uptime','uptime\nrm -rf /']});
  const remote=new RemoteManager(fakeStore(p));
  await assert.rejects(remote.exec('q','uptime\nrm -rf /'),/safe execAllowlist/);
  await assert.rejects(remote.exec('q','cat secrets'),/safe execAllowlist/);
});

class FakeClient extends EventEmitter {
  static latest;
  constructor(){super();FakeClient.latest=this;this.ended=0;}
  connect(){setImmediate(()=>this.emit('ready'));}
  exec(_cmd,cb){
    this.channel=new EventEmitter(); this.channel.stderr=new EventEmitter();
    this.channel.close=()=>{this.channel.closed=true;};
    cb(null,this.channel);
  }
  end(){this.ended++;}
}

test('SSH command timeout terminates channel and client', async () => {
  const remote=new RemoteManager(fakeStore(profile()));
  await assert.rejects(remote.exec('q','uptime',{timeoutMs:25,clientFactory:FakeClient}),/timed out/);
  assert.equal(FakeClient.latest.ended,1);
  assert.equal(FakeClient.latest.channel.closed,true);
});

test('SSH command abort terminates channel and client', async () => {
  const controller=new AbortController();const remote=new RemoteManager(fakeStore(profile()));
  const pending=remote.exec('q','uptime',{timeoutMs:500,signal:controller.signal,clientFactory:FakeClient});
  await new Promise(resolve=>setTimeout(resolve,5));controller.abort();
  await assert.rejects(pending,/canceled/);
  assert.equal(FakeClient.latest.ended,1);
});

test('SSH output limit aborts oversized command output instead of retaining it', async () => {
  const remote=new RemoteManager(fakeStore(profile()));
  const pending=remote.exec('q','uptime',{timeoutMs:500,clientFactory:FakeClient});
  await new Promise(resolve=>setTimeout(resolve,5));
  FakeClient.latest.channel.emit('data',Buffer.alloc(120000,0x61));
  await assert.rejects(pending,/output exceeds/);
  assert.equal(FakeClient.latest.ended,1);
});

test('concurrent finish and append are refused; staging cleaned after finish', async () => {
  const dir=temp();const d=deferred();let uploads=0;
  const p=profile();const remote={context:()=>({p,base:'/remote'}),uploadStaged:()=>{uploads++;return d.promise;}};
  const t=new TransferSessions(remote,dir);
  try {
    const {token}=t.beginUpload('q','a.txt',3);
    t.appendUpload('q',token,0,Buffer.from('abc').toString('base64'));
    const pending=t.finishUpload('q',token);
    await assert.rejects(t.finishUpload('q',token),/already finishing/);
    assert.throws(()=>t.appendUpload('q',token,1,Buffer.from('d').toString('base64')),/finishing/);
    d.resolve({uploaded:'/remote/a.txt'});await pending;
    assert.equal(uploads,1);
    assert.equal(readdirSync(join(dir,'transfer-cache')).length,0);
  } finally {t.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('cancel during active download preserves open staging until IO finishes, then deletes it', async () => {
  const dir=temp();const d=deferred();const p=profile();let outputFile;
  const remote={context:()=>({p,base:'/remote'}),downloadStaged:(_id,_path,file)=>{outputFile=file;writeFileSync(file,'hi');return d.promise;}};
  const t=new TransferSessions(remote,dir);
  try {
    const pending=t.beginDownload('q','a.txt');
    const token=[...t.sessions.keys()][0];
    assert.ok(existsSync(outputFile));
    assert.equal(t.cancel('q',token).pending,true);
    assert.equal(existsSync(outputFile),true);
    d.resolve(2);
    await assert.rejects(pending,/canceled/);
    assert.equal(existsSync(outputFile),false);
    assert.equal(t.sessions.size,0);
  }finally{t.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('forgetting a trusted host key invalidates connection revision', () => {
  const dir=temp();
  try {
    const store=new Store(join(dir,'connections.json'));
    store.upsert(profile({hostTrustMode:'tofu',hostKeySha256:'',readOnly:true}));
    store.rememberHostKey('q','b'.repeat(64));
    const previous=store.revision('q');
    store.forgetHostKey('q');
    assert.equal(store.revision('q'),previous+1);
    assert.equal(store.trustedHostKeys.has('q'),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('broken local symlinks are rejected before network transfer', t => {
  const dir=temp();
  try {
    try { symlinkSync(join(dir,'missing-outside'),join(dir,'broken')); }
    catch (e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) {t.skip('symlink creation restricted');return;} throw e; }
    assert.throws(()=>localPath(dir,'broken'),/symbolic link/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('FTP local download streams chunks to a private file and refuses oversized result', async () => {
  const dir=temp();
  try {
    const p=profile({protocol:'ftp'});
    const remote=new RemoteManager(fakeStore(p),{
      localRoot:dir,connect:async(_p,_store,fn)=>fn({kind:'ftp',client:{
        downloadTo:async (sink)=>{
          await new Promise((resolve,reject)=>{
            sink.write(Buffer.alloc(128*1024,0x7f), error => error ? reject(error):resolve());
          });
        },
      }}),
    });
    await remote.transfer('q','sample.bin','sample.bin','download');
    assert.equal(readFileSync(join(dir,'sample.bin')).length,128*1024);
    await assert.rejects(remote.transfer('q','sample.bin','sample.bin','download'),/already exists/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('malformed credential vault does not crash startup and original bytes are preserved', () => {
  const dir=temp();
  try {
    const file=join(dir,'credentials.json');const original='{broken-json';
    writeFileSync(file,original);
    const store=new Store(join(dir,'connections.json'));
    assert.match(store.vault.loadError,/preserved/);
    assert.deepEqual(store.list(),[]);
    assert.throws(()=>store.vault.remember('q',profile(),'secret','obfuscate'),/preserved/);
    assert.equal(readFileSync(file,'utf8'),original);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
