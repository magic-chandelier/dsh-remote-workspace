import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const {workspaceProfileForCwd, shellGuardedWorkspace,resolveAgentProfile}=require('../lib/remote-context.cjs');
const {logAudit, commandHash}=require('../lib/audit.cjs');
const fakeStore = {list:()=>[{id:'prod',protocol:'ssh'},{id:'dev',protocol:'sftp'}],profile:id=>({id})};
const root=join(tmpdir(),'dsh-agent-context-test','remote-workspace','mounts');
test('native cwd resolves its own remote profile and refuses cross-server agent command',async()=>{
  assert.equal(workspaceProfileForCwd(fakeStore,join(root,'prod'),root),'prod');
  assert.equal(workspaceProfileForCwd(fakeStore,join(root,'prod','src'),root),'prod');
  assert.equal(workspaceProfileForCwd(fakeStore,join(root,'production'),root),null);
  const service={store:fakeStore,native:{rootPath:()=>root},virtual:{rootPath:()=>join(root,'virtual')},workingDirectory:{ensure:async()=>join(root,'dev','src')}};
  const exec={agent:{},signal:new AbortController().signal};
  assert.equal(await resolveAgentProfile(service,undefined,exec,{skipConnection:true}),'dev');
  await assert.rejects(resolveAgentProfile(service,'prod',exec),/belongs to dev/);
  assert.equal(shellGuardedWorkspace({arguments:{workdir:join(root,'prod')}},fakeStore,root),'prod');
});
test('SSH audit log does not persist actual command, stays private',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-ssh-audit-'));
  try{
    const file=join(dir,'audit.jsonl');
    const command='echo very-secret-token';
    logAudit({state:'approved',commandSha256:commandHash(command)},file);
    const contents=readFileSync(file,'utf8');
    assert(!contents.includes('very-secret-token'));
    assert.equal(JSON.parse(contents).state,'approved');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
