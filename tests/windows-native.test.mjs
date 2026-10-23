import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {Store}=require('../lib/store.cjs');
const {NativeWorkspaceManager,windowsUncForProfile}=require('../lib/native-workspace.cjs');
function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),'windows-dsh-'));
  const store=new Store(join(dir,'connections.json'));
  store.upsert({id:'prod',protocol:'ssh',host:'example.test',port:2222,username:'deploy',remoteRoot:'/srv/app',readOnly:false,hostTrustMode:'tofu'});
  return Promise.resolve().then(()=>fn(store)).finally(()=>rmSync(dir,{recursive:true,force:true}));
}
test('windows UNC strictly derives from SSH identity and absolute remote path',()=>{
  const p={username:'deploy',host:'example.test',port:2222};
  assert.equal(windowsUncForProfile(p,'/srv/app'),String.raw`\\sshfs.r\deploy@example.test!2222\srv\app`);
  assert.throws(()=>windowsUncForProfile({...p,host:'evil\\other'},'/'),/standard/);
  assert.throws(()=>windowsUncForProfile(p,'/../evil'),/safe/);
});
test('win32 registers only verified real SSHFS-Win UNC, never a local fake directory',()=>fixture(async store=>{
  let created=null;
  const expected=String.raw`\\sshfs.r\deploy@example.test!2222\srv\app`;
  const mgr=new NativeWorkspaceManager(store,{platform:'win32',windowsStat:path=>{assert.equal(path,expected);return {isDirectory:()=>true};},registry:{create:async (path,title)=>{created=path;return {id:'w',title};}}});
  const result=await mgr.create('prod');
  assert.equal(created,expected);assert.equal(result.mode,'sshfs-win');assert.equal(result.localMount,expected);
  assert.equal(mgr.status('prod').mounted,true);
}));
test('win32 registration rejects unreachable UNC and refuses unsupported trust modes',()=>fixture(async store=>{
  const mgr=new NativeWorkspaceManager(store,{platform:'win32',windowsStat:()=>{const err=new Error('network unavailable');err.code='ENOENT';throw err;},registry:{create:async()=>{throw new Error('should not register');}}});
  await assert.rejects(mgr.create('prod'),/not mounted or accessible/);
  store.upsert({...store.profile('prod'),hostTrustMode:'insecure'});
  await assert.rejects(mgr.create('prod'),/refuses insecure/);
}));
