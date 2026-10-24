import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const root=resolve(import.meta.dirname,'..');
const {Store}=require('../lib/store.cjs');
const {toolsFor,createService,makeRoute}=require('../lib/server.cjs');
const {checkedPath,isTransientConnectionError}=require('../lib/remote.cjs');
function testProfile(id='staging') { return {id,protocol:'sftp',host:'example.internal',port:22,username:'dev',remoteRoot:'/srv',readOnly:true,hostKeySha256:'a'.repeat(64)}; }
test('saved workspaces survive restart, old connection format survives, secrets not persisted',()=>{
  const temp=mkdtempSync(join(tmpdir(),'drw3-'));
  try{
    const db=join(temp,'connections.json');
    writeFileSync(db,JSON.stringify({profiles:[testProfile()],active:'staging',workspaces:{staging:'/srv/app'}}));
    let store=new Store(db);assert.equal(store.workspace('staging'),'/srv/app');
    store.upsert({...testProfile(),password:'SESSION_SECRET'});
    assert(!readFileSync(db,'utf8').includes('SESSION_SECRET'));
    store.setWorkspace('staging','/srv/new');
    store=new Store(db);assert.equal(store.workspace('staging'),'/srv/new');
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('SSH paths remain within selected workspace',()=>{
  assert.equal(checkedPath('/srv/app','src/index.js'),'/srv/app/src/index.js');
  assert.throws(()=>checkedPath('/srv/app','../secrets'),/outside/i);
  assert.throws(()=>checkedPath('/srv/app','/etc/passwd'),/outside/i);
});
test('credential errors must never retry and network errors can retry',()=>{
  assert.equal(isTransientConnectionError(new Error('SSH host key verification failed')),false);
  assert.equal(isTransientConnectionError(Object.assign(new Error('reset'),{code:'ECONNRESET'})),true);
});
test('all 23 tools have valid raw object schemas before defineTool',()=>{
  const temp=mkdtempSync(join(tmpdir(),'drw3-'));
  try{
    const tools=toolsFor(createService({}, {filename:join(temp,'db.json'),remote:{}}));
    assert.equal(tools.length,23);
    assert.equal(new Set(tools.map(t=>t.name)).size,23);
    for(const t of tools){
      assert.equal(t.parameters.type,'object');
      assert.equal(t.output.schema.type,'string');
      for(const [key,field] of Object.entries(t.parameters.properties)){
        assert.equal('required' in field,false,`${t.name}.${key}: must not contain required`);
      }
    }
    assert.equal(tools.find(t=>t.name==='remote_list').parameters.required,undefined);
    assert.deepEqual(tools.find(t=>t.name==='remote_connect_test').parameters.required,['profile']);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('API route handles restored workspace through authenticated connection registry contract',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'drw3-'));
  try{
    const store=new Store(join(temp,'db.json'));
    store.upsert(testProfile());store.setWorkspace('staging','/srv/app');
    const remote={
      list:async(id,dir,browse)=>({profile:id,directory:dir,workspace:store.workspace(id),entries:[{name:'src',type:'directory'}]}),
      select:async(id,target)=>store.setWorkspace(id,target),
    };
    const route=makeRoute({store,remote,localRoot:temp});
    const request=action=>new Request('http://localhost/api/dsh-remote-workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
    const status=await route.fetch(request({action:'list'}));assert.equal(status.status,200);
    assert.equal((await status.json()).data.active,'staging');
    const chosen=await route.fetch(request({action:'browse',id:'staging',path:'/srv/app'}));
    assert.equal((await chosen.json()).data.directory,'/srv/app');
    const select=await route.fetch(request({action:'select',id:'staging',path:'/srv/new'}));
    assert.equal((await select.json()).data.workspace,'/srv/new');
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('client artifact uses official lazy-CJS loader and slots, without forbidden HTML injection',()=>{
  const text=readFileSync(join(root,'lib/client.js'),'utf8');
  assert(text.startsWith('window.__ModuleLoader__.load('));
  const registrations=[];
  const React={
    createElement:(type,props,...children)=>({type,props,children}),
    useState:value=>[value,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),useCallback:f=>f,
  };
  const context={
    window:{__ModuleLoader__:{load:value=>registrations.push(value)}},
    console,fetch:()=>Promise.reject(new Error('no network')),setTimeout,clearTimeout,
  };
  vm.runInNewContext(text,context);
  assert.equal(registrations.length,1);
  assert.equal(registrations[0].id,'dsh-remote-workspace');
  const slots=[];
  const injected=[];
  const mod=registrations[0].factory(name=>{
    assert.equal(name,'react');return React;
  });
  assert.deepEqual(Array.from(mod.inject),['slots']);
  mod.apply({slots:{inject:(key,fn)=>{injected.push(key);fn();},register:(options,Component)=>{slots.push({options,Component});return ()=>{};}}});
  assert.deepEqual(injected,['sidebar.panellist','main']);
  assert.equal(slots[0].options.id,'remote-workspace');
  assert.equal(slots[1].options.key,'remote-workspace');
  const rendered=slots[1].Component({});
  assert.equal(rendered.type,'div');
  assert.equal(rendered.props.className,'dr3-root');
  assert(!text.includes('tapIndex('));
});
test('UI manifest keeps Host patch and exposes Web client boot metadata',()=>{
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(manifest.dsh.bundle.patch,'./cordis.patch.yml');
  assert.deepEqual(manifest.dsh.client, { platform: 'web' });
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert(manifest.files.includes('lib/client.js'));
  assert(existsSync(join(root,'lib/index.js')));
  assert(existsSync(join(root,'lib/client.js')));
  assert(existsSync(join(root,'cordis.patch.yml')));
});
test('ESM Host entry imports and registers 23 defineTool tools through Cordis-style context', async()=>{
  const temp=mkdtempSync(join(tmpdir(),'drw3-host-'));
  try {
    const pkg=join(temp,'app');mkdirSync(join(pkg,'lib'),{recursive:true});
    for(const file of ['index.js','server.cjs','store.cjs','credential-vault.cjs','remote.cjs','terminal.cjs','binding.cjs','binding-api.cjs','binding-tools.cjs','binding-approval.cjs','binding-remote.cjs','binding-compare.cjs','native-workspace.cjs','virtual-workspace.cjs','remote-guard.cjs','remote-shell.cjs','remote-context.cjs','operations.cjs','audit.cjs','cleanup.cjs','data-dir.cjs','connection-gate.cjs','agent-scope.cjs','binding-trust.cjs','transfer-sessions.cjs']){
      writeFileSync(join(pkg,'lib',file),readFileSync(join(root,'lib',file)));
    }
    writeFileSync(join(pkg,'package.json'),JSON.stringify({type:'module'}));
    for(const id of ['dsh-tools','schemastery']) {
      const d=join(pkg,'node_modules','@deepseek-ai',id);mkdirSync(d,{recursive:true});
      writeFileSync(join(d,'package.json'),JSON.stringify({type:'module',exports:'./index.js'}));
      if(id==='dsh-tools')writeFileSync(join(d,'index.js'),`export const defineTool = value => { if(!value.parameters || typeof value.execute!=='function') throw new Error('invalid tool');return {...value,defined:true}; };`);
      else writeFileSync(join(d,'index.js'),`export default {object:(v)=>({fields:v}),string:()=>({default:v=>({value:v})})};`);
    }
    const {apply,Config,officialToolDefinitions,inject}=await import('file://'+join(pkg,'lib','index.js'));
    assert.deepEqual(inject,['tools']);
    assert('localRoot' in Config.fields);
    const tools=[], routes=[];
    const ctx={
      tools:{register:tool=>tools.push(tool)},
      inject:(deps,fn)=>{
        if (deps[0] !== 'connection') return;
        const child={connection:{fetch:{register:route=>{routes.push(route);return ()=>{};}}},effect:fn=>fn()};
        fn(child);
      },
    };
    apply(ctx,{});
    assert.equal(tools.length,23);
    assert(tools.every(t=>t.defined===true));
    assert.equal(routes.length,1);
    assert.equal(routes[0].path,'/api/dsh-remote-workspace');
    const read=tools.find(t=>t.name==='remote_read');
    assert.equal(read.parameters.path.required,true);
    assert.equal('required' in read.parameters.profile,false);
    // A missing or broken optional Desktop connection service must not fail the Host tool tree.
    let registered=0;
    assert.doesNotThrow(()=>apply({tools:{register:()=>registered++},inject:()=>{throw new Error('optional connection unavailable');}},{}));
    assert.equal(registered,23);
    registered=0;
    const brokenRouteContext={tools:{register:()=>registered++},inject:(_deps,callback)=>{ if (_deps[0] !== 'connection') return; callback({
      connection:{fetch:{register:()=>{throw new Error('route conflict');}}},effect:(factory)=>factory()
    }); }};
    assert.doesNotThrow(()=>apply(brokenRouteContext,{}));
    assert.equal(registered,23);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
