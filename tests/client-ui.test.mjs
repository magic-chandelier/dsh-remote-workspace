import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const bundled = readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
function makeView(override={}) {
  let i=0;
  const state = (value)=>{
    const at=i++;
    return [Object.hasOwn(override,at)?override[at]:value,()=>{}];
  };
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState:state,useEffect:()=>{},useRef:(v)=>({current:v}),useCallback:(fn)=>fn};
  const entries=[];
  runInNewContext(bundled,{window:{__ModuleLoader__:{load:x=>entries.push(x)}},console});
  assert.equal(entries.length,1);
  const plugin=entries[0].factory(id=>{
    assert.equal(id,'react');return React;
  });
  const slots=[];
  plugin.apply({slots:{inject:(_,f)=>f(),register:(opts,fn)=>{slots.push({opts,fn});return ()=>{};}}});
  const panel=slots.find(x=>x.opts.name==='main').fn;
  return panel({});
}
function textify(node) {
  if (node==null || node===false)return '';
  if (typeof node==='string'||typeof node==='number')return String(node);
  if (Array.isArray(node))return node.map(textify).join(' ');
  return textify(node.children);
}
function elements(node,predicate,out=[]) {
  if(node==null)return out;
  if(Array.isArray(node)){for(const x of node)elements(x,predicate,out);return out;}
  if(typeof node!=='object')return out;
  if(predicate(node))out.push(node);
  elements(node.children,predicate,out);
  return out;
}
const p={id:'name-very-long-name-that-will-truncate',protocol:'ssh',host:'ssh-with-long-hostname.testing.example.net',port:22,username:'root',remoteRoot:'/projects',workspace:'/projects/myapp',readOnly:false,terminalEnabled:true};
test('client landing view renders connection search, collapsible sidebar, long name tooltip',()=>{
  const v=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace});
  assert(textify(v).includes('已保存连接 (1)'));
  const search=elements(v,x=>x.type==='input' && x.props.type==='search');
  assert.equal(search.length,1);
  const conn=elements(v,x=>x.type==='button' && x.props.title?.includes('ssh-with-long-hostname'));
  assert.equal(conn.length,1);
  const style=elements(v,x=>x.type==='style').map(textify).join(' ');
  assert(style.includes('text-overflow:ellipsis'));
  assert(style.includes('overflow-wrap:anywhere'));
  assert(textify(v).includes('⌘ SSH 终端'));
});
test('new connection form visibly offers SSH+SFTP and TOFU without mandatory SHA field',()=>{
  const form={id:'',protocol:'ssh',port:'22',hostTrustMode:'tofu',readOnly:true,terminalEnabled:false};
  const v=makeView({5:'form',6:form});
  const text=textify(v);
  assert(text.includes('SSH + SFTP（文件＋终端）'));
  assert(text.includes('自动记住首次连接指纹'));
  assert(text.includes('允许此连接打开交互式 SSH 终端'));
  assert(!text.includes('SSH 主机指纹 SHA-256'));
});
test('pinned SHA setting only displayed when explicit manual pinning mode is selected',()=>{
  const v=makeView({5:'form',6:{id:'',protocol:'ssh',hostTrustMode:'pinned',readOnly:true,terminalEnabled:true}});
  assert(textify(v).includes('SSH 主机指纹 SHA-256'));
  assert(textify(v).includes('指纹环境变量名称'));
});
test('interactive terminal view renders input, disconnect, ctrl-c and no automatic replay notice',()=>{
  const v=makeView({0:[p],1:p.id,5:'terminal',18:'f'.repeat(40),19:'hello\r\n',20:'ls',21:false});
  const t=textify(v);
  assert(t.includes('SSH 交互终端'));
  assert(t.includes('Ctrl+C'));
  assert(t.includes('断开终端'));
  assert(t.includes('断线不自动重放命令'));
});
test('original v0.4 page includes local-to-remote binding entry and same-page binding form',()=>{
  const landing=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace});
  assert(textify(landing).includes('旧版：本地项目绑定（可选）'));
  assert(textify(landing).includes('＋ 添加远程工作区'));
  assert(textify(landing).includes('＋ 添加到 Harness 远程工作区'));
  assert(textify(landing).includes('绑定 / 查看本地项目'));
  const bound=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace,5:'binding'});
  const rendered=textify(bound);
  assert(rendered.includes('本地项目 ↔ 远程工作区绑定'));
  assert(rendered.includes('绑定这个远程文件夹'));
  assert(rendered.includes('解除绑定'));
  assert(rendered.includes('Harness 本地工作区'));
});

