import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { Store } = require('../lib/store.cjs');
const { authOptions } = require('../lib/remote.cjs');
const { CredentialVault } = require('../lib/credential-vault.cjs');
const { virtualRoot, virtualIdForCwd, VirtualWorkspaceManager } = require('../lib/virtual-workspace.cjs');
const sample = (id='server-a', extra={})=>({id,protocol:'ssh',host:id+'.test',username:'deployer',remoteRoot:'/srv/app',terminalEnabled:true,...extra});
const temp = () => { const dir=mkdtempSync(join(tmpdir(),'dsh-credentials-'));return {dir,file:join(dir,'connections.json'),end:()=>rmSync(dir,{force:true,recursive:true})}; };

test('session-only password disappears after restart, reproducing former terminal authentication failure',()=>{
 const t=temp();try {
  const db=new Store(t.file);db.upsert({...sample(),password:'login-pass'});
  assert.equal(db.passwordFor('server-a'),'login-pass');
  assert.equal(new Store(t.file).passwordFor('server-a'),'');
  assert(!readFileSync(t.file,'utf8').includes('login-pass'));
 } finally {t.end();}
});
test('reversible obfuscation remembers password per server across restart, does not leak plaintext into profile',()=>{
 const t=temp();try {
  const db=new Store(t.file);
  db.upsert({...sample('alpha'),password:'my-secret-1',rememberMode:'obfuscate'});
  db.upsert({...sample('beta'),password:'my-secret-2',rememberMode:'obfuscate'});
  assert.equal(db.list().length,2);
  assert(!JSON.stringify(db.list()).includes('my-secret'));
  assert(!readFileSync(t.file,'utf8').includes('my-secret'));
  assert(!readFileSync(join(t.dir,'credentials.json'),'utf8').includes('my-secret'));
  const resumed=new Store(t.file);
  assert.equal(resumed.passwordFor('alpha'),'my-secret-1');
  assert.equal(resumed.passwordFor('beta'),'my-secret-2');
  resumed.upsert({...sample('alpha'),rememberMode:'obfuscate'});
  assert.equal(resumed.passwordFor('alpha'),'my-secret-1');
  resumed.remove('alpha');
  assert.equal(new Store(t.file).passwordFor('beta'),'my-secret-2');
  assert(!readFileSync(join(t.dir,'credentials.json'),'utf8').includes('alpha'));
 }finally{t.end();}
});
test('AES-GCM encrypted passwords remain authenticated across restart; invalid tag fails closed',()=>{
 const t=temp();const old=process.env.DSH_REMOTE_VAULT_KEY;
 try {
  process.env.DSH_REMOTE_VAULT_KEY=crypto.randomBytes(32).toString('base64');
  const db=new Store(t.file);db.upsert({...sample(),password:'sensitive☃',rememberMode:'aes'});
  assert.equal(new Store(t.file).passwordFor('server-a'),'sensitive☃');
  const vault=JSON.parse(readFileSync(join(t.dir,'credentials.json'),'utf8'));
  const rec=vault.profiles['server-a'];
  assert.equal(rec.keySource,process.platform==='win32'?'dpapi':'env'); assert.equal(rec.mode,'aes');assert.equal(rec.tag.length>0,true);
  assert(!JSON.stringify(vault).includes('sensitive'));
  rec.tag=Buffer.alloc(16,0).toString('base64');
  writeFileSync(join(t.dir,'credentials.json'),JSON.stringify(vault));
  assert.throws(()=>new Store(t.file).passwordFor('server-a'),/cannot be decrypted/);
 } finally { if(old===undefined)delete process.env.DSH_REMOTE_VAULT_KEY;else process.env.DSH_REMOTE_VAULT_KEY=old;t.end();}
});
test('AES Windows path wraps key via DPAPI CurrentUser provider and refuses identity changes',()=>{
 const t=temp();try {
  const fake=(action, data)=> action==='protect' ? Buffer.concat([Buffer.from('PROTECTED:'),data]) : Buffer.from(data).subarray(10);
  const vault=new CredentialVault(join(t.dir,'credentials.json'),{platform:'win32',dpapi:fake});
  const p=sample();
  vault.remember(p.id,p,'win-secret','aes');
  const entry=JSON.parse(readFileSync(vault.file,'utf8')).profiles[p.id];
  assert.equal(entry.keySource,'dpapi');assert(entry.wrappedKey);
  const restarted=new CredentialVault(vault.file,{platform:'win32',dpapi:fake});
  assert.equal(restarted.get(p.id,p),'win-secret');
  assert.equal(restarted.get(p.id,{...p,host:'other'}),'');
 }finally{t.end();}
});
test('keyboard-interactive password is answered only for password prompts, not OTP',()=>{
 const t=temp();try {
  const db=new Store(t.file);db.upsert({...sample(),password:'test-pass',rememberMode:'obfuscate'});
  const opts=authOptions(db.profile('server-a'),db);
  assert.deepEqual(opts.authHandler.map(x=>x.type),['password','keyboard-interactive']);
  let answers=null;
  opts.authHandler[1].prompt('','','',[{prompt:'Password: ',echo:false}],x=>answers=x);
  assert.deepEqual(answers,['test-pass']);
  opts.authHandler[1].prompt('','','',[{prompt:'OTP code:',echo:false}],x=>answers=x);
  assert.deepEqual(answers,[]);
  assert.equal(new Store(t.file).passwordFor('server-a'),'test-pass');
 }finally{t.end();}
});
test('deleting a profile removes only its vault secret; session guard marker remains to protect old sessions',async()=>{
 const t=temp();try {
  const db=new Store(t.file);db.upsert({...sample(),password:'secret',rememberMode:'obfuscate'});
  const root=join(t.dir,'anchors');
  const registered=[];
  const manager=new VirtualWorkspaceManager(db,{root,remote:{test:async()=>({connected:true})},registry:{list:()=>registered,create:async(dir,title)=>{const w={id:'workspace-1',path:dir,title};registered.push(w);return w;}}});
  const r=await manager.create('server-a');
  assert.equal(virtualIdForCwd(r.localAnchor,root),'server-a');
  db.remove('server-a');
  assert.equal(virtualIdForCwd(r.localAnchor,root),'server-a');
  assert.equal(new Store(t.file).profiles.size,0);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(t.dir,'credentials.json'),'utf8')).profiles).length,0);
 }finally{t.end();}
});

test('unsupported remember-password modes are rejected without changing existing credential',()=>{
 const t=temp();try {
  const db=new Store(t.file);db.upsert({...sample(),password:'original',rememberMode:'obfuscate'});
  assert.throws(()=>db.upsert({...sample(),password:'replacement',rememberMode:'bogus'}),/Invalid remember-password mode/);
  assert.equal(db.passwordFor('server-a'),'original');
 } finally{t.end();}
});
