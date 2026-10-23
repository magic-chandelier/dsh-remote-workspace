import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createService, toolsFor, makeRoute } = require('../lib/server.cjs');
const { remoteToolGuard } = require('../lib/remote-guard.cjs');
const { identityFor, MARKER } = require('../lib/virtual-workspace.cjs');

function fixture(rememberMode = 'none') {
  const base = mkdtempSync(join(tmpdir(), 'rw-auth-'));
  const readCalls = [], testCalls = [];
  const remote = {
    test: async id => {testCalls.push(id);return {connected:true,profile:id};},
    read: async (id,file) => {readCalls.push([id,file]);return {profile:id,path:file,content:'remote'};},
  };
  const service = createService({}, {filename:join(base,'connections.json'),remote});
  service.store.upsert({id:'prod',protocol:'ssh',host:'server.example',username:'dev',remoteRoot:'/srv/project',
    rememberMode,password:'s3cr3t'});
  service.store.upsert({id:'other',protocol:'ssh',host:'other.example',username:'dev',remoteRoot:'/srv/other',
    rememberMode,password:'different'});
  const cwd = join(service.virtual.rootPath(),'prod');
  mkdirSync(cwd,{recursive:true});
  writeFileSync(join(cwd,MARKER),`prod\n${identityFor(service.store,'prod')}\n`);
  service.workingDirectory={ensure:async()=>cwd};
  service.native.rootPath=()=>join(base,'mounts');
  const exec = (id='session-a') => ({agent:{session:{id}},signal:new AbortController().signal});
  const cleanup=()=>rmSync(base,{recursive:true,force:true});
  return {base,service,remote,readCalls,testCalls,exec,cleanup,cwd};
}
function tool(f,name) {return toolsFor(f.service).find(x=>x.name===name);}
async function request(route,body) {
  const response=await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  return {status:response.status,...(await response.json())};
}
test('remembered password: AI requests permission and verifies SSH before reading; connection is session-scoped',async()=>{
  const f=fixture('obfuscate');
  try {
    let prompts=0;
    f.service.questions={ask:async() => {prompts++;return {answers:[{id:'rw-connect-approval',selected:['允许连接']}]};}};
    const statusTool=tool(f,'remote_connection_status');
    assert.equal(JSON.parse(await statusTool.execute({},f.exec())).next,'request-approval');
    assert.deepEqual(f.testCalls,[],'checking status must not connect');
    const read=tool(f,'remote_read');
    assert.equal(JSON.parse(await read.execute({path:'README.md'},f.exec())).content,'remote');
    assert.equal(prompts,1);assert.deepEqual(f.testCalls,['prod']);
    await read.execute({path:'README.md'},f.exec());assert.equal(prompts,1,'same session should not ask twice');
    assert.equal(JSON.parse(await statusTool.execute({},f.exec())).authorized,true);
    await read.execute({path:'README.md'},f.exec('other-session'));
    assert.equal(prompts,2,'new session must independently authorize');
    await assert.rejects(read.execute({profile:'other',path:'README.md'},f.exec()),/belongs to prod/);
  }finally{f.cleanup();}
});
test('rejected connection never tests SSH, never reads remote and never falls back to local',async()=>{
  const f=fixture('obfuscate');
  try {
    f.service.questions={ask:async()=>({answers:[{id:'rw-connect-approval',selected:['暂不连接']}]})};
    await assert.rejects(tool(f,'remote_read').execute({path:'a'},f.exec()),/未批准/);
    assert.equal(f.readCalls.length,0);assert.equal(f.testCalls.length,0);
    for(const name of ['bash','pwsh','read','edit','run_code','glob']){
      const result=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:{workdir:f.base}},()=>({kind:'allow'}));
      assert.equal(result.kind,'deny',name);
    }
  }finally{f.cleanup();}
});
test('no remembered password: AI requests manual login; authenticated UI action unlocks only that profile',async()=>{
  const f=fixture('none');
  try {
    f.service.questions=null;
    const read=tool(f,'remote_read');
    const status=JSON.parse(await tool(f,'remote_connection_status').execute({},f.exec()));
    assert.equal(status.next,'manual-connect');
    await assert.rejects(read.execute({path:'a'},f.exec()),/手动连接供 AI 使用/);
    assert.equal(f.readCalls.length,0);assert.equal(f.testCalls.length,0);
    const route=makeRoute(f.service);
    const connected=await request(route,{action:'connect_for_agent',id:'prod'});
    assert.equal(connected.status,200);assert.equal(connected.data.method,'manual-pending');
    assert.equal(connected.data.authorized,false);
    f.service.questions={ask:async()=>({answers:[{id:'rw-manual-connect',selected:['已手动连接']}]})};
    assert.equal(JSON.parse(await read.execute({path:'a'},f.exec())).profile,'prod');
    assert.equal((await request(route,{action:'connection_status',id:'other'})).data.authorized,false);
    assert.equal((await request(route,{action:'disconnect_for_agent',id:'prod'})).status,200);
    await assert.rejects(read.execute({path:'a'},f.exec()),/手动连接/);
  }finally{f.cleanup();}
});
test('saved auth without userQuestions cannot connect; incorrect SSH credentials are not authorized',async()=>{
  const f=fixture('obfuscate');
  try {
    const read=tool(f,'remote_read');
    await assert.rejects(read.execute({path:'a'},f.exec()),/用户审批/);
    f.service.questions={ask:async()=>({answers:[{id:'rw-connect-approval',selected:['允许连接']}]})};
    f.remote.test=async()=>{throw new Error('All configured authentication methods failed');};
    await assert.rejects(read.execute({path:'a'},f.exec()),/authentication methods failed/);
    assert.equal(JSON.parse(await tool(f,'remote_connection_status').execute({},f.exec())).authorized,false);
    assert.equal(f.readCalls.length,0);
  }finally{f.cleanup();}
});
test('disconnect while SSH verification is pending prevents later authorization',async()=>{
  const f=fixture('obfuscate');
  try {
    let done;
    f.remote.test=()=>new Promise(resolve=>{done=resolve;});
    f.service.questions={ask:async()=>({answers:[{id:'rw-connect-approval',selected:['允许连接']}]})};
    const connecting=tool(f,'remote_connect_request').execute({},f.exec());
    // Approval resolves on a microtask, then the fake authentication starts.
    for(let i=0;i<12 && !done;i++) await Promise.resolve();
    assert.equal(typeof done,'function');
    f.service.connectionGate.disconnect('prod');
    done({connected:true});
    await assert.rejects(connecting,/配置或授权已变化/);
    assert.equal(JSON.parse(await tool(f,'remote_connection_status').execute({},f.exec())).authorized,false);
  }finally{f.cleanup();}
});
test('editing connection invalidates previously granted session; manual action cannot authorize a profile without credentials',async()=>{
  const f=fixture('none');
  try {
    await f.service.connectionGate.connectManually('prod');
    assert.equal(JSON.parse(await tool(f,'remote_connection_status').execute({},f.exec())).authorized,false);
    assert.equal(JSON.parse(await tool(f,'remote_connection_status').execute({},f.exec())).manualReady,true);
    f.service.store.upsert({id:'prod',protocol:'ssh',host:'server.example',username:'dev',remoteRoot:'/srv/project',rememberMode:'none'});
    await assert.rejects(tool(f,'remote_read').execute({path:'a'},f.exec()),/手动连接/);
    f.service.store.upsert({id:'prod',protocol:'ssh',host:'server.example',username:'dev',remoteRoot:'/srv/project',rememberMode:'none',clearPassword:true});
    await assert.rejects(f.service.connectionGate.connectManually('prod'),/输入登录密码/);
  }finally{f.cleanup();}
});
test('unremembered credentials trigger a manual-connection question and resume only after verified UI login',async()=>{
  const f=fixture('none');
  try {
    let reply;
    f.service.questions={ask:async question=>{
      assert.equal(question.questions[0].id,'rw-manual-connect');
      assert.match(question.questions[0].detail,/不记住/);
      return new Promise(resolve=>{reply=resolve;});
    }};
    const reading=tool(f,'remote_read').execute({path:'a'},f.exec());
    for(let i=0;i<15 && !reply;i++) await Promise.resolve();
    assert.equal(typeof reply,'function');
    assert.equal(f.testCalls.length,0,'must not automatically authenticate using unsaved password');
    const route=makeRoute(f.service);
    const result=await request(route,{action:'connect_for_agent',id:'prod'});
    assert.equal(result.data.connected,true);
    reply({answers:[{id:'rw-manual-connect',selected:['已手动连接']}]});
    assert.equal(JSON.parse(await reading).content,'remote');
    assert.equal(f.testCalls.length,1);
  }finally{f.cleanup();}
});
test('manual connection dialog cannot be bypassed by claiming to have connected',async()=>{
  const f=fixture('none');
  try {
    f.service.questions={ask:async()=>({answers:[{id:'rw-manual-connect',selected:['已手动连接']}]})};
    await assert.rejects(tool(f,'remote_read').execute({path:'file'},f.exec()),/尚未完成经过验证的手动连接/);
    assert.equal(f.testCalls.length,0);assert.equal(f.readCalls.length,0);
  }finally{f.cleanup();}
});
