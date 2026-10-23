import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {createService}=require('../lib/server.cjs');
const {registerBindingTools}=require('../lib/binding-tools.cjs');
const {bindProject}=require('../lib/binding.cjs');
const {bindingIdentity}=require('../lib/binding-trust.cjs');
const {remoteToolGuard}=require('../lib/remote-guard.cjs');
const {requestBindingApproval}=require('../lib/binding-approval.cjs');

async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'rw-security-0522-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'ordinary-local-project');mkdirSync(project);
  let remoteTests=0, remoteReads=0;
  const remote={test:async()=>{remoteTests++;}};
  const service=createService({}, {filename:join(root,'data','connections.json'),remote});
  service.store.upsert({id:'prod',protocol:'sftp',host:'server.test',username:'alice',remoteRoot:'/srv',readOnly:false,password:'test-only',rememberMode:'obfuscate'});
  const result=await bindProject(project,{connectionId:'prod',remotePath:'/srv/repo'}, id=>service.store.profile(id));
  service.bindingTrust.confirm(result.localRoot,result.binding,bindingIdentity(service.store,'prod'));
  service.boundRemoteFactory=()=>({
    list:async()=>{remoteReads++;return ['remote-file'];},
    read:async()=>{remoteReads++;return {content:'hello',sha256:'abc'};},
    write:async()=>{remoteReads++;return {written:true};}
  });
  const registered=[];
  registerBindingTools({workingDirectory:{ensure:async()=>project},tools:{register:x=>registered.push(x)}},service,x=>x);
  const tool=id=>registered.find(x=>x.name===id);
  const exec=(session='a')=>({agent:{session:{id:session}},signal:new AbortController().signal});
  return {service,project,root,tool,exec,stats:()=>({remoteTests,remoteReads})};
}
test('bound project remote reads require explicit connection approval',async t=>{
  const f=await fixture(t);
  f.service.questions=null;
  await assert.rejects(f.tool('remote_project_list').execute({path:'.'},f.exec()),/用户审批/);
  await assert.rejects(f.tool('remote_project_read').execute({path:'x'},f.exec()),/用户审批/);
  await assert.rejects(f.tool('remote_project_compare').execute({path:'x'},f.exec()),/用户审批/);
  assert.deepEqual(f.stats(),{remoteTests:0,remoteReads:0});
});
test('bound project grant cannot be reused by a different chat session',async t=>{
  const f=await fixture(t);
  let asked=0;
  f.service.questions={ask:async()=>{asked++;return {answers:[{id:'rw-connect-approval',selected:['允许连接']}]};}};
  await f.tool('remote_project_list').execute({path:'.'},f.exec('chatA'));
  await f.tool('remote_project_read').execute({path:'x'},f.exec('chatA'));
  assert.equal(asked,1);
  await f.tool('remote_project_read').execute({path:'x'},f.exec('chatB'));
  assert.equal(asked,2);
  assert.equal(f.stats().remoteReads,3);
});
test('model-supplied binding confirmation does not authorize local project edits',async t=>{
  const f=await fixture(t);f.service.questions=null;
  await assert.rejects(f.tool('remote_binding_remove').execute({confirmation:'UNBIND_THIS_WORKSPACE'},f.exec()),/AI cannot (?:remove|create|modify)/);
  await assert.rejects(f.tool('remote_binding_save').execute({confirmation:'BIND_THIS_WORKSPACE',connectionId:'prod',remotePath:'/srv/new',replace:true},f.exec()),/AI cannot (?:remove|create|modify)/);
  assert.equal(f.stats().remoteReads,0);
});
test('bound remote project write requires real human approval even after connection grant',async t=>{
  const f=await fixture(t);
  f.service.questions={ask:async payload=>({answers:[{id:payload.questions[0].id,selected:[payload.questions[0].id==='rw-connect-approval'?'允许连接':'拒绝']}]})};
  await assert.rejects(f.tool('remote_project_write').execute({path:'file.txt',content:'new',expectedSha256:'',confirmation:'WRITE_REMOTE_PROJECT'},f.exec()),/declined/);
  assert.equal(f.stats().remoteReads,0);
});
test('approval must fail on aborted agent session even if question API returns allow',async t=>{
  const controller=new AbortController();
  const questions={ask:async()=>{controller.abort();return {answers:[{id:'rw-binding-approval',selected:['批准本次操作']}]};}};
  await assert.rejects(requestBindingApproval(questions,{agent:{session:{id:'a'}},signal:controller.signal},'write','file'),/aborted/);
});
test('native SSHFS workspace blocks local filesystem tools and command argument cwd bypass',async t=>{
  const f=await fixture(t);
  const native=join(f.service.native.rootPath(),'prod');mkdirSync(native,{recursive:true});
  f.service.workingDirectory={ensure:async()=>native};
  for (const name of ['bash','pwsh','read_file','write_file','apply_patch','python','file_search','remote_project_list','remote_binding_save']) {
    const result=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:{cwd:f.project}},()=>({kind:'allow'}));
    assert.equal(result.kind,'deny',name);
  }
});
test('historical SSHFS mount stays blocked after its connection is removed',async t=>{
  const f=await fixture(t);
  const native=join(f.service.native.rootPath(),'prod');mkdirSync(native,{recursive:true});
  f.service.store.remove('prod');
  f.service.workingDirectory={ensure:async()=>native};
  for (const name of ['bash','read_file','remote_read']) {
    const result=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:{profile:'prod'}},()=>({kind:'allow'}));
    assert.equal(result.kind,'deny',name);
  }
});
test('ordinary local projects still allow local tools and are unaffected by SSHFS restrictions',async t=>{
  const f=await fixture(t);f.service.workingDirectory={ensure:async()=>f.project};
  const result=await remoteToolGuard(f.service,{name:'read_file',agent:f.exec().agent},()=>({kind:'allow'}));
  assert.equal(result.kind,'allow');
});
test('project binding switched during remote authorization cannot pivot a read',async t=>{
  const f=await fixture(t);
  f.service.questions={ask:async()=>{
    await bindProject(f.project,{connectionId:'prod',remotePath:'/srv/other'},id=>f.service.store.profile(id),{replace:true});
    return {answers:[{id:'rw-connect-approval',selected:['允许连接']}]};
  }};
  await assert.rejects(f.tool('remote_project_read').execute({path:'file.txt'},f.exec()),/binding changed|not trusted or has changed/);
  assert.equal(f.stats().remoteReads,0);
});
test('a human-approved bound project write aborts when the server connection is revoked during approval',async t=>{
  const f=await fixture(t);
  f.service.questions={ask:async body=>{
    if(body.questions[0].id==='rw-binding-approval') f.service.connectionGate.disconnect('prod');
    return {answers:[{id:body.questions[0].id,selected:[body.questions[0].id==='rw-connect-approval'?'允许连接':'批准本次操作']}]};
  }};
  await assert.rejects(f.tool('remote_project_write').execute({path:'file.txt',content:'new',expectedSha256:'',confirmation:'WRITE_REMOTE_PROJECT'},f.exec()),/authorization changed/i);
  assert.equal(f.stats().remoteReads,0);
});
test('model-requested remote download to a local root requires Harness mutation approval',async t=>{
  const f=await fixture(t);f.service.workingDirectory={ensure:async()=>f.project};
  const result=await remoteToolGuard(f.service,{name:'remote_download',agent:f.exec().agent},()=>({kind:'allow'}));
  assert.equal(result.kind,'deny'); // local project uses only pinned remote_project_* tools
});
test('lost trustworthy working directory blocks Agent tools while native SSHFS sessions exist',async t=>{
  const f=await fixture(t);
  f.service.native.setRegistry({list:()=>[]});
  f.service.workingDirectory=null;
  const result=await remoteToolGuard(f.service,{name:'read_file',agent:f.exec().agent,arguments:{cwd:f.project}},()=>({kind:'allow'}));
  assert.equal(result.kind,'deny');
});
test('a canceled Agent prompt cannot grant remembered-credential authorization',async t=>{
  const f=await fixture(t);
  const controller=new AbortController();
  const exec={agent:{session:{id:'canceled'}},signal:controller.signal};
  f.service.questions={ask:async()=>{controller.abort();return {answers:[{id:'rw-connect-approval',selected:['允许连接']}]};}};
  await assert.rejects(f.service.connectionGate.ensure('prod',exec),/aborted/);
  assert.equal(f.service.connectionGate.state('prod',exec).authorized,false);
  assert.equal(f.stats().remoteTests,0);
});

test('orphaned SSHFS-Win UNC provider cannot fall back to native tools or switch remote profiles',async t=>{
  const f=await fixture(t);
  const path = String.raw`\\sshfs.r\removed@oldhost!22\srv`;
  f.service.workingDirectory={ensure:async()=>path};
  for(const name of ['bash','read_file','remote_read']) {
    const guard=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:{profile:'prod'}},()=>({kind:'allow'}));
    assert.equal(guard.kind,'deny',name);
  }
  const {resolveAgentProfile}=require('../lib/remote-context.cjs');
  await assert.rejects(resolveAgentProfile(f.service,'prod',f.exec()),/removed SSHFS-Win/);
});
