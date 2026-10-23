import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {TransferSessions,CHUNK_BYTES,MAX_BYTES}=require('../lib/transfer-sessions.cjs');
const {RemoteManager}=require('../lib/remote.cjs');
const {makeRoute,createService}=require('../lib/server.cjs');
const {Store}=require('../lib/store.cjs');

async function fixture(protocol, fn) {
  const dir=mkdtempSync(join(tmpdir(),'dsh-rw-transfer-test-'));
  const saved=new Map();
  const profile={id:'x',protocol,host:'example.test',port:protocol==='ftp'?21:22,username:'test',remoteRoot:'/home/test',readOnly:false};
  const store={profile:id=>{if(id!=='x')throw Error('Unknown connection');return profile;},workspace:()=>'/home/test',sessionPasswords:new Map()};
  const client={
    exists:async name=>saved.has(name),
    list:async base=>[...saved].filter(([p])=>p.startsWith(base+'/')).map(([p,v])=>({name:p.split('/').at(-1),size:v.length})),
    put:async (src,dst)=>saved.set(dst,readFileSync(src)),
    uploadFrom:async (src,dst)=>saved.set(dst,readFileSync(src)),
    rename:async (a,b)=>{if(!saved.has(a))throw Error('missing staging file');saved.set(b,saved.get(a));saved.delete(a);},
    delete:async p=>saved.delete(p),remove:async p=>saved.delete(p),
    stat:async p=>({size:saved.get(p)?.length||0,isDirectory:false}),
    get:async (p,out)=>{out.end(saved.get(p));},
    downloadTo:async (out,p)=>{out.end(saved.get(p));},
    size:async p=>saved.get(p)?.length||0,
  };
  const remote=new RemoteManager(store,{connect:async(_p,_store,callback)=>callback({kind:protocol==='sftp'?'sftp':'ftp',client})});
  // For this test harness, SFTP realPath resolves every path unchanged.
  client.realPath=async p=>p;
  const xfers=new TransferSessions(remote,dir);
  try{await fn({xfers,remote,saved,profile,dir});}finally{xfers.dispose();rmSync(dir,{recursive:true,force:true});}
}
for(const protocol of ['sftp','ftp','ftps']) {
  test(`${protocol} uploads binary file in chunks, downloads exact bytes and deletes staging files`,async()=>fixture(protocol,async({xfers,saved,dir})=>{
    const payload=Buffer.alloc(CHUNK_BYTES+733,0x9d);payload[17]=0;payload[CHUNK_BYTES]=1;
    const start=xfers.beginUpload('x','sample.bin',payload.length);
    assert.equal(start.chunkBytes,CHUNK_BYTES);
    await assert.rejects(async()=>xfers.appendUpload('wrong',start.token,0,Buffer.from('foo').toString('base64')),/another connection/);
    const encoded=payload.subarray(0,CHUNK_BYTES).toString('base64');
    xfers.appendUpload('x',start.token,0,encoded);
    assert.throws(()=>xfers.appendUpload('x',start.token,0,encoded),/out-of-order/);
    xfers.appendUpload('x',start.token,1,payload.subarray(CHUNK_BYTES).toString('base64'));
    await xfers.finishUpload('x',start.token);
    assert.deepEqual(saved.get('/home/test/sample.bin'),payload);
    assert.equal(readdirSync(join(dir,'transfer-cache')).length,0);
    const download=await xfers.beginDownload('x','sample.bin');
    const parts=[];
    for(let i=0;i<Math.ceil(payload.length/CHUNK_BYTES);i++){
      const part=xfers.downloadChunk('x',download.token,i);
      parts.push(Buffer.from(part.contentBase64,'base64'));
    }
    assert.deepEqual(Buffer.concat(parts),payload);
    xfers.cancel('x',download.token);
    assert.equal(readdirSync(join(dir,'transfer-cache')).length,0);
    await assert.rejects(xfers.finishUpload('x',start.token),/not found/);
  }));
}
test('rejects read-only upload, oversized file and duplicate destination',async()=>fixture('sftp',async({xfers,saved,profile})=>{
  profile.readOnly=true;
  assert.throws(()=>xfers.beginUpload('x','file.bin',2),/read-only/);
  profile.readOnly=false;
  assert.throws(()=>xfers.beginUpload('x','large.bin',MAX_BYTES+1),/128 MiB/);
  const init=xfers.beginUpload('x','same.bin',2);
  xfers.appendUpload('x',init.token,0,Buffer.from('ok').toString('base64'));
  saved.set('/home/test/same.bin',Buffer.from('original'));
  await assert.rejects(xfers.finishUpload('x',init.token),/already exists/);
  assert.equal(saved.get('/home/test/same.bin').toString(),'original');
}));
test('changing connection or workspace invalidates an active transfer',()=>fixture('ftp',async({xfers,profile})=>{
  const init=xfers.beginUpload('x','a.txt',12);
  profile.host='other.example.test';
  assert.throws(()=>xfers.appendUpload('x',init.token,0,Buffer.from('hey').toString('base64')),/changed/);
  assert.equal(xfers.sessions.size,0);
}));
test('rejects misordered download and cleans canceled transfers',()=>fixture('ftp',async({xfers,saved,dir})=>{
  saved.set('/home/test/a.bin',Buffer.from('data'));
  const started=await xfers.beginDownload('x','a.bin');
  assert.throws(()=>xfers.downloadChunk('x',started.token,1),/out of order/);
  xfers.dispose();
  assert.equal(readdirSync(join(dir,'transfer-cache')).length,0);
  assert.throws(()=>xfers.beginUpload('x','file',2),/no longer available/);
}));
test('route dispatches transfer actions using existing authenticated JSON endpoint',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-rw-route-'));
  try{
    const service=createService({}, {filename:join(dir,'connections.json'),remote:{
      context:(id,p)=>({p:{id,protocol:'ftp',host:'localhost',port:21,username:'test',remoteRoot:'/',readOnly:false},base:'/',target:p}),
      uploadStaged:async (id,p,file)=>({uploaded:p,bytes:statSync(file).size}),
    }});
    const route=makeRoute(service);
    const call=async body=>{
      const request=new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const response=await route.fetch(request);
      return {status:response.status,...await response.json()};
    };
    const init=await call({action:'transfer_upload_begin',id:'x',path:'test.txt',bytes:5});
    assert.equal(init.ok,true);
    const chunk=await call({action:'transfer_upload_chunk',id:'x',token:init.data.token,index:0,contentBase64:Buffer.from('hello').toString('base64')});
    assert.equal(chunk.data.received,5);
    const done=await call({action:'transfer_upload_finish',id:'x',token:init.data.token});
    assert.equal(done.data.bytes,5);
    service.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('async download exposes a token immediately and honors cancellation during remote fetch',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dsh-download-cancel-'));
  let resolveRemote;
  let canceled;
  const remote={
    context:(id,where)=>({p:{id,protocol:'ftp',host:'localhost',port:21,username:'x',remoteRoot:'/',readOnly:false},base:'/',target:where}),
    downloadStaged:async(_id,_path,target,_limit,options)=>{
      canceled=options.isCanceled;
      await new Promise(resolve=>{resolveRemote=resolve;});
      writeFileSync(target,'secret');return 6;
    },
  };
  const xfers=new TransferSessions(remote,directory);
  try {
    const start=xfers.startDownload('x','secret.txt');
    assert.equal(typeof start.token,'string');
    assert.deepEqual(xfers.downloadStatus('x',start.token),{ready:false,bytes:null});
    await new Promise(resolve=>setImmediate(resolve));
    const cancelled=xfers.cancel('x',start.token);
    assert.equal(cancelled.pending,true);
    assert.equal(canceled(),true);
    resolveRemote();
    await xfers.sessions.get(start.token).downloadPromise;
    assert.equal(xfers.sessions.size,0);
    assert.deepEqual(readdirSync(join(directory,'transfer-cache')),[]);
  } finally {xfers.dispose();rmSync(directory,{recursive:true,force:true});}
});
test('async download reports remote error and removes its staged file',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dsh-download-failure-'));
  const remote={context:id=>({p:{id,protocol:'ftp',host:'localhost',port:21,username:'x',remoteRoot:'/',readOnly:false},base:'/'}),downloadStaged:async()=>{throw Error('Network dropped');}};
  const xfers=new TransferSessions(remote,directory);
  try {
    const start=xfers.startDownload('x','abc.txt');
    await xfers.sessions.get(start.token).downloadPromise;
    assert.throws(()=>xfers.downloadStatus('x',start.token),/Network dropped/);
    assert.equal(xfers.sessions.size,0);
  } finally {xfers.dispose();rmSync(directory,{recursive:true,force:true});}
});
