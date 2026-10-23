import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const theme = runInNewContext(readFileSync(new URL('../src/theme.js', import.meta.url), 'utf8'));
const bundled = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function environment({dark=false,scheme='',tokens='',system='',observer=true}={}) {
  const root={style:{colorScheme:scheme}};
  const body={hasAttribute:name=>name==='data-ds-dark-theme'&&dark};
  const listeners={};
  const subscriptions=[];
  const win={
    getComputedStyle:element=>({colorScheme:element===root?scheme:'',getPropertyValue:name=>element===body&&name==='--dsw-alias-bg-base'?tokens:''}),
    matchMedia:query=>({matches:!!system&&query.includes(system),addEventListener:(_name,fn)=>{listeners[query]=fn;},removeEventListener:(_name,fn)=>{if(listeners[query]===fn)delete listeners[query];}}),
  };
  if(observer){win.MutationObserver=class {constructor(fn){this.fn=fn;}observe(element){subscriptions.push({element,observer:this});}disconnect(){subscriptions.splice(subscriptions.findIndex(e=>e.observer===this),1);}};}
  return {doc:{body,documentElement:root},win,listeners,subscriptions,setDark(value){dark=value;},setScheme(value){scheme=value;},setSystem(value){system=value;}};
}
test('theme priority: Harness dark overrides light OS; Harness light overrides dark OS',()=>{
  const e=environment({dark:true,scheme:'dark',system:'light'});
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'dark',source:'harness'});
  e.setDark(false);e.setScheme('light');e.setSystem('dark');
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'light',source:'harness'});
});
test('Harness theme aliases identify light even when color-scheme is unavailable',()=>{
  const e=environment({scheme:'normal',tokens:'rgb(255,255,255)',system:'dark'});
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'light',source:'harness'});
});
test('unknown Harness theme falls back to system light/dark and finally dark',()=>{
  const e=environment({scheme:'normal',system:'light'});
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'light',source:'system'});
  e.setSystem('dark');
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'dark',source:'system'});
  e.setSystem('');
  assert.deepEqual({...theme.resolve(e.doc,e.win)},{mode:'dark',source:'default'});
  assert.deepEqual({...theme.resolve(null,null)},{mode:'dark',source:'default'});
});
test('theme observer follows runtime changes and releases watchers on unmount',()=>{
  const e=environment({scheme:'light'});
  const results=[];
  const stop=theme.subscribe(e.doc,e.win,next=>results.push(next.mode));
  assert.deepEqual(results,['light']);
  assert.equal(e.subscriptions.length,2);
  e.setScheme('dark');
  e.subscriptions[0].observer.fn();
  assert.deepEqual(results,['light','dark']);
  e.setScheme('normal');e.setSystem('light');
  e.listeners['(prefers-color-scheme: light)']();
  assert.deepEqual(results,['light','dark','light']);
  stop();
  assert.equal(e.subscriptions.length,0);
  assert.equal(Object.keys(e.listeners).length,0);
});
test('unavailable browser APIs do not crash the plugin theme adapter',()=>{
  const doc={body:{hasAttribute(){return false;}},documentElement:{style:{}}};
  const win={matchMedia(){throw Error('unsupported');},getComputedStyle(){throw Error('unsupported');}};
  assert.deepEqual({...theme.resolve(doc,win)},{mode:'dark',source:'default'});
  assert.doesNotThrow(()=>theme.subscribe(doc,win,()=>{}));
});
test('Web client marks root appearance and limits theme styling to plugin namespace',()=>{
  const e=environment({scheme:'light'});
  const browser={...e.win,__ModuleLoader__:{load(x){browser.entry=x;}}};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect:()=>{},useRef:initial=>({current:initial}),useCallback:f=>f};
  runInNewContext(bundled,{window:browser,document:e.doc,console});
  const plugin=browser.entry.factory(()=>React);
  let Panel;
  plugin.apply({slots:{inject:(_name,cb)=>cb(),register:(options,component)=>{if(options.name==='main')Panel=component;}}});
  const result=Panel({});
  assert.equal(result.props['data-rw-theme'],'light');
  assert.equal(result.props['data-rw-source'],'harness');
  assert.match(result.children[0].children[0],/\.dr3-root\[data-rw-theme="light"\]/);
  assert.match(result.children[0].children[0],/--dsw-alias-bg-base/);
});
