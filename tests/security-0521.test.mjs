import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const {createService,toolsFor} = require('../lib/server.cjs');
const {remoteToolGuard} = require('../lib/remote-guard.cjs');
const {RemoteManager} = require('../lib/remote.cjs');
const {TransferSessions} = require('../lib/transfer-sessions.cjs');
const {fingerprint} = require('../lib/connection-gate.cjs');
const {identityFor,MARKER}=require('../lib/virtual-workspace.cjs');
const fresh = () => mkdtempSync(join(tmpdir(),'rw-security-0521-'));
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(mode='obfuscate',bound=false) {
  const root=fresh(), history={checks:[],reads:[],approvals:0};
  const remote={test:async id=>{history.checks.push(id);},read:async(id,p)=>{history.reads.push([id,p]);return {id,p};}};
  const service=createService({}, {filename:join(root,'connections.json'),remote});
  service.store.upsert({id:'prod',protocol:'ssh',host:'server.test',port:22,username:'user',remoteRoot:'/srv',password:'secret',rememberMode:mode});
  let cwd=root;
  if(bound){cwd=join(service.virtual.rootPath(),'prod');mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,MARKER),`prod\n${identityFor(service.store,'prod')}\n`);}
  service.workingDirectory={ensure:async()=>cwd};
  service.questions={ask:async ({questions})=>{
    history.approvals++;
    const q=questions[0];return {answers:[{id:q.id,selected:[q.id==='rw-manual-connect'?'已手动连接':'允许连接']}]};
  }};
  const exec=(id='chat-a')=>({agent:{session:{id}},signal:new AbortController().signal});
  const tool=name=>toolsFor(service).find(x=>x.name===name);
  return {root,history,service,remote,exec,tool,close:()=>{service.dispose();rmSync(root,{recursive:true,force:true});}};
}
test('unbound ordinary AI conversation cannot read remote profiles even when profile is supplied',async()=>{
  const f=fixture();try {
    for (const [name,args] of [['remote_read',{profile:'prod',path:'x'}],['remote_connection_status',{profile:'prod'}],
      ['remote_connect_request',{profile:'prod'}],['remote_connect_test',{profile:'prod'}],['remote_profiles',{}],['remote_workspace',{}],
      ['remote_exec',{profile:'prod',command:'uptime'}]]) {
      await assert.rejects(f.tool(name).execute(args,f.exec()),/not bound to a remote server/,name);
    }
    assert.deepEqual(f.history.checks,[]);assert.deepEqual(f.history.reads,[]);assert.equal(f.history.approvals,0);
  }finally{f.close();}
});
test('SSHFS local shell cannot escape by overriding cwd with a local directory',async()=>{
  const f=fixture();try {
    const native=join(f.service.native.rootPath(),'prod');mkdirSync(native,{recursive:true});
    f.service.workingDirectory={ensure:async()=>native};
    for(const name of ['bash','pwsh']) {
      const answer=await remoteToolGuard(f.service,{name,agent:f.exec().agent,arguments:{cwd:f.root}},()=>({kind:'allow'}));
      assert.equal(answer.kind,'deny');assert.match(answer.reason,/SSHFS/);
    }
  }finally{f.close();}
});
test('single-use manual verification authorizes one AI session, not another chat',async()=>{
  const f=fixture('none',true);try {
    const gate=f.service.connectionGate;
    await gate.connectManually('prod');
    assert.equal(gate.state('prod',f.exec()).authorized,false);
    assert.equal(gate.state('prod',f.exec()).manualReady,true);
    await f.tool('remote_read').execute({profile:'prod',path:'ok'},f.exec('chat-a'));
    assert.equal(gate.state('prod',f.exec('chat-a')).authorized,true);
    assert.equal(gate.state('prod',f.exec('chat-b')).authorized,false);
    await assert.rejects(f.tool('remote_read').execute({profile:'prod',path:'no'},f.exec('chat-b')),/尚未完成经过验证的手动连接/);
    assert.equal(f.history.reads.length,1);
  }finally{f.close();}
});
test('expired or stale manual handoff does not authorize remote access',async()=>{
  const f=fixture('none',true);try {
    const gate=f.service.connectionGate;
    await gate.connectManually('prod');
    gate.manual.set('prod',{token:fingerprint(f.service.store,'prod')+':0',expires:Date.now()-1});
    await assert.rejects(f.tool('remote_read').execute({profile:'prod',path:'no'},f.exec()),/尚未完成经过验证的手动连接/);
    assert.equal(f.history.reads.length,0);
  }finally{f.close();}
});
test('legacy AI upload refuses to overwrite remote destination',async()=>{
  const root=fresh();try {
    writeFileSync(join(root,'local.txt'),'new content');
    const p={id:'prod',protocol:'sftp',host:'server.test',port:22,username:'user',remoteRoot:'/srv',readOnly:false};
    const store={profile:()=>p,workspace:()=>'/srv',sessionPasswords:new Map()};
    let puts=0; const client={realPath:async path=>path,exists:async path=>path==='/srv/remote.txt',put:async()=>{puts++;}};
    const remote=new RemoteManager(store,{localRoot:root,connect:async(_p,_s,cb)=>cb({kind:'sftp',client})});
    await assert.rejects(remote.transfer('prod','remote.txt','local.txt','upload'),/already exists/);
    assert.equal(puts,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('cancel before remote commit aborts staged upload and removes partial file',async()=>{
  const root=fresh();try {
    const p={id:'prod',protocol:'sftp',host:'server.test',port:22,username:'user',remoteRoot:'/srv',readOnly:false};
    const store={profile:()=>p,workspace:()=>'/srv',sessionPasswords:new Map()};
    const storage=new Map(),entered=deferred(),resume=deferred();let commits=0;
    const client={realPath:async path=>path,exists:async path=>storage.has(path),
      put:async(src,dst)=>{storage.set(dst,readFileSync(src));entered.resolve();await resume.promise;},
      rename:async(from,to)=>{commits++;storage.set(to,storage.get(from));storage.delete(from);},delete:async p=>storage.delete(p)};
    const remote=new RemoteManager(store,{connect:async(_p,_s,cb)=>cb({kind:'sftp',client})});
    const transfers=new TransferSessions(remote,root);
    try {
      const {token}=transfers.beginUpload('prod','file.txt',3);
      transfers.appendUpload('prod',token,0,Buffer.from('abc').toString('base64'));
      const finishing=transfers.finishUpload('prod',token);
      await entered.promise;
      assert.equal(transfers.cancel('prod',token).pending,true);
      resume.resolve();
      await assert.rejects(finishing,/canceled before remote commit/);
      assert.equal(commits,0);assert.equal(storage.size,0);
      assert.equal(transfers.sessions.size,0);
    }finally{transfers.dispose();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a completed remote commit is reported as completed, not falsely canceled',async()=>{
  const root=fresh();try {
    const p={id:'prod',protocol:'sftp',host:'server.test',port:22,username:'user',remoteRoot:'/srv',readOnly:false};
    let transfers;
    const remote={context:()=>({p,base:'/srv'}),uploadStaged:async(id,path,file)=>{
      const token=[...transfers.sessions.keys()][0];transfers.cancel(id,token);
      return {uploaded:'/srv/'+path,bytes:3};
    }};
    transfers=new TransferSessions(remote,root);
    try {
      const {token}=transfers.beginUpload('prod','file.txt',3);
      transfers.appendUpload('prod',token,0,Buffer.from('abc').toString('base64'));
      const result=await transfers.finishUpload('prod',token);
      assert.equal(result.committed,true);assert.equal(result.cancelRequested,true);
      assert.equal(transfers.sessions.size,0);
    }finally{transfers.dispose();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('remote Agent tools fail closed when Harness did not provide an Agent identity',async()=>{
  const f=fixture();try {
    await assert.rejects(f.tool('remote_read').execute({profile:'prod',path:'no'}),/Trusted Harness Agent/);
    assert.deepEqual(f.history.reads,[]);
    assert.deepEqual(f.history.checks,[]);
  }finally{f.close();}
});
test('FTP also requires approval; unremembered FTP supports a one-time manual handoff',async()=>{
  const f=fixture('none',true);try {
    f.service.store.upsert({id:'ftp-profile',protocol:'ftp',host:'ftp.example',port:21,username:'user',remoteRoot:'/data',password:'secret',rememberMode:'none'});
    const ftpCwd=join(f.service.virtual.rootPath(),'ftp-profile');
    mkdirSync(ftpCwd,{recursive:true});writeFileSync(join(ftpCwd,MARKER),`ftp-profile\n${identityFor(f.service.store,'ftp-profile')}\n`);
    f.service.workingDirectory={ensure:async()=>ftpCwd};
    await f.service.connectionGate.connectManually('ftp-profile');
    assert.equal(f.service.connectionGate.state('ftp-profile',f.exec()).manualReady,true);
    assert.equal(f.service.connectionGate.state('ftp-profile',f.exec()).authorized,false);
    await f.tool('remote_read').execute({profile:'ftp-profile',path:'test.txt'},f.exec());
    assert.deepEqual(f.history.reads,[['ftp-profile','test.txt']]);
    assert.equal(f.service.connectionGate.state('ftp-profile',f.exec()).authorized,true);
  }finally{f.close();}
});
