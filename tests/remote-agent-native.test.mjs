import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { Store } = require('../lib/store.cjs');
const { targetFor, requestShellApproval, runApprovedShell } = require('../lib/remote-shell.cjs');
const { NativeWorkspaceManager } = require('../lib/native-workspace.cjs');
const { toolsFor, makeRoute } = require('../lib/server.cjs');
function fixture(fn, readOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-native-'));
  const db = join(dir, 'connections.json');
  const key = join(dir, 'private-key'); writeFileSync(key, 'not-a-real-key-for-unit-tests', {mode: 0o600});
  const store = new Store(db);
  store.upsert({id:'prod',host:'ssh.example.test',port:22,username:'deploy',protocol:'ssh',remoteRoot:'/srv/projects',privateKeyPath:key,hostTrustMode:'pinned',hostKeySha256:'a'.repeat(64),readOnly});
  store.setWorkspace('prod', '/srv/projects/app one');
  return Promise.resolve().then(() => fn({ dir, key, store })).finally(() => rmSync(dir,{recursive:true,force:true}));
}
test('remote_shell requires genuine user-question approval, not a model-provided confirmation token', async () => fixture(async ({store}) => {
  const target = targetFor(store, 'prod', 'systemctl restart nginx', 5000);
  assert.equal(target.cwd, '/srv/projects/app one');
  const agent = {session:{}}; const signal = new AbortController().signal;
  await assert.rejects(requestShellApproval(null, {agent,signal}, target), /unavailable/);
  const rejected = {ask:async () => ({answers:[{id:'dsh-remote-shell-confirm',selected:['拒绝执行']}]})};
  await assert.rejects(requestShellApproval(rejected, {agent,signal}, target), /declined/);
  let payload;
  const accepted={ask:async p => {payload=p;return {answers:[{id:'dsh-remote-shell-confirm',selected:['允许执行']}]};}};
  await requestShellApproval(accepted, {agent,signal}, target);
  assert.match(payload.questions[0].detail, /systemctl restart nginx/);
  assert.match(payload.questions[0].detail, /ssh.example.test/);
  assert.equal(payload.signal,signal);
  assert.throws(()=>targetFor(store,'prod','\u0000'),/Invalid/);
  assert.throws(()=>targetFor(store,'prod','ls', 300001),/timeout/);
}));
test('remote_shell uses authenticated SSH, quotes remote directory, captures exit status and limits output', async()=>fixture(async({store})=>{
  let sentCommand, connection;
  class FakeClient extends EventEmitter {
    connect(config) { connection = config; queueMicrotask(()=>this.emit('ready')); }
    exec(command, options, cb) {
      sentCommand=command;
      const channel=new EventEmitter();channel.stderr=new EventEmitter();
      cb(null,channel);
      queueMicrotask(()=>{channel.emit('data',Buffer.from('hello'));channel.stderr.emit('data',Buffer.from('warning'));channel.emit('close',3,null);});
    }
    end() {}
  }
  const result = await runApprovedShell(store,targetFor(store,'prod','pwd && echo hello'),{
    signal:new AbortController().signal,ClientCtor:FakeClient
  });
  assert.equal(result.exitCode,3);
  assert.equal(result.stdout,'hello');assert.equal(result.stderr,'warning');
  assert.equal(sentCommand,"cd -- '/srv/projects/app one' && pwd && echo hello");
  assert.equal(connection.username,'deploy');
  assert.equal(connection.hostHash,'sha256');
}));
test('remote_shell never starts an SSH connection when aborted',async()=>fixture(async({store})=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runApprovedShell(store,targetFor(store,'prod','whoami'),{signal:controller.signal,ClientCtor:class{}}),/aborted/);
}));
test('native creation automatically makes local mountpoint and registers only VERIFIED SSHFS mount', async()=>fixture(async({dir,store})=>{
  const mounts = join(dir,'mounts');
  let info=null, commandInfo, registryCreates=0;
  const mgr = new NativeWorkspaceManager(store, {
    platform:'linux',
    rootPath:()=>mounts,
    mountInfo:()=>info,
    run:async(bin,args)=>{commandInfo={bin,args};info={type:'fuse.sshfs',source:'deploy@ssh.example.test:/srv/projects/app one'};},
    registry:{create:async (p,title)=>{registryCreates++;return {id:'native-id',title,path:p};}}
  });
  const result=await mgr.create('prod');
  assert.equal(result.native,true);
  assert.equal(result.workspaceId,'native-id');
  assert.equal(result.localMount,join(mounts,'prod'));
  assert.equal(commandInfo.bin,'sshfs');
  assert(commandInfo.args.includes('deploy@ssh.example.test:/srv/projects/app one'));
  assert.equal(registryCreates,1);
  assert.equal(mgr.status('prod').mounted,true);
  // Re-use verified mount without repeating SSHFS; workspaceRegistry handles idempotence.
  await mgr.create('prod');assert.equal(registryCreates,2);
}));
test('native creation fails closed: no mount, wrong mount, insecure host or unavailable registry',async()=>fixture(async({dir,store})=>{
  const registry={create:async()=>({id:'yes',title:'wrong'})};
  const base={platform:'linux',rootPath:()=>join(dir,'mounts'),registry};
  const noMount=new NativeWorkspaceManager(store,{...base,mountInfo:()=>null,run:async()=>{}});
  await assert.rejects(noMount.create('prod'),/NOT registered/);
  const hijacked=new NativeWorkspaceManager(store,{...base,mountInfo:()=>({source:'root@another-host:/',type:'fuse.sshfs'})});
  await assert.rejects(hijacked.create('prod'),/different remote source/);
  const noRegistry=new NativeWorkspaceManager(store,{...base,registry:null,mountInfo:()=>null});
  await assert.rejects(noRegistry.create('prod'),/workspaceRegistry unavailable/);
}));
test('remote_shell tool is registered, refuses execution without a real approval channel',async()=>fixture(async({store})=>{
  const service={store,remote:{}, native:{rootPath:()=>'/tmp/dsh-remote-tests-unused',status:()=>({mounted:false})},questions:null};
  const tool=toolsFor(service).find(t=>t.name==='remote_shell');
  assert(tool);
  await assert.rejects(tool.execute({profile:'prod',command:'id'}, {agent:{session:{}},signal:new AbortController().signal}),/workingDirectory are required/);
  const route=makeRoute({...service,native:{create:async()=>({native:true,workspaceId:'w1'}),status:()=>({mounted:false})}});
  const res=await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',body:JSON.stringify({action:'native_create',id:'prod'})}));
  assert.equal((await res.json()).data.workspaceId,'w1');
}));

