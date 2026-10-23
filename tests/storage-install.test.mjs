import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {resolveDataDir,legacyDataDir,newProfileDataDir}=require('../lib/data-dir.cjs');
const {createService}=require('../lib/server.cjs');
const {preview,purge}=require('../lib/cleanup.cjs');
const {remoteToolGuard}=require('../lib/remote-guard.cjs');
const {resolveAgentProfile}=require('../lib/remote-context.cjs');
const profile=(id)=>({id,protocol:'ssh',host:'example.org',username:'agent',remoteRoot:'/srv/myapp',readOnly:false});
function isolated(t){
  const root=mkdtempSync(join(tmpdir(),'drw-storage-'));
  const previous=process.env.DSH_HOME, priorOverride=process.env.DSH_REMOTE_WORKSPACE_DATA_DIR;
  process.env.DSH_HOME=join(root,'home');
  delete process.env.DSH_REMOTE_WORKSPACE_DATA_DIR;
  t.after(()=>{ if(previous===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=previous;
    if(priorOverride===undefined)delete process.env.DSH_REMOTE_WORKSPACE_DATA_DIR;else process.env.DSH_REMOTE_WORKSPACE_DATA_DIR=priorOverride;
    rmSync(root,{recursive:true,force:true}); });
  return root;
}
test('fresh install uses profile-adjacent persistent folder, not package node_modules or legacy home',t=>{
  const root=isolated(t),profileDir=join(root,'profiles','web');
  const data=resolveDataDir({profileDir});
  assert.equal(data.reason,'profile-local');
  assert.equal(data.root,join(profileDir,'.plugin-data','dsh-remote-workspace'));
  const svc=createService({}, {profileDir,remote:{test:async()=>({ok:true})},native:{},virtual:{rootPath:()=>join(data.root,'session-anchors')}});
  assert.equal(svc.store.file,join(data.root,'connections.json'));
  assert.equal(svc.auditFile,join(data.root,'audit.jsonl'));
  svc.store.upsert(profile('prod'));
  assert(existsSync(svc.store.file));
  assert.equal(existsSync(join(legacyDataDir(),'connections.json')),false);
});
test('existing legacy configuration takes precedence on upgrade without silently losing SSH passwords',t=>{
  const root=isolated(t),legacy=legacyDataDir();
  mkdirSync(legacy,{recursive:true});
  writeFileSync(join(legacy,'connections.json'),'{}');
  const result=resolveDataDir({profileDir:join(root,'profiles','web')});
  assert.equal(result.reason,'legacy-preserved');
  assert.equal(result.root,legacy);
  assert.equal(createService({}, {profileDir:join(root,'profiles','web')}).store.file,join(legacy,'connections.json'));
});
test('explicit directory wins, must be absolute, and never silently copies old credentials',t=>{
  const root=isolated(t),custom=join(root,'other-disk','rw-data');
  mkdirSync(legacyDataDir(),{recursive:true});
  writeFileSync(join(legacyDataDir(),'connections.json'),'{}');
  assert.equal(resolveDataDir({dataDir:custom,profileDir:root}).root,custom);
  assert.throws(()=>resolveDataDir({dataDir:'relative/path'}),/absolute/);
  const svc=createService({dataDir:custom},{profileDir:root});
  assert.equal(svc.store.file,join(custom,'connections.json'));
  assert.equal(svc.store.list().length,0);
  assert(existsSync(join(legacyDataDir(),'connections.json')));
});
test('legacy SSH chat remains guarded after selecting a different data root',async t=>{
  const root=isolated(t),custom=join(root,'new-data');
  const svc=createService({dataDir:custom});
  const oldCwd=join(legacyDataDir(),'session-anchors','prod--abc123');
  svc.store.upsert(profile('prod'));
  svc.workingDirectory={ensure:async()=>oldCwd};
  const event={name:'bash',arguments:{workdir:join(root,'safe')},agent:{},signal:new AbortController().signal};
  const result=await remoteToolGuard(svc,event,()=>({kind:'allow'}));
  assert.equal(result.kind,'deny');
  await assert.rejects(resolveAgentProfile(svc,'prod',{agent:{}}),/Historical remote workspace/);
});
test('explicit purge deletes profile-local owned data, without deleting parent profile',async t=>{
  const root=isolated(t),profileDir=join(root,'profiles','web');
  const svc=createService({}, {profileDir});
  mkdirSync(profileDir,{recursive:true});writeFileSync(join(profileDir,'profile-sentinel'),'keep');
  svc.store.upsert(profile('prod'));
  const workspaces=[];
  svc.virtual.setRegistry({list:()=>workspaces,delete:async()=>true});
  const result=await purge(svc,'DELETE_PLUGIN_LOCAL_DATA');
  assert.equal(result.complete,true,JSON.stringify(result.errors));
  assert(!existsSync(svc.store.file));
  assert.equal(readFileSync(join(profileDir,'profile-sentinel'),'utf8'),'keep');
});
