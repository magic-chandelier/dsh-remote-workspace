import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createService, makeRoute } = require('../lib/server.cjs');
const { handleBindingApi } = require('../lib/binding-api.cjs');
const { relativeFile, compareBoundFile } = require('../lib/binding-compare.cjs');
const { RemoteManager } = require('../lib/remote.cjs');
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh051-'));
  t.after(() => rmSync(tmp, { recursive:true, force:true }));
  const project = join(tmp, 'local'); mkdirSync(project);
  const service = createService({}, { filename:join(tmp, 'db.json') });
  service.store.upsert({ id:'project', host:'example.test', username:'dev', protocol:'sftp', remoteRoot:'/srv', readOnly:false });
  service.store.upsert({ id:'ftp', host:'example.test', username:'dev', protocol:'ftp', remoteRoot:'/srv', readOnly:true });
  service.bindingRegistry = { list:() => [{ id:'A', path:project }], get:id => id==='A' ? {id:'A',path:project} : null };
  const save = () => handleBindingApi(service, {action:'binding_save',workspaceId:'A',connectionId:'project',remotePath:'/srv/a',confirmation:'BIND_THIS_WORKSPACE'});
  return { tmp, project, service, save };
}
test('binding rejects FTP/FTPS because real remote symlink isolation is unavailable', async t => {
  const { service } = fixture(t);
  await assert.rejects(handleBindingApi(service,{action:'binding_save',workspaceId:'A',connectionId:'ftp',remotePath:'/srv/a',confirmation:'BIND_THIS_WORKSPACE'}), /requires SSH\/SFTP/);
});
test('compare path rejects traversal, secret files, absolute paths and generated binding metadata', () => {
  for (const input of ['../etc/passwd','/etc/passwd','a//b','a/./b','a/../b','src\\index.js','.env','.env.production','.git/config','key.pem','.harness-remote.json','node_modules/mod.js','credentials'])
    assert.throws(()=>relativeFile(input), /path|Sensitive|traversal/i, input);
  assert.equal(relativeFile('src/entry.ts'), 'src/entry.ts');
});
test('read-only compare returns hashes and limited line previews, without touching global active state', async t => {
  const { project, service, save } = fixture(t);
  mkdirSync(join(project,'src')); writeFileSync(join(project,'src','x.txt'),'hello\nLOCAL\n');
  await save();
  const remoteText = 'hello\nREMOTE\n';
  let seen;
  service.boundRemoteFactory = scopedStore => {
    seen = scopedStore;
    return { read:async (id, rel) => {
      assert.equal(id, 'project'); assert.equal(rel, 'src/x.txt');
      return { content:remoteText,sha256:sha(remoteText), bytes:Buffer.byteLength(remoteText) };
    } };
  };
  const result = await compareBoundFile(service,project,'src/x.txt');
  assert.equal(result.status,'different');
  assert.equal(result.local.sha256,sha('hello\nLOCAL\n'));
  assert.equal(result.remote.sha256,sha(remoteText));
  assert.deepEqual(result.differences,[{line:2,local:'LOCAL',remote:'REMOTE'}]);
  assert.equal(seen.workspace('project'),'/srv/a');
  assert.equal(service.store.active,'');
  assert.equal(result.readOnly,true);
  assert.equal(readFileSync(join(project,'src','x.txt'),'utf8'),'hello\nLOCAL\n');
});
test('compare handles identical, local missing, remote missing and missing both',async t => {
  const { project, service, save }=fixture(t);await save();
  writeFileSync(join(project,'same.txt'),'x');
  service.boundRemoteFactory=()=>({read:async(_id, rel)=>{
    if(rel==='same.txt')return {content:'x',sha256:sha('x'),bytes:1};
    if(rel==='remote-only.txt')return {content:'y',sha256:sha('y'),bytes:1};
    throw Object.assign(new Error('not found'),{code:'ENOENT'});
  }});
  assert.equal((await compareBoundFile(service,project,'same.txt')).status,'identical');
  assert.equal((await compareBoundFile(service,project,'remote-only.txt')).status,'local_missing');
  writeFileSync(join(project,'local-only.txt'),'z');
  assert.equal((await compareBoundFile(service,project,'local-only.txt')).status,'remote_missing');
  assert.equal((await compareBoundFile(service,project,'none.txt')).status,'both_missing');
});
test('local compare refuses nested symlink and oversized file',async t => {
  const { project, service, save, tmp }=fixture(t);await save();
  mkdirSync(join(project,'src'));writeFileSync(join(tmp,'outside.txt'),'private');
  try { symlinkSync(tmp,join(project,'escape'),'dir'); }
  catch (e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) {t.skip('symlink creation restricted');return;} throw e; }
  service.boundRemoteFactory=()=>({read:async()=>{throw Error('Remote access must not occur for unsafe local symlink');}});
  await assert.rejects(compareBoundFile(service,project,'escape/outside.txt'),/symlinks/);
  writeFileSync(join(project,'big.txt'),'a'.repeat(1024*1024+1));
  await assert.rejects(compareBoundFile(service,project,'big.txt'),/1 MiB/);
});
test('binding_compare HTTP action uses registered workspace ID, never accepts client localPath override',async t => {
  const { project, service, save }=fixture(t);await save();
  writeFileSync(join(project,'a.txt'),'ok');
  service.boundRemoteFactory=()=>({read:async()=>({content:'ok',sha256:sha('ok'),bytes:2})});
  const route=makeRoute(service);
  const send=async body => (await route.fetch(new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',body:JSON.stringify(body)}))).json();
  const ok=await send({action:'binding_compare',workspaceId:'A',path:'a.txt',localPath:'/etc/passwd'});
  assert.equal(ok.data.status,'identical');
  const invalid=await send({action:'binding_compare',workspaceId:'invalid',path:'a.txt',localPath:project});
  assert.equal(invalid.ok,false);
});
class FakeSftp {
  constructor(mapping) { this.mapping=mapping;this.readCount=0;this.writeCount=0; }
  async realPath(p) { return this.mapping[p] || p; }
  async list() { this.readCount++;return [{name:'hello.txt',type:'-',size:1}]; }
  async stat() { return {size:1}; }
  async get() { this.readCount++;return Buffer.from('x'); }
  async put() { this.writeCount++; }
}
test('scoped SFTP rejects symlink escaping bound directory even inside server root (read/write)',async t=>{
  const { service }=fixture(t);
  const store=Object.create(service.store);
  store.workspace=id=>id==='project'?'/srv/a':service.store.workspace(id);
  const fake=new FakeSftp({'/srv/a/out':'/srv/other','/srv/a/out/file.txt':'/srv/other/file.txt'});
  const manager=new RemoteManager(store,{connect:async (_p,_db,fn)=>fn({kind:'sftp',client:fake})});
  await assert.rejects(manager.read('project','out/file.txt'),/Symbolic link escapes/);
  await assert.rejects(manager.write('project','out/file.txt','y',''),/Symbolic link escapes/);
  assert.equal(fake.readCount,0);assert.equal(fake.writeCount,0);
});
test('scoped SFTP rejects binding root symlink escaping configured server root', async t=>{
  const { service }=fixture(t);
  const store=Object.create(service.store);store.workspace=()=>'/srv/link';
  const fake=new FakeSftp({'/srv/link':'/etc/secret'});
  const manager=new RemoteManager(store,{connect:async(_p,_db,fn)=>fn({kind:'sftp',client:fake})});
  await assert.rejects(manager.list('project','.'),/Symbolic link escapes/);
  assert.equal(fake.readCount,0);
});
