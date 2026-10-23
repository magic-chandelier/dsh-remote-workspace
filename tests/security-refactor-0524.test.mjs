import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url);
const {createService,toolsFor}=require('../lib/server.cjs');
const {registerBindingTools}=require('../lib/binding-tools.cjs');
const {remoteToolGuard}=require('../lib/remote-guard.cjs');
const {identityFor,MARKER}=require('../lib/virtual-workspace.cjs');
const {bindProject}=require('../lib/binding.cjs');
const {bindingIdentity}=require('../lib/binding-trust.cjs');

function fixture(t,mode='remote') {
  const base=mkdtempSync(join(tmpdir(),'rw-refactor-0524-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  let verified=0,questions=0,wdCalls=0,writes=0;
  const service=createService({}, {filename:join(base,'private','connections.json'),remote:{test:async()=>{verified++;}}});
  service.store.upsert({id:'prod',protocol:'sftp',host:'remote.test',port:22,username:'alice',remoteRoot:'/srv',password:'test-only',rememberMode:'obfuscate'});
  const cwd=mode==='remote' ? join(service.virtual.rootPath(),'prod') : join(base,'project');
  mkdirSync(cwd,{recursive:true});
  if(mode==='remote') writeFileSync(join(cwd,MARKER),`prod\n${identityFor(service.store,'prod')}\n`);
  service.workingDirectory={ensure:async()=>{wdCalls++;return cwd;}};
  service.questions={ask:async payload=>{questions++;const q=payload.questions[0];return {answers:[{id:q.id,selected:[q.id==='rw-connect-approval'?'允许连接':'批准本次操作']}]};}};
  const exec=()=>({agent:{session:{id:'chat-a'}},signal:new AbortController().signal});
  return {service,cwd,exec,stats:()=>({verified,questions,wdCalls,writes}),noteWrite:()=>{writes++;}};
}

test('remote_connect_request resolves one scope and grants exactly once',async t=>{
  const f=fixture(t);
  const tool=toolsFor(f.service).find(x=>x.name==='remote_connect_request');
  const data=JSON.parse(await tool.execute({profile:'prod'},f.exec()));
  assert.equal(data.authorized,true);
  assert.deepEqual(f.stats(),{verified:1,questions:1,wdCalls:2,writes:0});
  await tool.execute({},f.exec());
  assert.deepEqual(f.stats(),{verified:1,questions:1,wdCalls:4,writes:0});
});

test('remote project write has one real approval, not a duplicate pre-execute mutation prompt',async t=>{
  const f=fixture(t,'local');
  const created=await bindProject(f.cwd,{connectionId:'prod',remotePath:'/srv/app'},id=>f.service.store.profile(id));
  f.service.bindingTrust.confirm(created.localRoot,created.binding,bindingIdentity(f.service.store,'prod'));
  f.service.boundRemoteFactory=()=>({write:async()=>{f.noteWrite();return {written:true};}});
  const tools=[];
  registerBindingTools({workingDirectory:f.service.workingDirectory,tools:{register:x=>tools.push(x)}},f.service,x=>x);
  const exec=f.exec();
  const guard=await remoteToolGuard(f.service,{name:'remote_project_write',agent:exec.agent,signal:exec.signal,arguments:{path:'file.txt'}},()=>({kind:'allow'}));
  assert.equal(guard.kind,'allow');
  const tool=tools.find(x=>x.name==='remote_project_write');
  const response=JSON.parse(await tool.execute({path:'file.txt',content:'new',expectedSha256:'',confirmation:'WRITE_REMOTE_PROJECT'},exec));
  assert.equal(response.written,true);
  assert.equal(f.stats().questions,2); // one connection approval and one write approval
  assert.equal(f.stats().writes,1);
});

test('refactored authorization still rejects server selection by model',async t=>{
  const f=fixture(t);
  const tool=toolsFor(f.service).find(x=>x.name==='remote_connect_request');
  await assert.rejects(tool.execute({profile:'another'},f.exec()),/belongs to prod/);
  assert.equal(f.stats().questions,0);
});

test('refactored project tools fail closed without user question channel',async t=>{
  const f=fixture(t,'local');
  const created=await bindProject(f.cwd,{connectionId:'prod',remotePath:'/srv/app'},id=>f.service.store.profile(id));
  f.service.bindingTrust.confirm(created.localRoot,created.binding,bindingIdentity(f.service.store,'prod'));
  const tools=[];
  registerBindingTools({workingDirectory:f.service.workingDirectory,tools:{register:x=>tools.push(x)}},f.service,x=>x);
  f.service.questions=null;
  await assert.rejects(tools.find(x=>x.name==='remote_project_write').execute({path:'x',content:'z',expectedSha256:'',confirmation:'WRITE_REMOTE_PROJECT'},f.exec()),/审批|approval/);
  assert.equal(f.stats().writes,0);
});

test('remote pre-execute guard resolves the trusted cwd once, without trusting argument cwd',async t=>{
  const f=fixture(t);
  const exec=f.exec();
  const result=await remoteToolGuard(f.service,{name:'remote_read',agent:exec.agent,signal:exec.signal,arguments:{cwd:'/tmp/irrelevant',path:'x'}},()=>({kind:'allow'}));
  assert.equal(result.kind,'allow');
  assert.equal(f.stats().wdCalls,1);
});