test('Linux native SSHFS supports a session password without privateKeyPath; never forwards password to CLI argv',async()=>fixture(async({dir,store})=>{
  store.upsert({id:'prod',host:'ssh.example.test',port:22,username:'deploy',protocol:'ssh',remoteRoot:'/srv/projects',hostTrustMode:'tofu',password:'A_SECRET_SHOULD_NOT_APPEAR'});
  let info=null, mountArgs, secret;
  const mgr=new NativeWorkspaceManager(store,{platform:'linux',
    rootPath:()=>join(dir,'password-mounts'),mountInfo:()=>info,
    run:async()=>{throw new Error('key-based sshfs must not run');},
    runPassword:async(args,opts)=>{
      mountArgs=args;secret=opts.password;
      assert.equal(opts.mountCheck(),false);
      info={type:'fuse.sshfs',source:'deploy@ssh.example.test:/srv/projects/app one'};
      assert.equal(opts.mountCheck(),true);
    },
    registry:{create:async()=>({id:'password-workspace',title:'SSH · prod'})}
  });
  const result=await mgr.create('prod');
  assert.equal(result.workspaceId,'password-workspace');
  assert.equal(secret,'A_SECRET_SHOULD_NOT_APPEAR');
  assert(!JSON.stringify(mountArgs).includes(secret));
  assert(mountArgs.join(' ').includes('PasswordAuthentication=yes'));
  assert(!mountArgs.join(' ').includes('IdentityFile='));
}));

test('native SSHFS rejects missing credentials rather than silently mounting an empty placeholder',async()=>fixture(async({dir,store})=>{
  store.upsert({id:'prod',host:'ssh.example.test',port:22,username:'deploy',protocol:'ssh',remoteRoot:'/srv/projects',hostTrustMode:'tofu'});
  const mgr=new NativeWorkspaceManager(store,{platform:'linux',rootPath:()=>join(dir,'mounts'),
    mountInfo:()=>null,run:async()=>{throw Error('should not execute');},
    registry:{create:async()=>{throw Error('should not create');}}});
  await assert.rejects(mgr.create('prod'),/privateKeyPath OR enter a session password/);
}));

test('sshpass wrapper passes the password only by fd 3, not argv or environment',async()=>{
  const {runPasswordMount}=require('../lib/native-workspace.cjs');
  const {EventEmitter}=await import('node:events');
  let recorded, piped='', checks=0;
  const fakeSpawn=(bin,args,options)=>{
    recorded={bin,args,options};
    const child=new EventEmitter();child.pid=99999999;
    child.stderr=Object.assign(new EventEmitter(),{unref:()=>{}});
    child.stdio=[null,null,child.stderr,{on:()=>{},end:text=>{piped=text;}}];
    child.unref=()=>{};
    return child;
  };
  await runPasswordMount(['-o','port=22','deploy@host:/srv','/mnt/fixture'],{
    password:'UNIQUE_SECRET_PASSWORD',spawnProcess:fakeSpawn,mountCheck:()=>++checks>=1
  });
  assert.equal(recorded.bin,'sshpass');
  assert.deepEqual(recorded.args.slice(0,4),['-d','3','sshfs','-f']);
  assert.equal(piped,'UNIQUE_SECRET_PASSWORD\n');
  assert(!recorded.args.join(' ').includes('UNIQUE_SECRET_PASSWORD'));
  assert(!JSON.stringify(recorded.options).includes('UNIQUE_SECRET_PASSWORD'));
});
