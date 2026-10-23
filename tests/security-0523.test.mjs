import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url);
const {createService,toolsFor}=require('../lib/server.cjs');
const {registerBindingTools}=require('../lib/binding-tools.cjs');
const {remoteToolGuard}=require('../lib/remote-guard.cjs');
const {handleBindingApi}=require('../lib/binding-api.cjs');
const {bindProject}=require('../lib/binding.cjs');
const {bindingIdentity}=require('../lib/binding-trust.cjs');
const {identityFor,MARKER}=require('../lib/virtual-workspace.cjs');
const {preview}=require('../lib/cleanup.cjs');
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'rw-bound-0523-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const localPath=join(root,'project');mkdirSync(localPath);
  const local=realpathSync(localPath);
  const counts={test:0,read:0,questions:0};
  const remote={test:async()=>{counts.test++;},read:async id=>{counts.read++;return {profile:id}}};
  const service=createService({},{filename:join(root,'private','connections.json'),remote});
  for(const id of ['prod','stage']) service.store.upsert({id,protocol:'sftp',host:id+'.test',port:22,username:'alice',remoteRoot:'/srv',rememberMode:'obfuscate',password:'dummy-password'});
  let cwd=local;
  service.workingDirectory={ensure:async()=>cwd};
  service.questions={ask:async data=>{counts.questions++;return {answers:[{id:data.questions[0].id,selected:['允许连接']}]};}};
  service.bindingRegistry={list:()=>[{id:'LOCAL',path:local,title:'Project'}],get:id=>id==='LOCAL'?{id,path:local}:null};
  const exec=(session='one')=>({agent:{session:{id:session}},signal:new AbortController().signal});
  const tool=name=>toolsFor(service).find(x=>x.name===name);
  const bind=(profile='prod',remotePath='/srv/repo',replace=false)=>handleBindingApi(service,{action:'binding_save',workspaceId:'LOCAL',connectionId:profile,remotePath,replace,confirmation:'BIND_THIS_WORKSPACE'});
  const anchor=(id='prod')=>{cwd=join(service.virtual.rootPath(),id);mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,MARKER),`${id}\n${identityFor(service.store,id)}\n`);return cwd;};
  return {root,local,counts,remote,service,exec,tool,bind,anchor,setCwd:x=>{cwd=x;}};
}
test('unbound chat cannot read server metadata, connect or read, even with profile ID',async t=>{
  const f=setup(t);
  for(const [name,args] of [['remote_profiles',{}],['remote_workspace',{}],['remote_connection_status',{profile:'prod'}],['remote_connect_request',{profile:'prod'}],['remote_read',{profile:'prod',path:'a'}],['remote_connect_test',{profile:'prod'}]]){
    await assert.rejects(f.tool(name).execute(args,f.exec()),/not bound/,name);
    const result=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:args},()=>({kind:'allow'}));
    assert.equal(result.kind,'deny',name);
  }
  assert.deepEqual(f.counts,{test:0,read:0,questions:0});
});
test('managed workspace pins all Agent tools to one profile and only returns that profile metadata',async t=>{
  const f=setup(t);f.anchor('prod');
  const listed=JSON.parse(await f.tool('remote_profiles').execute({},f.exec()));
  assert.deepEqual(listed.profiles.map(p=>p.id),['prod']);
  const workspace=JSON.parse(await f.tool('remote_workspace').execute({},f.exec()));
  assert.equal(workspace.active,'prod');
  await assert.rejects(f.tool('remote_read').execute({profile:'stage',path:'a'},f.exec()),/belongs to prod/);
  await assert.rejects(f.tool('remote_connect_request').execute({profile:'stage'},f.exec()),/belongs to prod/);
  const guard=await remoteToolGuard(f.service,{name:'remote_read',agent:f.exec().agent,arguments:{profile:'stage'}},()=>({kind:'allow'}));
  assert.equal(guard.kind,'deny');
  assert.equal((await f.tool('remote_read').execute({path:'a'},f.exec())).includes('prod'),true);
  assert.equal(f.counts.questions,1);
});
test('model editable local binding JSON cannot establish permission without private UI ledger',async t=>{
  const f=setup(t);
  await bindProject(f.local,{connectionId:'prod',remotePath:'/srv/repo'},id=>f.service.store.profile(id));
  const binds=[];
  registerBindingTools({workingDirectory:f.service.workingDirectory,tools:{register:spec=>binds.push(spec)}},f.service,x=>x);
  await assert.rejects(binds.find(x=>x.name==='remote_project_read').execute({path:'a'},f.exec()),/not trusted/);
  await assert.rejects(f.tool('remote_connection_status').execute({profile:'prod'},f.exec()),/not trusted/);
  assert.equal(f.counts.test,0);
});
test('Web UI confirmation creates persistent private trust; local project only gets project tools',async t=>{
  const f=setup(t);await f.bind();
  assert(existsSync(f.service.bindingTrust.file));
  const newInstance=new (require('../lib/binding-trust.cjs').BindingTrust)(f.service.dataDir);
  newInstance.verify(f.local,{connectionId:'prod',remotePath:'/srv/repo'},bindingIdentity(f.service.store,'prod'));
  assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).mode,'local-project');
  for (const [name,args] of [['remote_read',{profile:'prod',path:'a'}],['remote_exec',{profile:'prod',command:'id'}],
    ['remote_upload',{profile:'prod',remotePath:'a',localPath:'a'}],['remote_delete',{profile:'prod',path:'a'}],
    ['remote_connect_test',{profile:'prod'}]]) {
    await assert.rejects(f.tool(name).execute(args,f.exec()),/only remote_project_/,name);
  }
  const list=await remoteToolGuard(f.service,{name:'remote_project_read',agent:f.exec().agent},()=>({kind:'allow'}));
  assert.equal(list.kind,'allow');
});
test('changing the project binding file cannot switch server or subdirectory',async t=>{
  const f=setup(t);await f.bind();
  const file=join(f.local,'.harness-remote.json');
  const binding=JSON.parse(readFileSync(file));
  for(const change of [{connectionId:'stage'},{remotePath:'/srv/other'}]) {
    writeFileSync(file,JSON.stringify({...binding,...change}));
    await assert.rejects(f.tool('remote_connection_status').execute({},f.exec()),/not trusted/);
  }
  writeFileSync(file,JSON.stringify(binding));
  assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).active,'prod');
});
test('new server configuration invalidates old private project trust until user confirms',async t=>{
  const f=setup(t);await f.bind();
  f.service.store.upsert({id:'prod',protocol:'sftp',host:'changed.test',port:22,username:'alice',remoteRoot:'/srv',rememberMode:'obfuscate',password:'another'});
  await assert.rejects(f.tool('remote_workspace').execute({},f.exec()),/not trusted/);
  await f.bind('prod','/srv/repo',true);
  assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).active,'prod');
});
test('AI cannot save/remove binding even with model-provided confirmation',async t=>{
  const f=setup(t);await f.bind();
  const tools=[];
  registerBindingTools({workingDirectory:f.service.workingDirectory,tools:{register:x=>tools.push(x)}},f.service,x=>x);
  for(const name of ['remote_binding_save','remote_binding_remove']) {
    await assert.rejects(tools.find(x=>x.name===name).execute({confirmation:'BIND_THIS_WORKSPACE'},f.exec()),/AI cannot/);
    const guard=await remoteToolGuard(f.service,{name,agent:f.exec().agent},()=>({kind:'allow'}));
    assert.equal(guard.kind,'deny');
  }
  assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).active,'prod');
});
test('UI unbind revokes privilege even if the user restores the old binding file',async t=>{
  const f=setup(t);await f.bind();
  const file=join(f.local,'.harness-remote.json'),old=readFileSync(file);
  await handleBindingApi(f.service,{action:'binding_remove',workspaceId:'LOCAL',confirmation:'UNBIND_THIS_WORKSPACE'});
  writeFileSync(file,old);
  await assert.rejects(f.tool('remote_workspace').execute({},f.exec()),/not trusted/);
  assert.equal(f.service.bindingTrust.records.size,0);
});
test('old project binding from before upgrade requires one UI reconfirmation',async t=>{
  const f=setup(t);
  await bindProject(f.local,{connectionId:'prod',remotePath:'/srv/repo'},id=>f.service.store.profile(id));
  await assert.rejects(f.tool('remote_workspace').execute({},f.exec()),/not trusted/);
  await f.bind('prod','/srv/repo',true);
  assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).active,'prod');
});
test('loss of trusted workingDirectory and deleted profiles both fail closed',async t=>{
  const f=setup(t);await f.bind();
  f.service.workingDirectory=null;
  await assert.rejects(f.tool('remote_workspace').execute({},f.exec()),/workingDirectory/);
  f.service.workingDirectory={ensure:async()=>f.local};
  f.service.store.remove('prod');
  await assert.rejects(f.tool('remote_workspace').execute({},f.exec()),/Unknown profile|not found|not configured/i);
});
test('uninstall preview includes private binding ledger as plugin-owned data',async t=>{
  const f=setup(t);await f.bind();
  const inspected=preview(f.service);
  assert(inspected.ownedFiles.includes(f.service.bindingTrust.file));
});
test('damaged private ledger refuses to grant or overwrite project trust',async t=>{
  const f=setup(t);await f.bind();
  writeFileSync(f.service.bindingTrust.file,'{invalid json');
  const next=new (require('../lib/binding-trust.cjs').BindingTrust)(f.service.dataDir);
  await assert.rejects(Promise.resolve().then(()=>next.verify(f.local,{connectionId:'prod',remotePath:'/srv/repo'},'x')),/unavailable/);
  assert.throws(()=>next.confirm(f.local,{connectionId:'prod',remotePath:'/srv/repo'},'x'),/damaged/);
});
test('FTP/FTPS managed remote anchors permit scoped remote reads without cross-protocol shell use',async t=>{
  const f=setup(t);
  for(const protocol of ['ftp','ftps']){
    const id=protocol;
    f.service.store.upsert({id,protocol,host:'file.test',port:protocol==='ftp'?21:990,username:'alice',remoteRoot:'/files',rememberMode:'obfuscate',password:'dummy',allowInsecureFtp:protocol==='ftp'});
    f.anchor(id);
    assert.equal(JSON.parse(await f.tool('remote_workspace').execute({},f.exec())).active,id);
    await f.tool('remote_read').execute({path:'a'},f.exec(protocol));
    await assert.rejects(f.tool('remote_read').execute({profile:'prod',path:'a'},f.exec(protocol)),/belongs to/);
  }
});

test('confirmed project trust survives a real Host restart while old connection approvals do not',async t=>{
  const f=setup(t);await f.bind();
  const next=createService({}, {filename:join(f.root,'private','connections.json'),remote:f.remote});
  assert.equal(next.connectionGate.state('prod',f.exec()).authorized,false);
  const {binding}=(await require('../lib/binding.cjs').getBinding(f.local));
  next.bindingTrust.verify(f.local,binding,bindingIdentity(next.store,'prod'));
  next.workingDirectory={ensure:async()=>f.local};
  assert.equal(JSON.parse(await toolsFor(next).find(x=>x.name==='remote_workspace').execute({},f.exec())).active,'prod');
  next.dispose();
});
