import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { Store } = require('../lib/store.cjs');
const { RemoteManager, checkedPath } = require('../lib/remote.cjs');
const { makeRoute, createService, toolsFor, readLimitedJson } = require('../lib/server.cjs');
function profile(root='/srv') {
  return { id:'qa', protocol:'sftp', host:'localhost',port:22, username:'test',remoteRoot:root, readOnly:true, hostKeySha256:'a'.repeat(64) };
}
function withTemp(fn) {
  const directory = mkdtempSync(join(tmpdir(),'dsh031-'));
  try { return fn(directory); } finally {rmSync(directory,{force:true,recursive:true});}
}
test('malformed persisted connections never crash loader or destroy original bytes',()=>withTemp(dir=>{
  const file = join(dir,'connections.json');
  const raw = '{corrupted-v0.3'; writeFileSync(file,raw);
  const db = new Store(file);
  assert.ok(db.loadError);
  assert.deepEqual(db.list(),[]);
  assert.throws(()=>db.upsert(profile()),/Cannot read connections/);
  assert.equal(readFileSync(file,'utf8'),raw);
}));
test('new remoteRoot invalidates stale persisted workspace',()=>withTemp(dir=>{
  const db = new Store(join(dir,'connections.json'));
  db.upsert(profile('/srv')); db.setWorkspace('qa','/srv/app');
  db.upsert(profile('/opt'));
  assert.equal(db.workspace('qa'),'/opt');
  assert.equal(db.workspaces.has('qa'),false);
  assert.equal(new Store(join(dir,'connections.json')).workspace('qa'),'/opt');
}));
test('workspace path rejects sibling prefix, empty segments, and traversal',()=>{
  assert.throws(()=>checkedPath('/srv/app','../application/secrets'),/outside/);
  assert.throws(()=>checkedPath('/srv/app','/etc/passwd'),/outside/);
  assert.equal(checkedPath('/srv/app','lib/./config'),'/srv/app/lib/config');
});
test('download refuses existing local destination without making a network connection',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dshdl-'));
  try {
    const db=new Store(join(directory,'connections.json'));
    db.upsert(profile());db.setWorkspace('qa','/srv');
    const filename=join(directory,'keep.txt');writeFileSync(filename,'valuable');
    const remote=new RemoteManager(db,{localRoot:directory});
    await assert.rejects(remote.transfer('qa','example.txt','keep.txt','download'),/already exists/);
    assert.equal(readFileSync(filename,'utf8'),'valuable');
    assert.deepEqual(require('node:fs').readdirSync(directory).filter(x=>x.includes('.partial-')),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('API request body is bounded even if Content-Length header is absent or lies', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dshreq-'));
  const store=new Store(join(dir,'db.json'));
  const route=makeRoute({store,remote:{},localRoot:dir});
  const payload=JSON.stringify({action:'save',profile:{...profile(),padding:'x'.repeat(1024*1024)}});
  const req=new Request('http://localhost/api/dsh-remote-workspace',{method:'POST', headers:{'content-type':'application/json','content-length':'3'},body:payload});
  const res=await route.fetch(req);
  assert.equal(res.status,413);
  assert.equal((await res.json()).error,'Request too large');
  rmSync(dir,{force:true,recursive:true});
});
test('limited JSON reader parses small requests and rejects invalid JSON',async()=>{
  const send=x=>new Request('http://localhost',{method:'POST',body:x});
  assert.deepEqual(await readLimitedJson(send('{"hello":123}')),{hello:123});
  await assert.rejects(readLimitedJson(send('{bad')),SyntaxError);
});
test('main-UI manifest declares client boot registration and Host patch metadata',()=>{
  const manifest=require('../package.json');
  assert.deepEqual(manifest.dsh.client,{platform:'web'});
  assert.equal(manifest.exports['./client'],'./lib/client.js');
  assert(manifest.files.includes('lib/client.js'));
  assert.equal(manifest.dsh.bundle.patch,'./cordis.patch.yml');
  assert.match(manifest.version,/^0\.5\.26-safe\.1$/);
});
test('all 23 tool definitions use string output, unique names and typed arguments',()=>withTemp(dir=>{
  const tools=toolsFor(createService({}, {filename:join(dir,'db.json'),remote:{}}));
  assert.equal(tools.length,23);
  assert.equal(new Set(tools.map(x=>x.name)).size,23);
  for (const tool of tools) {
    assert.equal(tool.output.schema.type,'string');
    assert.equal(tool.parameters.type,'object');
    assert.ok(Object.keys(tool.parameters.properties).every(k=>!('required' in tool.parameters.properties[k])));
  }
}));

test('Host guard is actually imported before installation of tools/pre-execute handler',()=>{
  const source=readFileSync(new URL('../lib/index.js',import.meta.url),'utf8');
  assert.match(source, /const \{ remoteToolGuard \} = require\('\.\/remote-guard\.cjs'\)/);
  assert.match(source, /ctx\.on\('tools\/pre-execute', \(exec,next\) => remoteToolGuard\(service,exec,next\)\)/);
});
