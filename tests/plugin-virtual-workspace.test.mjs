import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { Store } = require('../lib/store.cjs');
const { VirtualWorkspaceManager, virtualIdForCwd, virtualIdentityMatches } = require('../lib/virtual-workspace.cjs');
const { resolveAgentProfile } = require('../lib/remote-context.cjs');
const { createService, toolsFor, makeRoute } = require('../lib/server.cjs');
const profile = id => ({id,protocol:'ssh',host:id+'.internal',username:'deployer',remoteRoot:'/srv/app',port:22,readOnly:false});
function fixture() {
  const base = mkdtempSync(join(tmpdir(),'dsh-virtual-'));
  const store = new Store(join(base,'connections.json'));
  store.upsert(profile('alpha'));store.upsert(profile('beta'));
  const created = [];
  const registry = {list:()=>created, create:async (dir,title) => { const item={id:'ws-'+created.length,path:dir,title};created.push(item);return item; }};
  const remote = {test:async(id)=>({ok:true,id}),read:async(id,file)=>({profile:id,path:file,content:'remote'})};
  const virtual = new VirtualWorkspaceManager(store,{root:join(base,'anchors'),remote,registry});
  return {base,store,registry,remote,virtual,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
test('plugin remote workspace creates private session anchor without mounting or mirroring remote content',async()=>{
  const f=fixture();
  try {
    const ws=await f.virtual.create('alpha');
    assert.equal(ws.mode,'plugin-ssh');assert.equal(ws.remotePath,'/srv/app');
    assert.equal(ws.workspaceId,'ws-0');
    assert.equal(virtualIdForCwd(ws.localAnchor, f.virtual.rootPath()),'alpha');
    assert.equal(virtualIdForCwd(join(ws.localAnchor,'nested'), f.virtual.rootPath()),'alpha');
    assert.equal(virtualIdForCwd(f.base, f.virtual.rootPath()),null);
    assert(virtualIdentityMatches(f.store,'alpha',f.virtual.rootPath()));
    assert.equal(existsSync(join(ws.localAnchor,'srv')),false);
    assert.equal(readFileSync(join(ws.localAnchor,'.dsh-remote-workspace-anchor'),'utf8').split('\n')[0],'alpha');
  } finally{f.cleanup();}
});
test('failed network validation does not create an apparently usable workspace',async()=>{
  const f=fixture();
  try {
    f.virtual.remote.test=async()=>{throw new Error('Auth failure');};
    await assert.rejects(f.virtual.create('alpha'),/Auth failure/);
    assert.equal(existsSync(f.virtual.rootPath()),false);
    assert.equal(f.registry.list().length,0);
  } finally{f.cleanup();}
});
test('session identity routes tools to its SSH connection, never to a globally selected server',async()=>{
  const f=fixture();
  try {
    const ws=await f.virtual.create('alpha');
    f.store.active='beta';
    const service={store:f.store,virtual:f.virtual,native:{rootPath:()=>join(f.base,'unused')},
      workingDirectory:{ensure:async()=>ws.localAnchor}};
    const exec={agent:{},signal:new AbortController().signal};
    await assert.rejects(resolveAgentProfile(service,undefined,exec),/authorization gate unavailable/);
    assert.equal(await resolveAgentProfile(service,undefined,exec,{skipConnection:true}),'alpha');
    await assert.rejects(resolveAgentProfile(service,'beta',exec),/belongs to alpha/);
    const mock = {read:async (id,file)=>({from:id,file})};
    const api=createService({}, { filename:join(f.base,'connections.json'), remote:mock, virtual:f.virtual });
    api.workingDirectory=service.workingDirectory;
    api.native=service.native;
    // Approving a connection is mandatory before remote file tools execute.
    await assert.rejects(api.connectionGate.ensure('alpha',exec),/手动连接/);
    api.connectionGate.manual.set('alpha',{token:require('../lib/connection-gate.cjs').fingerprint(api.store,'alpha') + ':0',expires:Date.now()+120000});
    api.questions={ask:async()=>({answers:[{id:'rw-manual-connect',selected:['已手动连接']}]})};
    const tool=toolsFor(api).find(t=>t.name==='remote_read');
    const resolved=JSON.parse(await tool.execute({path:'readme.txt'},exec));
    assert.equal(resolved.from,'alpha');
    await assert.rejects(tool.execute({profile:'beta',path:'readme.txt'},exec),/belongs to alpha/);
  } finally{f.cleanup();}
});
test('server or remote directory changes invalidate old session anchors, including after deletion',async()=>{
  const f=fixture();
  try {
    const ws=await f.virtual.create('alpha');
    const service={store:f.store,virtual:f.virtual,native:{rootPath:()=>join(f.base,'other')},
      workingDirectory:{ensure:async()=>ws.localAnchor}};
    const exec={agent:{},signal:new AbortController().signal};
    f.store.setWorkspace('alpha','/srv/app/moved');
    await assert.rejects(resolveAgentProfile(service,undefined,exec),/identity changed/);
    await assert.rejects(f.virtual.create('alpha'),/Invalid remote workspace anchor marker/);
    f.store.remove('alpha');
    assert.equal(virtualIdForCwd(ws.localAnchor,f.virtual.rootPath()),'alpha', 'remain marked after removing connection');
    await assert.rejects(resolveAgentProfile(service,undefined,exec),/identity changed/);
  } finally {f.cleanup();}
});
test('API virtual_create requires workingDirectory and routes to plugin implementation only',async()=>{
  const f=fixture();
  try {
    const service=createService({}, {filename:join(f.base,'connections.json'),remote:f.remote,virtual:f.virtual});
    const send=body=>makeRoute(service).fetch(new Request('http://localhost/api/dsh-remote-workspace',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
    let response=await send({action:'virtual_create',id:'alpha'});
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/workingDirectory/);
    service.workingDirectory={ensure:async()=>'/tmp'};
    response=await send({action:'virtual_create',id:'alpha'});
    assert.equal(response.status,200);
    assert.equal((await response.json()).data.mode,'plugin-ssh');
  } finally{f.cleanup();}
});
test('FTP-only connection can create a plugin-owned scoped remote workspace session',async()=>{
  const f=fixture();
  try {
    f.store.upsert({...profile('ftp'),protocol:'ftp'});
    const ws=await f.virtual.create('ftp');
    assert.equal(ws.mode,'plugin-remote');
    assert.equal(virtualIdForCwd(ws.localAnchor,f.virtual.rootPath()),'ftp');
  } finally{f.cleanup();}
});

test('remote session policy denies ALL local shell/filesystem/process tools regardless of model workdir',async()=>{
  const f=fixture();
  try{
    const ws=await f.virtual.create('alpha');
    const { remoteToolGuard } = require('../lib/remote-guard.cjs');
    const service={store:f.store,virtual:f.virtual,native:{rootPath:()=>join(f.base,'none')},
      workingDirectory:{ensure:async()=>ws.localAnchor}};
    const execName=async name=>remoteToolGuard(service,{name,agent:{},signal:new AbortController().signal,arguments:{workdir:f.base}},()=>({kind:'allow'}));
    for(const name of ['bash','pwsh','read','write','edit','str_replace_editor','working_directory','run_code','job_start','glob','grep']){
      assert.equal((await execName(name)).kind,'deny',name);
    }
    for(const name of ['remote_list','remote_read','remote_workspace','todo_write','web_search']){
      assert.equal((await execName(name)).kind,'allow',name);
    }
    assert.equal((await execName('remote_write')).kind,'ask');
    const wrong=await remoteToolGuard(service,{name:'remote_read',agent:{},arguments:{profile:'beta'}},()=>({kind:'allow'}));
    assert.equal(wrong.kind,'deny');
    f.store.remove('alpha');
    assert.equal((await execName('bash')).kind,'deny','even after connection removal');
    assert.equal((await execName('remote_read')).kind,'deny','no fallback to newly active connection');
  } finally{f.cleanup();}
});
