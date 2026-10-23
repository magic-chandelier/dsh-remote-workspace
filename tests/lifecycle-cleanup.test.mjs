import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
const { Store }=require('../lib/store.cjs');
const { VirtualWorkspaceManager, virtualIdForCwd, reservedIdForCwd }=require('../lib/virtual-workspace.cjs');
const { resolveAgentProfile }=require('../lib/remote-context.cjs');
const { remoteToolGuard }=require('../lib/remote-guard.cjs');
const { preview,purge }=require('../lib/cleanup.cjs');
const { makeRoute }=require('../lib/server.cjs');
const { logAudit }=require('../lib/audit.cjs');
const profile=(id,host=id+'.internal')=>({id,host,protocol:'ssh',port:22,username:'agent',remoteRoot:'/var/www',readOnly:false});
function setup(){
  const base=mkdtempSync(join(tmpdir(),'dsh-clean-'));
  const home=join(base,'dsh');mkdirSync(home);
  const file=join(home,'remote-workspace','connections.json');
  const store=new Store(file);store.upsert(profile('alpha'));store.upsert(profile('beta'));
  const workspaces=[];
  const registry={list:()=>[...workspaces],create:async(p,title)=>{
    const w={id:'ws-'+(Math.random()+1).toString(36).slice(2),path:p,title};workspaces.push(w);return w;},
    delete:async id=>{const pos=workspaces.findIndex(w=>w.id===id);if(pos<0)return false;workspaces.splice(pos,1);return true;}};
  const remote={test:async()=>({ok:true})};
  const virtual=new VirtualWorkspaceManager(store,{root:join(home,'remote-workspace','session-anchors'),registry,remote});
  const service={store,virtual,remote,native:{rootPath:()=>join(base,'mounts')},workingDirectory:{ensure:async()=>null}};
  const cleanup=()=>rmSync(base,{recursive:true,force:true});
  return {base,home,file,store,virtual,registry,remote,service,cleanup};
}
const exec=(cwd,name='bash')=>({name,agent:{},signal:new AbortController().signal,arguments:{}});
test('removing workspace deletes only marker & anchor, preserves connection and chat safety',async()=>{
  const f=setup();try {
    const ws=await f.virtual.create('alpha');const before=ws.localAnchor;
    assert(existsSync(before));assert.equal(f.registry.list().length,1);
    const result=await f.virtual.remove('alpha');
    assert.equal(result.removed,true);assert.equal(existsSync(before),false);
    assert.equal(f.registry.list().length,0);
    assert.equal(f.store.profile('alpha').host,'alpha.internal');
    assert(reservedIdForCwd(before,f.virtual.rootPath()));
    assert.equal(virtualIdForCwd(before,f.virtual.rootPath()),null);
    f.service.workingDirectory.ensure=async()=>before;
    for(const name of ['bash','read','remote_read','remote_shell']) {
      const decision=await remoteToolGuard(f.service,exec(before,name),()=>({kind:'allow'}));
      assert.equal(decision.kind,'deny',name);
    }
    await assert.rejects(resolveAgentProfile(f.service,'beta',exec(before,'remote_read')),/Historical remote workspace/);
  }finally{f.cleanup();}
});
test('same profile reused after removal receives a NEW cwd, old sessions never route to it',async()=>{
  const f=setup();try {
    const original=await f.virtual.create('alpha');await f.virtual.remove('alpha');
    f.store.remove('alpha');f.store.upsert(profile('alpha','changed.example'));
    const fresh=await f.virtual.create('alpha');
    assert.notEqual(original.localAnchor,fresh.localAnchor);
    assert.equal(virtualIdForCwd(fresh.localAnchor,f.virtual.rootPath()),'alpha');
    f.service.workingDirectory.ensure=async()=>original.localAnchor;
    await assert.rejects(resolveAgentProfile(f.service,'alpha',exec(original.localAnchor,'remote_read')),/Historical remote workspace/);
    f.service.workingDirectory.ensure=async()=>fresh.localAnchor;
    assert.equal(await resolveAgentProfile(f.service,'alpha',exec(fresh.localAnchor,'remote_read'),{skipConnection:true}),'alpha');
  }finally{f.cleanup();}
});
test('native Harness sidebar deletion gets lazily swept by plugin, without deleting server or chat logs',async()=>{
  const f=setup();try {
    const ws=await f.virtual.create('alpha');
    const log=join(f.base,'chat.jsonl');writeFileSync(log,'historic session content');
    await f.registry.delete(ws.workspaceId);
    const result=f.virtual.prune();
    assert.deepEqual(result.removed,['alpha--'+ws.localAnchor.split('alpha--')[1]]);
    assert.equal(existsSync(ws.localAnchor),false);
    assert.equal(readFileSync(log,'utf8'),'historic session content');
  }finally{f.cleanup();}
});
test('unexpected files in anchor stop plugin deletion, never recurse into user files',async()=>{
  const f=setup();try {
    const ws=await f.virtual.create('alpha');writeFileSync(join(ws.localAnchor,'personal.txt'),'keep');
    const result=await f.virtual.remove('alpha');
    assert.equal(result.removed,false);
    assert.equal(readFileSync(join(ws.localAnchor,'personal.txt'),'utf8'),'keep');
    assert.equal(f.registry.list().length,0);
    const sweep=f.virtual.prune();assert.equal(sweep.retained.length,1);
  }finally{f.cleanup();}
});
test('only plugin-managed file paths are removed by explicit uninstall cleanup, unconfirmed action is rejected',async()=>{
  const f=setup();const prior=process.env.DSH_HOME;
  process.env.DSH_HOME=f.home;
  try {
    f.store.upsert({...profile('alpha'),password:'do-not-log',rememberMode:'obfuscate'});
    await f.virtual.create('alpha');await f.virtual.create('beta');
    logAudit({state:'test'});
    const local=join(f.base,'local-project');mkdirSync(local);writeFileSync(join(local,'source.ts'),'keep');
    const history=join(f.base,'historic-chat.json');writeFileSync(history,'keep');
    const inv=preview(f.service);
    assert.equal(inv.connectionIds.length,2);
    assert.equal(inv.registeredWorkspaces.length,2);
    assert(inv.ownedFiles.some(x=>x.endsWith('credentials.json')));
    await assert.rejects(purge(f.service,'DELETE'),/confirmation/);
    const result=await purge(f.service,'DELETE_PLUGIN_LOCAL_DATA');
    assert.equal(result.complete,true,JSON.stringify(result.errors));
    assert.equal(existsSync(f.file),false);
    assert.equal(existsSync(join(f.home,'remote-workspace','credentials.json')),false);
    assert.equal(f.registry.list().length,0);
    assert.equal(readFileSync(join(local,'source.ts'),'utf8'),'keep');
    assert.equal(readFileSync(history,'utf8'),'keep');
  } finally { if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior; f.cleanup(); }
});
test('chat labeling uses official optional sessionTitle service, stable after workspace deletion',async()=>{
  const f=setup();try {
    const ws=await f.virtual.create('alpha');
    f.service.workingDirectory.ensure=async()=>ws.localAnchor;
    const session={id:'s1'};let title='部署检查';let writes=0;
    f.service.sessionTitle={get:()=>({title}),rename:(_session,value)=>{title=value;writes++;}};
    const e={name:'remote_read',agent:{session},arguments:{path:'index.js'}};
    const next=()=>({kind:'allow'});
    assert.equal((await remoteToolGuard(f.service,e,next)).kind,'allow');
    assert.equal(title,'[SSH alpha@alpha.internal:www] 部署检查');
    await remoteToolGuard(f.service,e,next);assert.equal(writes,1);
    await f.virtual.remove('alpha');assert.equal(title,'[SSH alpha@alpha.internal:www] 部署检查');
  }finally{f.cleanup();}
});
test('API remove unregisters plugin workspace and frees anchor while preserving remote files',async()=>{
  const f=setup();try{
    const ws=await f.virtual.create('alpha');
    const service={...f.service,terminal:{},connectionGate:{disconnect:()=>{}}};
    const route=makeRoute(service);
    const res=await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'remove',id:'alpha'})}));
    assert.equal(res.status,200,JSON.stringify(await res.clone().json()));
    assert.equal(existsSync(ws.localAnchor),false);
    assert.equal(f.store.profiles.has('alpha'),false);
    assert.equal(f.store.profiles.has('beta'),true);
  }finally{f.cleanup();}
});