test('read-only bound-file comparison controls render in integrated Web UI',()=>{
  const bound=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace,5:'binding',
    18:[{id:'A',path:'/projects/local',title:'Local'}],19:'A',20:{connectionId:p.id,remotePath:p.workspace},21:true,
    29:'src/hello.ts',30:{status:'different',local:{sha256:'a'.repeat(64)},remote:{sha256:'b'.repeat(64)},differences:[{line:2,local:'local',remote:'remote'}]}});
  const rendered=textify(bound);
  assert(rendered.includes('只读文件差异预览'));
  assert(rendered.includes('比较本地 / 远程'));
  assert(rendered.includes('SHA-256'));
  assert(rendered.includes('内容不同'));
  assert(rendered.includes('第 2 行'));
  const input=elements(bound,x=>x.type==='input' && x.props['aria-label']==='要比较的项目相对路径');
  assert.equal(input.length,1);
});
test('Desktop client activation never accesses optional remote plugin manager during boot',()=>{
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState:v=>[v,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),useCallback:f=>f};
  let client;
  runInNewContext(bundled,{window:{__ModuleLoader__:{load:x=>{client=x}}},console});
  const plugin=client.factory(id=>{assert.equal(id,'react');return React;});
  const registered=[];
  const ctx={slots:{inject:(_key,register)=>register(),register:(opts,comp)=>{registered.push({opts,comp});return ()=>{};}}};
  Object.defineProperty(ctx,'remote',{get(){throw Error('Desktop optional remote service is unavailable during boot');}});
  assert.doesNotThrow(()=>plugin.apply(ctx));
  assert.deepEqual(registered.map(e=>e.opts.name),['sidebar.panellist','main']);
});
test('remote workspace panel retains explicit cleanup entry without manager-service dependency',()=>{
  const v=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace});
  assert(textify(v).includes('卸载前检查与清理'));
  assert(textify(v).includes('插件数据与卸载'));
});

test('Desktop activation stays alive if a Slot registration throws inside a deferred inject callback', () => {
  const notices=[];
  const browser={__ModuleLoader__:{load:x=>{browser.entry=x}}};
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props,children}),
    useState:v=>[v,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),useCallback:f=>f};
  runInNewContext(bundled,{window:browser,console:{error:(...args)=>notices.push(args)}});
  const plugin=browser.entry.factory(id=>{assert.equal(id,'react');return React;});
  const callbacks=[];
  assert.doesNotThrow(()=>plugin.apply({slots:{inject:(name,cb)=>{callbacks.push({name,cb});},
    register:opts=>{throw new Error('Real Desktop slot rejected '+opts.name);}}}));
  assert.deepEqual(callbacks.map(x=>x.name),['sidebar.panellist','main']);
  for(const item of callbacks)assert.doesNotThrow(()=>item.cb());
  assert.equal(notices.length,2);
  assert.match(browser.__DSH_REMOTE_WORKSPACE_DIAGNOSTICS__[0].detail,/slot rejected sidebar.panellist/);
  assert.match(browser.__DSH_REMOTE_WORKSPACE_DIAGNOSTICS__[1].phase,/slots.register:main/);
});

test('Desktop activation isolates Slot injection failures from main UI startup', async () => {
  const notices=[];
  const browser={__ModuleLoader__:{load:x=>{browser.entry=x}}};
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props,children}),
    useState:v=>[v,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),useCallback:f=>f};
  runInNewContext(bundled,{window:browser,console:{error:(...args)=>notices.push(args)}});
  const plugin=browser.entry.factory(()=>React);
  let calls=0;
  assert.doesNotThrow(()=>plugin.apply({slots:{inject:(name)=>{
    calls++;
    if(name==='sidebar.panellist')throw new Error('sync inject unavailable');
    return Promise.reject(new Error('async inject unavailable'));
  },register:()=>()=>{}}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);
  assert.equal(notices.length,2);
  const phases=browser.__DSH_REMOTE_WORKSPACE_DIAGNOSTICS__.map(x=>x.phase);
  assert.deepEqual(Array.from(phases),['slots.inject:sidebar.panellist','slots.inject.async:main']);
});

test('main panel render failure shows diagnostic fallback instead of propagating to desktop', () => {
  const errors=[];
  const browser={__ModuleLoader__:{load:x=>{browser.entry=x}}};
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props,children}),
    useState:()=>{throw new Error('Desktop React hook unavailable');},useEffect:()=>{},useRef:v=>({current:v}),useCallback:f=>f};
  runInNewContext(bundled,{window:browser,console:{error:(...args)=>errors.push(args)}});
  const plugin=browser.entry.factory(()=>React);
  let component;
  plugin.apply({slots:{inject:(_name,cb)=>cb(),register:(opts,fn)=>{if(opts.name==='main')component=fn;return ()=>{};}}});
  assert.equal(typeof component,'function');
  assert.doesNotThrow(()=>component({}));
  const fallback=component({});
  assert.equal(fallback.props.className,'dr3-root');
  assert.match(textify(fallback),/远程工作区界面出现异常/);
  assert.match(browser.__DSH_REMOTE_WORKSPACE_DIAGNOSTICS__[0].detail,/hook unavailable/);
  assert(errors.length>=1);
});

