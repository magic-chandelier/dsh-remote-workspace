import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { Store } = require('../lib/store.cjs');
const { OperationsManager, parseMonitor, parseProcesses, parseServices,
  processCommand, serviceCommand, MONITOR_COMMAND, PROCESS_COMMAND } = require('../lib/operations.cjs');
const { toolsFor, makeRoute } = require('../lib/server.cjs');

const telemetry = `RW_CPU_A\ncpu 100 0 20 700 100 0 0 0 0 0\nRW_CPU_B\ncpu 120 0 25 745 110 0 0 0 0 0\nRW_UPTIME\n36200.71 10000.00\nRW_LOAD\n0.12 0.80 1.50 2/100 100\nRW_MEMORY\nMemTotal: 8000000 kB\nMemAvailable: 5000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\nRW_DISK\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 102400 30720 71680 30% /\noverlay 200000 100000 100000 50% /var/lib/docker\nRW_NETWORK\nInter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 10240 0 0 0 0 0 0 0 20480 0 0 0 0 0 0 0\nlo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n`;
async function fixture(callback) {
  const dir=mkdtempSync(join(tmpdir(),'rw-ops-'));
  try {
    const store=new Store(join(dir,'connections.json'));
    store.upsert({id:'dev',protocol:'ssh',host:'example.test',port:22,username:'deploy',remoteRoot:'/srv',hostTrustMode:'tofu'});
    store.upsert({id:'ftp',protocol:'ftp',host:'example.test',port:21,username:'deploy',remoteRoot:'/',allowInsecureFtp:true});
    return await callback({dir,store});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('Linux telemetry reports CPU interval percentage, memory, disks, load and network counters',()=>{
  const stats=parseMonitor(telemetry);
  assert.equal(stats.cpuPercent,31.3);
  assert.deepEqual(stats.load,[0.12,0.8,1.5]);
  assert.equal(stats.memory.totalBytes,8000000*1024);
  assert.equal(stats.memory.usedBytes,3000000*1024);
  assert.equal(stats.memory.swapUsedBytes,500000*1024);
  assert.equal(stats.disks[0].usedPercent,30);
  assert.equal(stats.disks[1].mount,'/var/lib/docker');
  assert.deepEqual(stats.interfaces[0],{name:'eth0',rxBytes:10240,txBytes:20480});
  assert(stats.networkCountersSinceBoot);
  assert.throws(()=>parseMonitor('no Linux proc'),/Linux \/proc/);
});
test('process and systemd parsing is bounded and ignores malformed output',()=>{
  const list=parseProcesses(' 102 1 root 12.5 0.3 4096 Ss 02:01 nginx\n 222 102 app 99.9 8.1 12345 R 00:05 node\ninvalid');
  assert.equal(list.length,2);
  assert.equal(list[1].pid,222);assert.equal(list[1].rssBytes,12345*1024);
  const services=parseServices('sshd.service loaded active running OpenSSH Daemon\ncron.service loaded inactive dead Cron\nwrong row');
  assert.equal(services.length,2);assert.equal(services[0].active,'active');
});
test('process and service commands cannot be injected with user-controlled values',()=>{
  assert.equal(processCommand(800,'TERM'),'kill -s TERM -- 800');
  assert.equal(serviceCommand('sshd.service','restart'),'systemctl restart -- sshd.service');
  for (const pid of [1,0,-1,1.1,'55','55;id',NaN]) assert.throws(()=>processCommand(pid,'TERM'),/PID/);
  assert.throws(()=>processCommand(123,'HUP'),/TERM or KILL/);
  for (const unit of ['sshd.service;id','../../etc/passwd.service','abc.service\nwhoami','-h.service']) assert.throws(()=>serviceCommand(unit,'stop'),/service name/);
  assert.throws(()=>serviceCommand('sshd.service','enable'),/systemd action/);
  assert(!MONITOR_COMMAND.includes('sudo'));
  assert(!PROCESS_COMMAND.includes('${'));
});
test('management runner uses SSH identity and rejects FTP and unsuccessful/truncated commands',async()=>fixture(async({store})=>{
  let calls=0;
  const operations=new OperationsManager(store,{runner:async(_store,target,options)=>{
    calls++;assert.equal(target.p.id,'dev');assert.equal(target.cwd,'/srv');assert(options.signal);
    if(target.command.includes('RW_CPU_A'))return {stdout:telemetry,stderr:'',exitCode:0,truncated:false};
    if(target.command.includes('ps -eo'))return {stdout:' 99 1 app 5.0 2.0 1024 S 00:02 node',stderr:'',exitCode:0,truncated:false};
    return {stdout:'',stderr:'',exitCode:0,truncated:false};
  }});
  assert.equal((await operations.monitor('dev')).cpuPercent,31.3);
  assert.equal((await operations.processes('dev')).processes[0].pid,99);
  assert.equal((await operations.signalProcess('dev',99,'TERM')).exitCode,0);
  assert.equal((await operations.controlService('dev','nginx.service','restart')).exitCode,0);
  assert.equal(calls,4);
  await assert.rejects(operations.monitor('ftp'),/SSH\/SFTP/);
  assert.equal(calls,4);
  const failing=new OperationsManager(store,{runner:async()=>({stdout:'',stderr:'permission denied',exitCode:1})});
  await assert.rejects(failing.services('dev'),/permission denied/);
  const truncated=new OperationsManager(store,{runner:async()=>({stdout:'',exitCode:0,truncated:true})});
  await assert.rejects(truncated.processes('dev'),/exceeds safe preview/);
}));
test('authenticated UI mutations require matching confirmation tokens before starting SSH',async()=>fixture(async({store,dir})=>{
  const invoked=[];
  const ops={monitor:async()=>({ok:true}),processes:async()=>({processes:[]}),services:async()=>({services:[]}),
    signalProcess:async(...args)=>{invoked.push(args);return {exitCode:0};},
    controlService:async(...args)=>{invoked.push(args);return {exitCode:0};}};
  const route=makeRoute({store,remote:{},terminal:{},operations:ops,auditFile:join(dir,'audit.jsonl')});
  const post=async data=>{const response=await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}));
    return {status:response.status,body:await response.json()};};
  assert.equal((await post({action:'monitor',id:'dev'})).body.data.ok,true);
  assert.equal((await post({action:'process_signal',id:'dev',pid:99,signal:'TERM'})).body.ok,false);
  assert.equal((await post({action:'service_control',id:'dev',unit:'nginx.service',operation:'restart',confirmation:'wrong'})).body.ok,false);
  assert.equal(invoked.length,0);
  // Deliberately exercise approval envelope without real network (audit path in temp dir).
  assert.equal((await post({action:'process_signal',id:'dev',pid:99,signal:'TERM',confirmation:'SIGNAL_99_TERM'})).body.ok,true);
  assert.equal((await post({action:'service_control',id:'dev',unit:'nginx.service',operation:'restart',confirmation:'SERVICE_restart_nginx.service'})).body.ok,true);
  assert.equal(invoked.length,2);
}));
test('Agent destructive tools fail closed without a real user approval service',async()=>fixture(async({dir,store})=>{
  const operations={signalProcess:async()=>{throw Error('must not execute');},controlService:async()=>{throw Error('must not execute');}};
  const tools=toolsFor({store,remote:{},operations,questions:null,auditFile:join(dir,'audit.jsonl'),native:{rootPath:()=>join(dir,'mounts')},virtual:{rootPath:()=>join(dir,'anchors')}});
  const agent={agent:{session:{}},signal:new AbortController().signal};
  for (const [name,args] of [['remote_process_signal',{profile:'dev',pid:99,signal:'TERM'}],
    ['remote_service_control',{profile:'dev',unit:'nginx.service',action:'restart'}]]) {
    const tool=tools.find(t=>t.name===name);assert(tool);
    await assert.rejects(tool.execute(args,agent),/workingDirectory are required/);
  }
}));
