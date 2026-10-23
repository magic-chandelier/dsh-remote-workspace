import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {createService,makeRoute} = require('../lib/server.cjs');
const {handleBindingApi}=require('../lib/binding-api.cjs');
const {getBinding,BEGIN}=require('../lib/binding.cjs');
const {registerBindingTools}=require('../lib/binding-tools.cjs');
function harnessFixture(t){
  const base=mkdtempSync(join(tmpdir(),'dsh-bind-int-')); t.after(()=>rmSync(base,{recursive:true,force:true}));
  const a=join(base,'Project A'),b=join(base,'Project B'); mkdirSync(a);mkdirSync(b);
  const srv=createService({}, {filename:join(base,'conn.json')});
  srv.store.upsert({id:'dev',host:'dev.example.test',username:'alice',protocol:'sftp',remoteRoot:'/srv/projects',readOnly:true});
  srv.store.upsert({id:'stage',host:'stage.example.test',username:'bob',protocol:'sftp',remoteRoot:'/var/sites',readOnly:true});
  const projects=[{id:'A',title:'Project A',path:a},{id:'B',title:'Project B',path:b}];
  srv.bindingRegistry={list:()=>projects,get:id=>projects.find(w=>w.id===id)};
  return {a,b,srv};
}
test('binding route lists only Harness registered local projects and refuses arbitrary path injection',async t=>{
  const {a,srv}=harnessFixture(t);
  const list=await handleBindingApi(srv,{action:'workspace_list'});
  assert.equal(list.workspaces.length,2);
  assert.equal(list.workspaces[0].path,a);
  await assert.rejects(handleBindingApi(srv,{action:'binding_save',workspaceId:'not-registered',localRoot:'/tmp/evil',connectionId:'dev',remotePath:'/srv/projects/app',confirmation:'BIND_THIS_WORKSPACE'}),/no longer registered/);
  await assert.rejects(handleBindingApi(srv,{action:'binding_save',workspaceId:'A',connectionId:'dev',remotePath:'/srv/projects/app',confirmation:'wrong'}),/confirmation/);
});
test('bind, change binding, unbind across distinct projects; existing AGENTS.md retained',async t=>{
  const {a,b,srv}=harnessFixture(t);
  writeFileSync(join(a,'AGENTS.md'),'# Important rules\nDONOTDELETE\n');
  const save=(workspaceId,connectionId,remotePath,replace=false)=>handleBindingApi(srv,{action:'binding_save',workspaceId,connectionId,remotePath,replace,confirmation:'BIND_THIS_WORKSPACE'});
  await save('A','dev','/srv/projects/a');
  await save('B','stage','/var/sites/b');
  assert.equal((await getBinding(a)).binding.connectionId,'dev');
  assert.equal((await getBinding(b)).binding.remotePath,'/var/sites/b');
  await assert.rejects(save('A','stage','/var/sites/a'),/already bound/);
  await save('A','dev','/srv/projects/new',true);
  const notice=readFileSync(join(a,'AGENTS.md'),'utf8');
  assert(notice.includes('DONOTDELETE'));
  assert.equal(notice.split(BEGIN).length-1,1);
  assert(!readFileSync(join(a,'.harness-remote.json'),'utf8').includes('dev.example.test'));
  await handleBindingApi(srv,{action:'binding_remove',workspaceId:'A',confirmation:'UNBIND_THIS_WORKSPACE'});
  assert(readFileSync(join(a,'AGENTS.md'),'utf8').includes('DONOTDELETE'));
  assert(!(readFileSync(join(a,'AGENTS.md'),'utf8').includes(BEGIN)));
  assert.equal((await getBinding(b)).binding.connectionId,'stage');
});
test('binding API goes through same Harness authenticated route without writable browser file paths',async t=>{
  const {a,srv}=harnessFixture(t);const route=makeRoute(srv);
  const send=async body=>{const r=await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));return r.json();};
  const result=await send({action:'binding_save',workspaceId:'A',localRoot:'/etc',connectionId:'dev',remotePath:'/srv/projects/demo',confirmation:'BIND_THIS_WORKSPACE'});
  assert.equal(result.ok,true);
  assert.equal((await getBinding(a)).binding.remotePath,'/srv/projects/demo');
  const status=await send({action:'binding_read',workspaceId:'A'});
  assert.equal(status.data.binding.connectionId,'dev');
  const invalid=await send({action:'binding_save',workspaceId:'A',connectionId:'dev',remotePath:'/etc/escape',replace:true,confirmation:'BIND_THIS_WORKSPACE'});
  assert.equal(invalid.ok,false);
});
test('workspaceRegistry missing does not crash plugin route',async t=>{
  const {srv}=harnessFixture(t);srv.bindingRegistry=null;
  assert.deepEqual(await handleBindingApi(srv,{action:'workspace_list'}),{available:false,workspaces:[],reason:'Harness workspaceRegistry unavailable'});
  await assert.rejects(handleBindingApi(srv,{action:'binding_read',workspaceId:'A'}),/not available/);
});
test('agent binding tools register official defineTool DSL and isolate remote base per session',async t=>{
  const {a,b,srv}=harnessFixture(t);
  await handleBindingApi(srv,{action:'binding_save',workspaceId:'A',connectionId:'dev',remotePath:'/srv/projects/a',confirmation:'BIND_THIS_WORKSPACE'});
  await handleBindingApi(srv,{action:'binding_save',workspaceId:'B',connectionId:'stage',remotePath:'/var/sites/b',confirmation:'BIND_THIS_WORKSPACE'});
  const tools=[];const cwd=new Map([['agentA',a],['agentB',b]]);
  const ctx={tools:{register:x=>tools.push(x)},workingDirectory:{ensure:async agent=>cwd.get(agent)}};
  registerBindingTools(ctx,srv,spec=>spec);
  assert.equal(tools.length,7);
  const status=tools.find(x=>x.name==='remote_binding_status');
  assert.equal(JSON.parse(await status.execute({}, {agent:'agentA'})).binding.connectionId,'dev');
  assert.equal(JSON.parse(await status.execute({}, {agent:'agentB'})).binding.connectionId,'stage');
  const list=tools.find(x=>x.name==='remote_project_list');
  assert.equal(typeof list.execute,'function');
  assert.equal(srv.store.active,''); // no global mutation
  assert.deepEqual(tools.map(x=>x.name).filter(x=>x.startsWith('remote_project_')),[ 'remote_project_list', 'remote_project_read', 'remote_project_compare', 'remote_project_write' ]);
});