test('cleanup removes recognized interrupted-write temp files without touching unrelated data',async()=>{
  const f=setup();try {
    const dir=join(f.home,'remote-workspace');
    const temp=join(dir,'connections.json.tmp-12345-abcdefabcdef');
    const unknown=join(dir,'unrelated-user.txt');
    writeFileSync(temp,'old temp');writeFileSync(unknown,'do not delete');
    const inv=preview(f.service);
    assert(inv.temporaryFiles.includes(temp));
    const result=await purge(f.service,'DELETE_PLUGIN_LOCAL_DATA');
    assert.equal(existsSync(temp),false);
    assert.equal(readFileSync(unknown,'utf8'),'do not delete');
    assert.equal(result.complete,false);
    assert(result.errors.some(e=>/Unrecognized/.test(e.reason)));
  }finally{f.cleanup();}
});
test('cleanup refuses to delete transfer staging while a server operation is busy',async()=>{
  const f=setup();try {
    let disposed=0;
    f.service.transfers={sessions:new Map([['busy',{busy:true}]]),dispose:()=>{disposed++;}};
    const before=f.registry.list().length;
    const result=await purge(f.service,'DELETE_PLUGIN_LOCAL_DATA');
    assert.equal(result.complete,false);
    assert.equal(disposed,1);
    assert.equal(f.registry.list().length,before);
    assert.equal(existsSync(f.file),true);
  }finally{f.cleanup();}
});