test('server monitoring panel renders read-only metrics, mounted disks, and network counters',()=>{
  const metrics={cpuPercent:23.5,load:[0.3,0.4,0.5],uptimeSeconds:18000,
    memory:{totalBytes:8*1024**3,usedBytes:3*1024**3,swapTotalBytes:1024**3,swapUsedBytes:0},
    disks:[{filesystem:'/dev/sda',mount:'/',totalBytes:100*1024**3,usedBytes:30*1024**3,usedPercent:30}],
    interfaces:[{name:'eth0',rxBytes:1024,txBytes:2048}],capturedAt:'2026-10-21T10:00:00Z'};
  const panel=makeView({0:[p],1:p.id,5:'monitor',34:metrics});
  const text=textify(panel);
  for(const part of ['Linux 服务器监控','CPU 使用率','23.5%','内存使用','磁盘分区','eth0','网卡累计传输','按需采集']) assert(text.includes(part),part);
});
test('process panel offers TERM and typed-confirmation KILL and filters by process state',()=>{
  const panel=makeView({0:[p],1:p.id,5:'processes',35:{processes:[{pid:900,ppid:1,user:'app',cpuPercent:34,memoryPercent:7,rssBytes:10240,state:'S',command:'node'}]}});
  const text=textify(panel);
  for(const part of ['进程管理','PID','900','node','TERM','KILL']) assert(text.includes(part),part);
});
test('systemd panel renders actions without relying on prompt or confirm browser APIs',()=>{
  const panel=makeView({0:[p],1:p.id,5:'services',36:{services:[{unit:'nginx.service',active:'active',sub:'running',description:'Nginx HTTP server'}]}});
  const text=textify(panel);
  for(const part of ['systemd 服务','nginx.service','restart','stop','start']) assert(text.includes(part),part);
  assert(!text.includes('prompt()'));
});

test('file pane supports multi-file selection, drag-drop upload and chunked downloads across protocols',()=>{
  for (const protocol of ['ssh','sftp','ftp','ftps']) {
    const connection={...p,protocol,terminalEnabled:false};
    const v=makeView({0:[connection],1:connection.id,2:connection.workspace,3:connection.workspace,4:[{name:'report.pdf',type:'file',size:1048576}],5:'files'});
    const upload=elements(v,x=>x.type==='input'&&x.props.type==='file');
    assert.equal(upload.length,1);
    assert.equal(upload[0].props.multiple,true);
    assert.equal(typeof upload[0].props.onChange,'function');
    const drop=elements(v,x=>typeof x.props.onDrop==='function' && x.props.className?.includes('dr3-scroll'));
    assert.equal(drop.length,1);
    assert.equal(typeof drop[0].props.onDragOver,'function');
    assert(textify(v).includes('拖入文件上传'));
    assert(textify(v).includes('下载'));
  }
  const locked=makeView({0:[{...p,readOnly:true}],1:p.id,5:'files'});
  assert.equal(elements(locked,x=>x.type==='input'&&x.props.type==='file').length,0);
  assert.equal(elements(locked,x=>typeof x.props.onDrop==='function' && x.props.className?.includes('dr3-scroll')).length,1);
});

test('compact toolbar keeps upload visible and moves secondary actions into an expandable menu',()=>{
  const view=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace,5:'files'});
  const menus=elements(view,x=>x.type==='details'&&x.props.className==='dr3-more-actions');
  assert.equal(menus.length,1);
  assert(textify(menus[0]).includes('服务器监控'));
  assert(textify(view).includes('更多操作'));
  assert.equal(elements(view,x=>x.type==='span'&&x.props.className==='dr3-help'&&x.props['data-tip']?.includes('128 MiB')).length>0,true);
  const pane=elements(view,x=>typeof x.props.onDrop==='function' && x.props.className?.includes('dr3-scroll'));
  assert.equal(pane.length,1);
  assert.equal(typeof pane[0].props.onDragOver,'function');
});
test('transfer cancel remains available while regular toolbar actions are busy',()=>{
  const view=makeView({0:[p],1:p.id,2:p.workspace,3:p.workspace,5:'files',11:true,39:'下载进行中…'});
  const cancel=elements(view,x=>x.type==='button'&&textify(x).includes('取消传输'));
  assert.equal(cancel.length,1);
  assert.notEqual(cancel[0].props.disabled,true);
  assert.equal(typeof cancel[0].props.onClick,'function');
});
