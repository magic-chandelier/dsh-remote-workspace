import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const bundled = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function all(node, condition, found=[]) {
  if (node == null) return found;
  if (Array.isArray(node)) { for (const item of node) all(item,condition,found);return found; }
  if (typeof node !== 'object') return found;
  if (condition(node)) found.push(node);
  all(node.children,condition,found);
  return found;
}
function textContent(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  return textContent(node.children);
}
function setup() {
  const states=[], refs=[];
  let slot=0,refSlot=0;
  const calls=[];
  const browser={ __ModuleLoader__:{load(x){browser.entry=x;}},
    prompt(){throw new Error('prompt() is not supported');},
    confirm(){throw new Error('confirm() is not supported');} };
  const React={
    Fragment: Symbol('fragment'),
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(v){const i=slot++;if (!(i in states)) states[i]=v;return [states[i], update=>{states[i]=typeof update==='function'?update(states[i]):update;}];},
    useRef(v){const i=refSlot++;if (!(i in refs)) refs[i]={current:v};return refs[i];},
    useCallback:f=>f,
    useEffect:()=>{},
  };
  runInNewContext(bundled,{
    window:browser,console,fetch:async (_url,init)=>{
      const request=JSON.parse(init.body);calls.push(request);
      let result;
      if(request.action==='cleanup_preview') result={ownedFiles:['D:\\profile\\connections.json'],connectionIds:['prod'],anchorEntries:['anchor']};
      else if(request.action==='cleanup_purge') result={complete:true,cleaned:[]};
      else if(request.action==='list') result={profiles:[],active:'',dataDir:'D:\\profile'};
      else if(request.action==='remove') result={removed:request.id,cleanup:{}};
      else throw new Error('Unexpected API action: '+request.action);
      return {ok:true,json:async()=>({ok:true,data:result})};
    }
  });
  const plugin=browser.entry.factory(()=>React);
  let panel;
  plugin.apply({slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{if(options.name==='main')panel=component;return ()=>{};}}});
  const render=()=>{slot=0;refSlot=0;return panel({});};
  const click=(view,label)=>{
    const match=all(view,node=>node.type==='button'&&textContent(node)===label);
    assert.equal(match.length,1,'button '+label+' must exist');
    assert.notEqual(match[0].props.disabled,true,'button '+label+' should be enabled');
    match[0].props.onClick();
  };
  return {browser,calls,render,click,states};
}
const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
test('cleanup preview uses in-page typed confirmation and cancel never calls purge',async()=>{
  const ui=setup();
  ui.click(ui.render(),'卸载前检查与清理');
  await tick();
  let view=ui.render();
  assert.match(textContent(view),/DELETE_PLUGIN_LOCAL_DATA/);
  assert.match(textContent(view),/D:\\profile\\connections.json/);
  assert(all(view,n=>n.props?.role==='dialog').length===1);
  assert.equal(ui.calls.filter(x=>x.action==='cleanup_purge').length,0);
  ui.click(view,'取消');
  await tick();
  assert.equal(ui.calls.filter(x=>x.action==='cleanup_purge').length,0);
  assert(all(ui.render(),n=>n.props?.role==='dialog').length===0);
});
test('cleanup cannot submit wrong confirmation and submits exact token only after consent',async()=>{
  const ui=setup();
  ui.click(ui.render(),'卸载前检查与清理');await tick();
  let view=ui.render();
  const input=all(view,n=>n.type==='input'&&n.props['aria-label']==='输入清理确认词');
  assert.equal(input.length,1);
  input[0].props.onChange({target:{value:'DELETE_PLUGIN_LOCAL'}});
  view=ui.render();
  assert.equal(all(view,n=>n.type==='button'&&textContent(n)==='确认清理本地数据')[0].props.disabled,true);
  assert.equal(ui.calls.filter(x=>x.action==='cleanup_purge').length,0);
  all(view,n=>n.type==='input'&&n.props['aria-label']==='输入清理确认词')[0].props.onChange({target:{value:'DELETE_PLUGIN_LOCAL_DATA'}});
  view=ui.render();
  ui.click(view,'确认清理本地数据');await tick();
  assert.equal(ui.calls.filter(x=>x.action==='cleanup_purge').length,1);
  assert.equal(ui.calls.find(x=>x.action==='cleanup_purge').confirmation,'DELETE_PLUGIN_LOCAL_DATA');
});
test('other destructive actions use in-page confirmation when native confirm is unavailable', async()=>{
  const ui=setup();
  const profile={id:'prod',host:'host.example',port:22,protocol:'ssh',username:'admin',remoteRoot:'/srv',workspace:'/srv',readOnly:false};
  ui.states[0]=[profile];ui.states[1]='prod';ui.states[2]='/srv';ui.states[3]='/srv';
  ui.click(ui.render(),'删除连接及工作区');await tick();
  assert.equal(ui.calls.some(x=>x.action==='remove'),false);
  const modal=ui.render();
  assert.match(textContent(modal),/删除连接 prod/);
  ui.click(modal,'取消');await tick();
  assert.equal(ui.calls.some(x=>x.action==='remove'),false);
});
