const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;
const API_PATH = '/api/dsh-remote-workspace';
const NAV_ID = 'remote-workspace';
const DEFAULT_FORM = {
  id:'', protocol:'ssh', host:'', port:'22', username:'', remoteRoot:'/',
  privateKeyPath:'', privateKeyEnv:'', passwordEnv:'', hostKeySha256:'',
  hostKeySha256Env:'', hostTrustMode:'tofu', terminalEnabled:false, password:'', rememberMode:'none', readOnly:false, allowInsecureFtp:false,
  execAllowlist:''
};
const STYLE = __RW_CSS__;
const themeTools = __RW_THEME__;
async function api(action, payload = {}) {
  const response = await fetch(API_PATH, {
    method:'POST', headers:{'content-type':'application/json'}, credentials:'same-origin',
    body: JSON.stringify({ action, ...payload })
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('无法解析 Harness 管理 API 响应 (HTTP '+response.status+')'); }
  if(!response.ok || !data.ok) throw new Error(data.error || 'HTTP '+response.status);
  return data.data;
}
function errorText(e) { return String(e?.message || e || '操作失败'); }
function retryable(e) {
  const msg=errorText(e);
  if(/auth|permission|denied|fingerprint|host.?key|not found|no such file|not a directory|certificate|530\b|outside|invalid/i.test(msg)) return false;
  return /network|ECONN|ETIMEDOUT|EAI_AGAIN|ENET|EHOST|socket|fetch failed|failed to fetch|connection lost|connection reset|timed out/i.test(msg);
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function button(label, onClick, options={}) { return h('button',{type:'button',className:'dr3-btn'+(options.primary?' dr3-primary':'')+(options.danger?' dr3-danger':''),disabled:options.disabled,onClick},label); }
function helpTip(message) { return h('span',{className:'dr3-help','data-tip':message,tabIndex:0,'aria-label':message},'?'); }
function inputField(label, key, form, update, opts={}) {
  return h('div',{className:'dr3-field',key},h('label',null,label),
    h('input',{className:'dr3-input',type:opts.password?'password':'text',value:form[key]??'',
      placeholder:opts.placeholder||'',onChange:e=>update(key,e.target.value)}));
}
function displaySize(n) {
  if(!Number.isFinite(n))return '—';
  const units=['B','KiB','MiB','GiB','TiB'];
  let value=n,index=0;
  while(Math.abs(value)>=1024 && index<units.length-1){value/=1024;index++;}
  return (index?value.toFixed(1):Math.round(value))+' '+units[index];
}
function metric(label,value,footnote) {
  return h('div',{className:'dr3-metric',key:label},h('span',null,label),h('strong',null,value),footnote&&h('small',null,footnote));
}
function Panel() {
  const [profiles,setProfiles]=useState([]);
  const [selected,setSelected]=useState('');
  const [workspace,setWorkspace]=useState('');
  const [dir,setDir]=useState('/');
  const [files,setFiles]=useState([]);
  const [view,setView]=useState('files');
  const [form,setForm]=useState(DEFAULT_FORM);
  const [file,setFile]=useState('');
  const [content,setContent]=useState('');
  const [saved,setSaved]=useState('');
  const [sha,setSha]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [status,setStatus]=useState('未连接');
  const [attempt,setAttempt]=useState(0);
  const [search,setSearch]=useState('');
  const [connectionsOpen,setConnectionsOpen]=useState(true);
  const [localWorkspaces,setLocalWorkspaces]=useState([]);
  const [localWorkspaceId,setLocalWorkspaceId]=useState('');
  const [localBinding,setLocalBinding]=useState(null);
  const [bindingAvailable,setBindingAvailable]=useState(false);
  const [bindingWarning,setBindingWarning]=useState('');
  const [terminalSession,setTerminalSession]=useState('');
  const [terminalOutput,setTerminalOutput]=useState('');
  const [terminalInput,setTerminalInput]=useState('');
  const [terminalDisconnected,setTerminalDisconnected]=useState(false);
  const [commandHistory,setCommandHistory]=useState([]);
  const [historyPosition,setHistoryPosition]=useState(-1);
  const [comparePath,setComparePath]=useState('');
  const [comparison,setComparison]=useState(null);
  const [dataInfo,setDataInfo]=useState(null);
  const [dialog,setDialog]=useState(null);
  const [dialogInput,setDialogInput]=useState('');
  const [metrics,setMetrics]=useState(null);
  const [processData,setProcessData]=useState(null);
  const [servicesData,setServicesData]=useState(null);
  const selectedRef=useRef('');
  const [processSearch,setProcessSearch]=useState('');
  useEffect(()=>{selectedRef.current=selected;},[selected]);
  const [appearance,setAppearance]=useState(() => themeTools.resolve(
    typeof document === 'undefined' ? null : document,
    typeof window === 'undefined' ? null : window
  ));
  const [transferProgress,setTransferProgress]=useState('');
  const [dragActive,setDragActive]=useState(false);
  useEffect(() => themeTools.subscribe(
    typeof document === 'undefined' ? null : document,
    typeof window === 'undefined' ? null : window,
    next => setAppearance(current => current.mode === next.mode && current.source === next.source ? current : next)
  ), []);
  const dialogResolver=useRef(null);
  function askDialog(kind, title, message, initialValue='', confirmation='') {
    if(dialogResolver.current) return Promise.reject(new Error('请先完成当前确认操作'));
    return new Promise(resolve=>{
      dialogResolver.current=resolve;
      setDialogInput(String(initialValue));
      setDialog({kind,title,message,confirmation});
    });
  }
  const askConfirm=message=>askDialog('confirm','确认操作',message);
  const askInput=(message,initialValue='')=>askDialog('input',message,'',initialValue);
  function finishDialog(result) {
    const resolve=dialogResolver.current;
    dialogResolver.current=null;
    setDialog(null);setDialogInput('');
    if(resolve)resolve(result);
  }
  useEffect(()=>()=>{
    // A route change must never leave a suspended destructive operation alive.
    if(dialogResolver.current){const resolve=dialogResolver.current;dialogResolver.current=null;resolve(null);}
  },[]);
  const cancelled=useRef(0);
  const transferRef=useRef(null);
  useEffect(()=>()=>{
    const active=transferRef.current;
    if (!active) return;
    active.cancelled=true;
    if (active.token) api('transfer_cancel',{id:active.connection,token:active.token}).catch(()=>{});
  },[]);
  const picked=profiles.find(p=>p.id===selected);
  const readOnly=picked?.readOnly!==false;
  const dirty=content!==saved;
  const matching=profiles.filter(p => [p.id,p.host,p.username].some(x=>String(x||'').toLowerCase().includes(search.toLowerCase().trim())));
  function modifyForm(k,value){setForm(old=>({...old,[k]:value}));}
  function task(operation) {
    setError('');setNotice('');setBusy(true);
    Promise.resolve().then(operation).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));
  }
  const restore=useCallback(async(id,folder,revision)=>{
    const delays=[0,1000,2000,4000];
    for(let i=0;i<delays.length;i++) {
      if(revision!==cancelled.current)return;
      if(delays[i])await wait(delays[i]);
      if(revision!==cancelled.current)return;
      setAttempt(i);setStatus(i?'重新连接中':'连接中');
      try{
        const result=await api('browse',{id,path:folder});
        if(revision!==cancelled.current)return;
        setSelected(id);setDir(result.directory);setWorkspace(result.workspace);
        setFiles(result.entries);setStatus('已连接');setAttempt(0);return;
      }catch(e){
        if(revision!==cancelled.current)return;
        if(!retryable(e)||i===delays.length-1) {
          setStatus('需要处理');setError('原工作区 '+folder+' 无法打开：'+errorText(e));return;
        }
        setStatus('已断线');
      }
    }
  },[]);
  const refresh = useCallback(async()=>{
    const data=await api('list');setProfiles(data.profiles);setDataInfo({path:data.dataDir,reason:data.dataLocationReason});
    return data;
  },[]);
  useEffect(()=>{
    let active=true;
    (async()=>{
      try {
        const data=await api('list');
        if(!active)return;
        setProfiles(data.profiles);
        setDataInfo({path:data.dataDir,reason:data.dataLocationReason});
        const id=data.active||data.profiles[0]?.id;
        const profile=data.profiles.find(p=>p.id===id);
        if(profile){
          setSelected(profile.id);
          setWorkspace(profile.workspace||profile.remoteRoot||'/');
          setDir(profile.workspace||profile.remoteRoot||'/');
        }
      }catch(e){if(active)setError(errorText(e));}
    })();
    return ()=>{active=false;cancelled.current++;};
  },[]);
  async function loadBindingWorkspaces() {
    const data=await api('workspace_list');
    setBindingAvailable(data.available===true);
    setLocalWorkspaces(data.workspaces||[]);
    if(!data.available)setBindingWarning(data.reason||'Harness 本地工作区注册表不可用');
    const choice=(data.workspaces||[]).some(x=>x.id===localWorkspaceId)?localWorkspaceId:
      (data.workspaces||[]).length===1?data.workspaces[0].id:'';
    setLocalWorkspaceId(choice);
    if(choice)await readProjectBinding(choice);else setLocalBinding(null);
  }
  async function readProjectBinding(workspaceId){
    setComparison(null);
    if(!workspaceId){setLocalBinding(null);return;}
    const result=await api('binding_read',{workspaceId});
    setLocalBinding(result.binding||null);
    setBindingWarning(result.status?.validationError||'');
  }
  async function showBinding() {
    if(dirty&&view==='editor'&&!await askConfirm('编辑器内容尚未保存，仍要离开吗？'))return;
    setView('binding');await loadBindingWorkspaces();
  }
  async function saveProjectBinding(){
    const local=localWorkspaces.find(x=>x.id===localWorkspaceId);
    if(!local||!selected)throw new Error('请先选择本地工作区和远程服务器');
    if(!await askConfirm('绑定本地项目：'+local.path+'\n到远程目录：'+selected+':'+dir+'\n\n只记录绑定和 AGENTS.md 说明，不会同步或部署。确认？'))return;
    await api('binding_save',{workspaceId:localWorkspaceId,connectionId:selected,remotePath:dir,
      replace:!!localBinding,confirmation:'BIND_THIS_WORKSPACE'});
    await readProjectBinding(localWorkspaceId);setNotice('本地项目已通过界面确认远程绑定，写入 .harness-remote.json、AGENTS.md 及插件私有授权记录；AI 仅可调用受限的 remote_project_* 工具。');
  }
  async function removeProjectBinding(){
    if(!localBinding)return;
    if(!await askConfirm('解绑当前本地项目？只删除绑定配置及 AGENTS.md 中由插件维护的段落，不会删除项目源码。'))return;
    await api('binding_remove',{workspaceId:localWorkspaceId,confirmation:'UNBIND_THIS_WORKSPACE'});
    await readProjectBinding(localWorkspaceId);setNotice('项目绑定已解除');
  }
  async function compareProjectFile(){
    if(!localBinding || !localWorkspaceId)throw new Error('请先选择已绑定的本地项目');
    const result=await api('binding_compare',{workspaceId:localWorkspaceId,path:comparePath.trim()});
    setComparison(result);
  }
  async function showOperations(section){
    if (!selected || !['ssh','sftp'].includes(picked?.protocol)) throw new Error('服务器管理需要 SSH/SFTP 连接');
    if(dirty&&view==='editor'&&!await askConfirm('编辑内容未保存，仍要切换页面吗？'))return;
    setView(section);
    await loadOperations(section,selected);
  }
  async function loadOperations(section,id){
    if(!id)return;
    const action=section==='monitor'?'monitor':section==='processes'?'processes':'services';
    const result=await api(action,{id});
    if(selectedRef.current!==id)return;
    if(section==='monitor')setMetrics(result);
    else if(section==='processes')setProcessData(result);
    else setServicesData(result);
  }
  async function signalProcess(pid,signal){
    const token=`SIGNAL_${pid}_${signal}`;
    const message=`将在 ${selected} 发送 ${signal} 信号给 PID ${pid}。\nPID 可能已经被系统复用，请先刷新并核对。此操作无法自动撤销。`;
    const confirmed=signal==='KILL' ? await askDialog('typed','强制终止进程',message,'',token)===token : await askConfirm(message);
    if(!confirmed)return;
    await api('process_signal',{id:selected,pid,signal,confirmation:token});
    setNotice(`已发送 ${signal} 到 PID ${pid}`);
    await loadOperations('processes',selected);
  }
  async function controlService(unit,operation){
    const token=`SERVICE_${operation}_${unit}`;
    const message=`服务器 ${selected}：${operation} ${unit}。\n可能影响在线业务，请确认。`;
    const confirmed=operation==='stop' ? await askDialog('typed','停止远程服务',message,'',token)===token : await askConfirm(message);
    if(!confirmed)return;
    await api('service_control',{id:selected,unit,operation,confirmation:token});
    setNotice(`服务操作已执行：${operation} ${unit}`);
    await loadOperations('services',selected);
  }
  async function changeServer(p){
    if(dirty && !await askConfirm('当前编辑尚未保存，仍要切换服务器吗？'))return;
    if(terminalSession) await closeTerminal();
    setView('files');setFiles([]);setError('');setSelected(p.id);
    const revision=++cancelled.current;
    await restore(p.id,p.workspace||p.remoteRoot,revision);
  }
  async function browse(target){
    const result=await api('browse',{id:selected,path:target});
    setDir(result.directory);setFiles(result.entries);setStatus('已连接');
  }
  function safePath(name){return dir.replace(/\/$/,'')+'/'+name;}
  async function removeVirtualWorkspace(){
    if(!selected)return;
    if(!await askConfirm('从 Harness 删除此远程工作区，并清除插件自动创建的本地会话标识文件？\n\n不会删除服务器文件或已有聊天历史。插件仍加载期间，历史会话中的本机操作仍会被禁止；卸载后不要继续执行旧聊天。'))return;
    const result=await api('virtual_remove',{id:selected});
    setNotice('远程工作区已取消注册；清理状态：'+(result.removed?'标识文件已删除':'没有可删除的标识文件。')+' 聊天记录保留。');
  }
  async function cleanupForUninstall(){
    const info=await api('cleanup_preview');
    const detail='插件将清理：\n'+info.ownedFiles.join('\n')+'\n\n远程连接数：'+info.connectionIds.length+'；标识目录数：'+info.anchorEntries.length+'。\n\n不会删除：远程文件、Harness 聊天记录、个人项目、本地传输文件。';
    const confirmation=await askDialog('typed','卸载前清理插件数据',detail,'','DELETE_PLUGIN_LOCAL_DATA');
    if(confirmation!=='DELETE_PLUGIN_LOCAL_DATA')return;
    if(terminalSession)await closeTerminal();
    const result=await api('cleanup_purge',{confirmation});
    if(!result.complete)throw new Error('未能清理全部数据；请检查未删除项目：'+JSON.stringify(result.errors));
    setSelected('');setWorkspace('');setFiles([]);await refresh();
    setNotice('插件管理的连接、密码、审计和标识目录已清理。聊天历史及服务器文件未删除。现在可到 Harness 中卸载插件。');
  }
  async function addVirtualWorkspace(){
    if(!selected)throw new Error('请先添加远程服务器');
    if(!['ssh','sftp','ftp','ftps'].includes(picked?.protocol))throw new Error('AI 远程工作区需要已配置的 SSH/SFTP/FTP/FTPS 连接');
    const target=dir||workspace;
    if(!await askConfirm('添加远程服务器 '+selected+' 的 '+target+' 为 Harness 工作区？\n\n此操作不会挂载磁盘、不使用资源管理器、不复制远程项目。插件仅在内部创建一个会话标识目录，远程文件通过所选协议访问，Shell 命令仅支持 SSH。'))return;
    if(target!==workspace) { const chosen=await api('select',{id:selected,path:target});setWorkspace(chosen.workspace); }
    const result=await api('virtual_create',{id:selected});
    setNotice('已添加插件托管远程工作区：'+result.title+'。请在 Harness 工作区列表选择它并创建会话。注意：AI 使用 remote_* 工具操作服务器；本地文件、Bash/PowerShell、代码运行工具将被拦截。');
  }
  async function setWork(){
    const result=await api('select',{id:selected,path:dir});
    setWorkspace(result.workspace);setNotice('远程工作区已设为 '+result.workspace);
    await refresh();
  }
  function canEditHere(){return dir===workspace||dir.startsWith(workspace.replace(/\/$/,'')+'/')||workspace==='/';}
  async function openFile(entry){
    if(!canEditHere())throw new Error('请先将当前目录设为工作区，再读取文件');
    const result=await api('read',{id:selected,path:safePath(entry.name)});
    setFile(result.path);setContent(result.content);setSaved(result.content);setSha(result.sha256);
    setView('editor');
  }
  async function saveFile(){
    const result=await api('write',{id:selected,path:file,content,expectedSha256:sha});
    setSha(result.sha256);setSaved(content);setNotice('保存成功（已检查 SHA-256）');
  }
  async function saveProfile(){
    const profile={...form,execAllowlist:String(form.execAllowlist||'').split(',').map(s=>s.trim()).filter(Boolean)};
    await api('save',{profile});setForm(old=>({...old,password:''}));await refresh();
    setView('files');setSelected(profile.id);setNotice('连接已保存。现在可以测试并浏览服务器。');
    const revision=++cancelled.current;
    await restore(profile.id,profile.remoteRoot,revision);
  }
  async function editProfile(profile){
    if(dirty && view==='editor' && !await askConfirm('当前文件未保存，仍要编辑连接吗？'))return;
    setForm({...DEFAULT_FORM,...profile,port:String(profile.port),password:'',execAllowlist:(profile.execAllowlist||[]).join(',')});
    setView('form');
  }
  async function createEntry(folder){
    const name=await askInput(folder?'新文件夹名':'新文件名');if(!name)return;
    if(name==='.'||name==='..'||name.includes('/')||name.includes('\\'))throw new Error('名称不能包含路径分隔符');
    if(folder)await api('mkdir',{id:selected,path:safePath(name)});
    else await api('write',{id:selected,path:safePath(name),content:'',expectedSha256:''});
    await browse(dir);
  }
  async function renameEntry(entry){
    const next=await askInput('输入新名称',entry.name);if(!next||next===entry.name)return;
    if(next.includes('/')||next.includes('\\')||next==='.'||next==='..')throw new Error('无效名称');
    await api('rename',{id:selected,from:safePath(entry.name),to:safePath(next)});await browse(dir);
  }
  async function deleteEntry(entry){
    if(!await askConfirm('确认删除 '+entry.name+' ？目录必须为空。'))return;
    await api('delete',{id:selected,path:safePath(entry.name),directory:entry.type==='directory'});await browse(dir);
  }
  function toBase64(bytes){
    const parts=[];
    for(let start=0;start<bytes.length;start+=16384){
      parts.push(String.fromCharCode(...bytes.subarray(start,start+16384)));
    }
    return btoa(parts.join(''));
  }
  function fromBase64(value){
    const raw=atob(value),bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return bytes;
  }
  function beginTransfer(connection) {
    if (transferRef.current) throw new Error('已有文件传输正在运行，请先完成或取消');
    const current={connection,token:null,cancelled:false,committing:false};
    transferRef.current=current;
    return current;
  }
  function checkTransfer(current) {
    if (current.cancelled) throw new Error('已取消文件传输');
  }
  async function cancelTransfer() {
    const current=transferRef.current;
    if (!current || current.cancelled) return;
    current.cancelled=true;
    setTransferProgress(current.committing ? '已申请取消；正在确认服务器是否已提交…' : '正在取消传输…');
    if (current.token) await api('transfer_cancel',{id:current.connection,token:current.token}).catch(()=>{});
  }
  async function uploadFiles(fileList){
    const items=Array.from(fileList||[]);
    if(!items.length)return;
    if(!selected||readOnly)throw new Error('请选择允许写入的远程连接');
    const connection=selected,folder=dir,current=beginTransfer(selected);
    let success=0,committedAfterCancel=false;
    try{
      for(const item of items){
        checkTransfer(current);
        if(!item || !item.name || item.name==='.' || item.name==='..' || /[/\\]/.test(item.name))throw new Error('文件名不合法');
        const remotePath=folder.replace(/\/$/,'')+'/'+item.name;
        setTransferProgress(`准备上传 ${success+1}/${items.length}：${item.name}`);
        const init=await api('transfer_upload_begin',{id:connection,path:remotePath,bytes:item.size});
        current.token=init.token;
        try{
          checkTransfer(current);
          for(let offset=0,index=0;offset<item.size;index++){
            checkTransfer(current);
            const chunk=new Uint8Array(await item.slice(offset,offset+init.chunkBytes).arrayBuffer());
            checkTransfer(current);
            await api('transfer_upload_chunk',{id:connection,token:init.token,index,contentBase64:toBase64(chunk)});
            offset+=chunk.length;
            if(!current.cancelled)setTransferProgress(`上传 ${success+1}/${items.length} · ${item.name} · ${Math.round(offset/item.size*100)}%`);
          }
          checkTransfer(current);
          current.committing=true;
          setTransferProgress(`正在提交远程文件 ${item.name}…`);
          const result=await api('transfer_upload_finish',{id:connection,token:init.token});
          if(result?.committed && result?.cancelRequested) committedAfterCancel=true;
          success++;
          if(current.cancelled) break;
        }finally{
          current.committing=false;
          await api('transfer_cancel',{id:connection,token:init.token}).catch(()=>{});
          current.token=null;
        }
      }
      if(current.cancelled) setNotice(committedAfterCancel || success ? `已停止后续上传；${success} 个文件已在服务器提交，不能撤销。` : '已取消上传，未提交后续文件。');
      else setNotice(`已上传 ${success} 个文件。`);
      if(selectedRef.current===connection && success)await browse(folder);
    }catch(error){
      if(current.cancelled)setNotice(success?`已停止上传；${success} 个文件已提交，不能撤销。`:'上传已取消。');
      else throw error;
    }finally{
      transferRef.current=null;setTransferProgress('');setDragActive(false);
    }
  }
  async function openTerminal(){
    if(!selected || picked?.protocol!=='ssh') throw new Error('终端需要 SSH + SFTP 连接');
    if(!picked?.terminalEnabled) throw new Error('请先编辑连接并允许 SSH 终端');
    if(terminalSession) await closeTerminal();
    setTerminalOutput('');setTerminalDisconnected(false);
    const result=await api('terminal_open',{id:selected,cols:100,rows:28});
    setTerminalSession(result.sessionId);setView('terminal');
  }
  async function closeTerminal(){
    const id=terminalSession;setTerminalSession('');setTerminalDisconnected(true);
    if(id) try{await api('terminal_close',{sessionId:id});}catch(_){}
  }
  async function terminalCommand(input){
    if(!terminalSession || terminalDisconnected) return;
    await api('terminal_send',{sessionId:terminalSession,input});
  }
  async function submitCommand(){
    const command=terminalInput;
    setTerminalInput('');setHistoryPosition(-1);
    if(command) setCommandHistory(old=>[command,...old].slice(0,30));
    await terminalCommand(command+'\r');
  }
  useEffect(()=>{
    if(!terminalSession)return;
    let active=true, running=false;
    const run=async()=>{
      if(!active||running)return;running=true;
      try{const x=await api('terminal_poll',{sessionId:terminalSession});
        if(!active)return;
        if(x.output) setTerminalOutput(old=>(old+x.output).slice(-100000));
        if(x.closed){setTerminalDisconnected(true);setNotice('SSH 终端已断开；不会自动重放命令。');}
      }catch(e){if(active){setTerminalDisconnected(true);setError('终端读取失败：'+errorText(e));}}
      finally{running=false;}
    };
    run();const interval=setInterval(run,500);
    return ()=>{active=false;clearInterval(interval);};
  },[terminalSession]);
  async function downloadFile(entry){
    const connection=selected,current=beginTransfer(selected);
    setTransferProgress(`正在从服务器读取 ${entry.name}…`);
    let init,writer=null;
    try{
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        try {
          const handle=await window.showSaveFilePicker({suggestedName:entry.name});
          writer=await handle.createWritable();
        } catch(error) {
          if (error?.name==='AbortError') {setNotice('已取消文件保存。');return;}
          throw error;
        }
      }
      checkTransfer(current);
      init=await api('transfer_download_start',{id:connection,path:safePath(entry.name)});
      current.token=init.token;
      checkTransfer(current);
      let status;
      while(true){
        checkTransfer(current);
        status=await api('transfer_download_status',{id:connection,token:init.token});
        if(status.ready)break;
        await wait(200);
      }
      const chunks=[];
      for(let index=0,offset=0;offset<status.bytes;index++){
        checkTransfer(current);
        const part=await api('transfer_download_chunk',{id:connection,token:init.token,index});
        checkTransfer(current);
        const bytes=fromBase64(part.contentBase64);
        if (writer) await writer.write(bytes);
        else chunks.push(bytes);
        offset=part.received;
        setTransferProgress(`下载 ${entry.name} · ${Math.round(offset/status.bytes*100)}%`);
      }
      checkTransfer(current);
      if (writer) {
        current.committing=true;
        await writer.close();
        writer=null;
        setNotice(`文件 ${entry.name} 已保存到所选位置。`);
      } else {
        const url=URL.createObjectURL(new Blob(chunks,{type:'application/octet-stream'}));
        const a=document.createElement('a');
        a.href=url;a.download=init.filename||entry.name;
        document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        setNotice(`已准备下载 ${entry.name}。请在浏览器下载列表确认保存结果。`);
      }
    }catch(error){
      if(current.cancelled)setNotice('下载已取消；未生成本地下载文件。');
      else throw error;
    }finally{
      if(writer && typeof writer.abort==='function')await writer.abort().catch(()=>{});
      if(init)await api('transfer_cancel',{id:connection,token:init.token}).catch(()=>{});
      transferRef.current=null;
      setTransferProgress('');
    }
  }
  const title=status==='已连接'?'● 已连接':status==='重新连接中'?'◌ 正在重连 '+attempt+'/3':status;
  const primaryTools=[
    selected&&button('刷新',()=>task(()=>browse(dir)),{disabled:busy}),
    selected&&button('上一级',()=>task(()=>browse(dir.replace(/\/[^/]*\/?$/,'')||'/')),{disabled:busy}),
    picked&&!readOnly&&h('label',{className:'dr3-btn',key:'upload'},'↑ 上传',h('input',{type:'file',multiple:true,disabled:busy,style:{display:'none'},onChange:e=>{const pickedFiles=Array.from(e.target.files||[]);e.target.value='';task(()=>uploadFiles(pickedFiles));}})),
    transferProgress&&button('取消传输',()=>{cancelTransfer().catch(e=>setError(errorText(e)));},{danger:true,disabled:transferRef.current?.cancelled}),
  ].filter(Boolean);
  const advancedTools=[
    selected&&button('测试连接',()=>task(async()=>{await api('test',{id:selected});setNotice('连接测试成功。AI 使用此工作区仍需连接授权。');})),
    selected&&['ssh','sftp','ftp','ftps'].includes(picked?.protocol)&&button('手动连接供 AI 使用',()=>task(async()=>{
      const result=await api('connect_for_agent',{id:selected});setStatus('待 AI 会话确认');
      setNotice('已验证连接 '+result.profile+'。请回到原 AI 会话选择「已手动连接」，两分钟内有效且只允许一个会话领取；AI 不会操作本地标识目录。');
    })),
    selected&&['ssh','sftp','ftp','ftps'].includes(picked?.protocol)&&button('断开 AI 连接授权',()=>task(async()=>{
      await api('disconnect_for_agent',{id:selected});setNotice('已撤销 AI 连接授权。');setStatus('未连接');
    })),
    selected&&button('设为远程目录',()=>task(setWork)),
    selected&&['ssh','sftp','ftp','ftps'].includes(picked?.protocol)&&button('＋ 添加到 Harness 远程工作区',()=>task(addVirtualWorkspace),{primary:true}),
    selected&&['ssh','sftp'].includes(picked?.protocol)&&button('◫ 服务器监控',()=>task(()=>showOperations('monitor'))),
    selected&&['ssh','sftp'].includes(picked?.protocol)&&button('进程管理',()=>task(()=>showOperations('processes'))),
    selected&&['ssh','sftp'].includes(picked?.protocol)&&button('服务管理',()=>task(()=>showOperations('services'))),
    picked?.protocol==='ssh'&&picked.terminalEnabled&&button('⌘ SSH 终端',()=>task(openTerminal)),
    picked&&!readOnly&&button('+ 文件夹',()=>task(()=>createEntry(true))),
    picked&&!readOnly&&button('+ 文件',()=>task(()=>createEntry(false))),
  ].filter(Boolean);
  return h('div',{className:'dr3-root','data-rw-theme':appearance.mode,'data-rw-source':appearance.source,
    onDragOver:e=>{if(e.dataTransfer?.types?.includes?.('Files'))e.preventDefault();},
    onDrop:e=>{if(e.dataTransfer?.files?.length)e.preventDefault();}},
    h('style',null,STYLE),
    h('header',{className:'dr3-header'},h('strong',null,'◈ 远程工作区'),h('small',null,'SSH + SFTP · SFTP · FTP · FTPS'),h('span',{className:'dr3-grow'}),h('span',{className:'dr3-state',role:'status'},title)),
    error&&h('div',{className:'dr3-message dr3-error',role:'alert'},error),
    notice&&h('div',{className:'dr3-message dr3-note',role:'status'},notice),
    selected&&['ssh','sftp'].includes(picked?.protocol)&&h('nav',{className:'dr3-ops-nav','aria-label':'服务器操作'},
      button('文件管理',()=>setView('files')),
      button('服务器监控',()=>task(()=>showOperations('monitor'))),
      button('进程',()=>task(()=>showOperations('processes'))),
      button('服务',()=>task(()=>showOperations('services'))),
      picked.protocol==='ssh'&&picked.terminalEnabled&&button('终端',()=>task(openTerminal))
    ),
    h('div',{className:'dr3-main'},
      h('aside',{className:'dr3-left','aria-label':'远程连接管理'},
        h('div',{className:'dr3-side-section'},
          h('div',{className:'dr3-side-head'},
            h('strong',null,'已保存连接 ('+profiles.length+')'),
            button(connectionsOpen?'收起':'展开',()=>setConnectionsOpen(x=>!x))
          ),
          connectionsOpen&&h(React.Fragment,null,
            h('input',{className:'dr3-input dr3-search',type:'search',value:search,placeholder:'搜索名称 / 地址 / 用户名',
              'aria-label':'搜索已保存连接',onChange:e=>setSearch(e.target.value)}),
            h('div',{className:'dr3-side-scroll'},
              matching.map(p=>h('button',{className:'dr3-item',key:p.id,title:p.id+'\n'+p.username+'@'+p.host+':'+p.port+'\n'+p.remoteRoot,
                'aria-current':p.id===selected,onClick:()=>task(()=>changeServer(p))},
                h('span',{className:'dr3-item-name'},'▣  '+p.id),
                h('span',{className:'dr3-item-meta'},p.protocol.toUpperCase()+' · '+p.host+':'+p.port),
                p.id===selected&&h('span',{className:'dr3-item-status'},'● 当前服务器')
              )),
              matching.length===0&&h('div',{className:'dr3-empty'},profiles.length?'没有匹配的连接':'还没有保存服务器')
            )
          ),
          h('button',{type:'button',className:'dr3-btn dr3-primary dr3-side-btn',onClick:async()=>{
            if(dirty && view==='editor' && !await askConfirm('当前文件未保存，仍要新建连接吗？'))return;
            setForm({...DEFAULT_FORM});setView('form');setError('');
          }},'＋ 添加远程工作区')
        ),
        h('div',{className:'dr3-bind-card'},
          h('h4',null,'旧版：本地项目绑定（可选）'),
          h('span',{className:'dr3-bind-status'},localBinding ? localBinding.connectionId+':'+localBinding.remotePath : '新方式无需本地空文件夹；旧绑定仅为兼容保留'),
          button('绑定 / 查看本地项目',()=>task(showBinding),{disabled:busy})
        ),
        h('div',{className:'dr3-bind-card'},
          h('h4',null,'插件数据与卸载'),
          dataInfo?.path&&h('span',{className:'dr3-bind-status'},'当前数据目录：'+dataInfo.path+(dataInfo.reason==='legacy-preserved'?'（沿用旧版本数据，未自动迁移）':'')),
          h('span',{className:'dr3-bind-status'},'原生「卸载」只移除插件包，不保证删除数据。需要彻底清理时，请先使用此处的「卸载前检查与清理」，完成后再到 Harness 插件管理器卸载。数据默认放在 profile 旁，也可在插件配置 dataDir 指定 D 盘。'),
          button('卸载前检查与清理',()=>task(cleanupForUninstall),{danger:true,disabled:busy})
        ),
        h('div',{className:'dr3-side-workspace'},
          h('h4',null,'当前远程工作区'),
          h('div',{className:'dr3-workspace',title:workspace||''},workspace||'尚未选择'),
          picked&&h('div',{className:'dr3-side-actions'},
            button('编辑连接',()=>task(()=>editProfile(picked))),
            button('移除 Harness 工作区',()=>task(removeVirtualWorkspace),{danger:true,disabled:busy}),
            button('删除连接及工作区',()=>task(async()=>{if(await askConfirm('确认删除连接 '+selected+'？\n\n将取消插件注册的 Harness 工作区、清理属于插件的会话标识文件、删除此连接及保存密码。不会删除聊天历史或远程服务器文件。')){
              if(terminalSession)await closeTerminal();
              const result=await api('remove',{id:selected});setSelected('');setWorkspace('');setFiles([]);await refresh();
              setNotice('连接已删除。标识清理：'+JSON.stringify(result.cleanup));
            }}),{danger:true,disabled:busy})
          )
        )
      ),
      h('main',{className:'dr3-body'},
        view==='binding'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('b',null,'本地项目 ↔ 远程工作区绑定'),h('span',{className:'dr3-grow'}),button('← 返回远程文件',()=>setView('files'))),
            h('div',{className:'dr3-scroll'},
              h('div',{className:'dr3-bind-panel'},
                h('p',{className:'dr3-muted'},'此功能使用 Harness 已注册的本地工作区，不新建聊天界面，不更改模型/API 配置。'),
                h('div',{className:'dr3-bind-row'},
                  h('strong',null,'选择 Harness 本地工作区'),
                  bindingAvailable ? h('select',{className:'dr3-input','aria-label':'选择 Harness 本地工作区',value:localWorkspaceId,
                    onChange:e=>task(async()=>{setLocalWorkspaceId(e.target.value);await readProjectBinding(e.target.value);})},
                    h('option',{value:''},'请选择本地项目'),
                    ...localWorkspaces.map(x=>h('option',{key:x.id,value:x.id},(x.title||x.id)+' — '+x.path))
                  ) : h('p',{className:'dr3-tip'},bindingWarning||'该 Harness profile 没有暴露 workspaceRegistry，无法在页面绑定。'),
                  localWorkspaces.find(x=>x.id===localWorkspaceId)&&h('p',{className:'dr3-path'},localWorkspaces.find(x=>x.id===localWorkspaceId).path)
                ),
                h('div',{className:'dr3-bind-row'},h('strong',null,'要绑定的远程目录'),
                  h('p',{className:'dr3-path'},selected ? selected+':'+dir : '请先选择服务器并浏览到目标目录'),
                  h('p',{className:'dr3-tip'},'仅支持 SSH/SFTP 绑定；FTP/FTPS 无法可靠核验目录软链接。绑定不会立即同步或执行命令，凭据不会写入项目。')
                ),
                h('div',{className:'dr3-bind-row'},h('strong',null,'当前本地项目已有绑定'),
                  h('p',{className:'dr3-path'},localBinding?localBinding.connectionId+':'+localBinding.remotePath:'尚未绑定'),
                  bindingWarning&&h('p',{className:'dr3-tip'},bindingWarning)
                ),
                h('div',{className:'dr3-bind-row'},
                  h('strong',null,'只读文件差异预览（新增）'),
                  h('p',{className:'dr3-tip'},'比较本地项目与已绑定的 SSH/SFTP 目录中同名的 UTF-8 文件。只返回 SHA-256 与少量差异行，不上传、同步或覆盖文件；不支持软链接及敏感文件。'),
                  h('div',{className:'dr3-tools'},
                    h('input',{className:'dr3-input',value:comparePath,placeholder:'相对路径，如 src/index.js',
                      'aria-label':'要比较的项目相对路径',onChange:e=>{setComparePath(e.target.value);setComparison(null);},
                      onKeyDown:e=>{if(e.key==='Enter'&&!busy&&localBinding)task(compareProjectFile);}}),
                    button('比较本地 / 远程',()=>task(compareProjectFile),{primary:true,disabled:busy||!localBinding||!comparePath.trim()})
                  ),
                  comparison&&h('div',{className:'dr3-compare-result',role:'status'},
                    h('span',{className:'dr3-compare-status'},({identical:'✓ 内容一致',different:'内容不同',local_missing:'本地文件不存在',remote_missing:'远程文件不存在',both_missing:'本地与远程均不存在'})[comparison.status]||comparison.status),
                    h('code',null,'本地 SHA-256：'+(comparison.local?.sha256||'无')),
                    h('code',null,'远程 SHA-256：'+(comparison.remote?.sha256||'无')),
                    comparison.differences?.length>0&&h('pre',{className:'dr3-compare-lines'},
                      comparison.differences.map(d=>d.omitted?
                        '… 另有 '+d.omitted+' 行不同':
                        '第 '+d.line+' 行\n  本地：'+(d.local??'[不存在]')+'\n  远程：'+(d.remote??'[不存在]')).join('\n\n'))
                  )
                ),
                h('div',{className:'dr3-tools'},
                  button(localBinding?'更新绑定':'绑定这个远程文件夹',()=>task(saveProjectBinding),{primary:true,disabled:busy||!bindingAvailable||!localWorkspaceId||!selected||!['ssh','sftp'].includes(picked?.protocol)}),
                  button('解除绑定',()=>task(removeProjectBinding),{danger:true,disabled:busy||!localBinding}),
                  button('刷新',()=>task(loadBindingWorkspaces),{disabled:busy})
                ),
                h('p',{className:'dr3-tip'},'仅界面可以建立、变更和解除绑定。AI 会话只能调用受限的 remote_project_list/read/compare/write；旧绑定请点击「更新绑定」重新确认。插件私有授权记录用于校验项目文件未被伪造或替换。')
              )
            )
          ):
        view==='form'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('b',null,'连接配置'),h('span',{className:'dr3-grow'}),button('返回文件',()=>setView('files'))),
            h('div',{className:'dr3-scroll'},
              h('div',{className:'dr3-form'},
                ...[['连接 ID','id'],['服务器地址','host'],['端口','port'],['用户名','username'],['远程根目录','remoteRoot'],['SSH 私钥绝对路径','privateKeyPath'],['密码环境变量名称','passwordEnv'],['私钥环境变量名称','privateKeyEnv'],['登录密码（留空则沿用已记住的密码）','password'],['SSH 命令白名单，逗号分隔','execAllowlist']]
                  .map(([label,key])=>inputField(label,key,form,modifyForm,{password:key==='password'})),
                h('div',{className:'dr3-field'},h('label',null,'协议'),h('select',{className:'dr3-input',value:form.protocol,onChange:e=>modifyForm('protocol',e.target.value)},
                  [['ssh','SSH + SFTP（文件＋终端）'],['sftp','仅 SFTP（文件）'],['ftps','FTPS'],['ftp','FTP']].map(([v,label])=>h('option',{value:v,key:v},label)))),
                h('div',{className:'dr3-field'},
                  h('label',null,'记住密码'),
                  h('select',{className:'dr3-input',value:form.rememberMode||'none',onChange:e=>modifyForm('rememberMode',e.target.value)},
                    h('option',{value:'none'},'不记住（仅本次 Harness 运行有效）'),
                    h('option',{value:'obfuscate'},'混淆（可逆；不安全）'),
                    h('option',{value:'aes'},'AES-256-GCM（Windows DPAPI 保护密钥）')),
                  h('small',{className:'dr3-tip'},form.rememberMode==='obfuscate'?'混淆可轻易还原密码，只防止随手查看文件。':form.rememberMode==='aes'?'Windows 使用当前用户 DPAPI，重装系统/换用户后需重新输入；非 Windows 需要设置 DSH_REMOTE_VAULT_KEY。':'重启 Harness 需要重新输入密码。')
                ),
                (form.protocol==='ssh'||form.protocol==='sftp')&&h('p',{className:'dr3-tip',style:{gridColumn:'1/-1'}},
                  '使用插件自身的 SSH/SFTP 管理远程服务器：无需资源管理器、SSHFS 或本地项目绑定。终端认证失败时请检查用户名/密码、SSH 私钥、服务器登录策略；勾选记住密码后重启可自动恢复。'),
                (form.protocol==='ssh'||form.protocol==='sftp')&&h('div',{className:'dr3-field'},
                  h('label',null,'SSH 主机身份验证'),
                  h('select',{className:'dr3-input',value:form.hostTrustMode,onChange:e=>modifyForm('hostTrustMode',e.target.value)},
                    h('option',{value:'tofu'},'自动记住首次连接指纹（推荐，无需手动 SHA-256）'),
                    h('option',{value:'pinned'},'手动固定 SHA-256 指纹'),
                    h('option',{value:'insecure'},'跳过主机身份校验（不安全）')),
                  h('small',{className:'dr3-tip'},form.hostTrustMode==='tofu'?'首次连接自动记录指纹；服务器指纹变化时阻止连接。首次连接请使用可信网络。':form.hostTrustMode==='pinned'?'请独立核验服务器的 SHA-256 指纹。':'可能被中间人劫持；仅用于隔离的临时测试环境。')
                ),
                (form.protocol==='ssh'||form.protocol==='sftp')&&form.hostTrustMode==='tofu'&&form.trustedHostKeySha256&&h('div',{className:'dr3-field'},
                  h('label',null,'已保存的首次主机指纹（自动校验）'),
                  h('code',{className:'dr3-path'},form.trustedHostKeySha256),
                  button('清除已记录的指纹',()=>task(async()=>{
                    if(!await askConfirm('只有在已经独立确认服务器身份或重新安装服务器时，才清除已记录指纹。确认继续？'))return;
                    await api('forget_host_key',{id:form.id});modifyForm('trustedHostKeySha256','');
                    setNotice('首次信任记录已清除；下次连接会记录服务器当前指纹。');
                  }),{danger:true})
                ),
                (form.protocol==='ssh'||form.protocol==='sftp')&&form.hostTrustMode==='pinned'&&h(React.Fragment,null,
                  inputField('SSH 主机指纹 SHA-256','hostKeySha256',form,modifyForm),
                  inputField('指纹环境变量名称','hostKeySha256Env',form,modifyForm)
                ),
                form.protocol==='ssh'&&h('label',null,
                  h('input',{type:'checkbox',checked:form.terminalEnabled,onChange:e=>modifyForm('terminalEnabled',e.target.checked)}),
                  ' 允许此连接打开交互式 SSH 终端（执行任意命令，不受 AI 命令白名单限制）'
                ),
                h('label',null,h('input',{type:'checkbox',checked:form.readOnly,onChange:e=>modifyForm('readOnly',e.target.checked)}),' 远程文件操作只读（关闭可编辑远程文件；SSH Shell 命令另需逐次审批）'),
                h('label',null,h('input',{type:'checkbox',checked:form.allowInsecureFtp,onChange:e=>modifyForm('allowInsecureFtp',e.target.checked)}),' 允许明文 FTP（不安全）'),
                h('div',null,button('保存连接',()=>task(saveProfile),{primary:true,disabled:busy}))
              )
            )
          ):
        view==='monitor'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('b',null,'Linux 服务器监控 · '+selected),h('span',{className:'dr3-grow'}),
              button('刷新',()=>task(()=>loadOperations('monitor',selected)),{disabled:busy}),
              h('span',{className:'dr3-tip'},metrics?.capturedAt?new Date(metrics.capturedAt).toLocaleTimeString():'尚未采集')),
            h('div',{className:'dr3-scroll'},
              !metrics?h('p',{className:'dr3-muted'},'点击「刷新」获取服务器状态。无需安装远程代理。'):
              h(React.Fragment,null,
                h('div',{className:'dr3-metrics'},
                  metric('CPU 使用率',metrics.cpuPercent===null?'—':metrics.cpuPercent+'%','根据 /proc/stat 两次采样计算'),
                  metric('系统负载',(metrics.load||[]).map(x=>x.toFixed(2)).join(' / '),'1 / 5 / 15 分钟'),
                  metric('内存使用',displaySize(metrics.memory.usedBytes),`总量 ${displaySize(metrics.memory.totalBytes)}`),
                  metric('Swap 使用',displaySize(metrics.memory.swapUsedBytes),`总量 ${displaySize(metrics.memory.swapTotalBytes)}`),
                  metric('运行时长',((metrics.uptimeSeconds||0)/3600).toFixed(1)+' 小时')),
                h('h3',null,'磁盘分区'),
                h('div',{className:'dr3-table-wrap'},h('table',{className:'dr3-table'},
                  h('thead',null,h('tr',null,...['挂载点','文件系统','已用 / 总量','占用'].map(v=>h('th',{key:v},v)))),
                  h('tbody',null,(metrics.disks||[]).map((d,i)=>h('tr',{key:i},h('td',null,d.mount),h('td',null,d.filesystem),
                    h('td',null,displaySize(d.usedBytes)+' / '+displaySize(d.totalBytes)),h('td',null,d.usedPercent+'%')))))),
                h('h3',null,'网卡累计传输'),
                h('p',{className:'dr3-muted'},'收发字节为系统启动以来累计值，不是实时带宽。'),
                h('div',{className:'dr3-table-wrap'},h('table',{className:'dr3-table'},
                  h('thead',null,h('tr',null,...['接口','接收','发送'].map(v=>h('th',{key:v},v)))),
                  h('tbody',null,(metrics.interfaces||[]).map(n=>h('tr',{key:n.name},h('td',null,n.name),
                    h('td',null,displaySize(n.rxBytes)),h('td',null,displaySize(n.txBytes))))))))),
            h('div',{className:'dr3-footer'},'按需采集 · Linux /proc 与 df · 只读 SSH · 不在远程服务器安装代理')
          ):
        view==='processes'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('b',null,'进程管理 · '+selected),h('span',{className:'dr3-grow'}),
              h('input',{className:'dr3-input',type:'search',placeholder:'按进程名 / 用户 / PID 过滤',value:processSearch,onChange:e=>setProcessSearch(e.target.value)}),
              button('刷新',()=>task(()=>loadOperations('processes',selected)),{disabled:busy})),
            h('div',{className:'dr3-scroll'},
              h('p',{className:'dr3-muted'},'按 CPU 排序，仅展示前 200 项。结束进程前请核对 PID；系统可能复用 PID。'),
              h('div',{className:'dr3-table-wrap'},h('table',{className:'dr3-table'},
                h('thead',null,h('tr',null,...['PID','用户','CPU','内存','RSS','状态','进程','操作'].map(v=>h('th',{key:v},v)))),
                h('tbody',null,(processData?.processes||[]).filter(p=>[p.pid,p.user,p.command].some(v=>String(v).toLowerCase().includes(processSearch.toLowerCase()))).map(p=>
                  h('tr',{key:p.pid},h('td',null,p.pid),h('td',null,p.user),h('td',null,p.cpuPercent+'%'),
                    h('td',null,p.memoryPercent+'%'),h('td',null,displaySize(p.rssBytes)),h('td',null,p.state),h('td',null,p.command),
                    h('td',null,button('TERM',()=>task(()=>signalProcess(p.pid,'TERM')),{disabled:busy}),
                      button('KILL',()=>task(()=>signalProcess(p.pid,'KILL')),{danger:true,disabled:busy}))))))),
              !processData&&h('p',{className:'dr3-muted'},'尚未读取进程列表。')),
            h('div',{className:'dr3-footer'},'TERM 请求正常退出 · KILL 强制终止（需输入确认词）· 按远程账户权限执行')
          ):
        view==='services'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('b',null,'systemd 服务 · '+selected),h('span',{className:'dr3-grow'}),
              button('刷新',()=>task(()=>loadOperations('services',selected)),{disabled:busy})),
            h('div',{className:'dr3-scroll'},h('p',{className:'dr3-muted'},'列出前 160 项服务；操作权限由远程 SSH 账户决定。'),
              h('div',{className:'dr3-table-wrap'},h('table',{className:'dr3-table'},
                h('thead',null,h('tr',null,...['服务','状态','说明','操作'].map(v=>h('th',{key:v},v)))),
                h('tbody',null,(servicesData?.services||[]).map(s=>h('tr',{key:s.unit},
                  h('td',null,s.unit),h('td',null,s.active+' / '+s.sub),h('td',null,s.description),
                  h('td',null,...['start','restart','stop'].map(op=>button(op,()=>task(()=>controlService(s.unit,op)),
                    {danger:op==='stop',disabled:busy})))))))),
              !servicesData&&h('p',{className:'dr3-muted'},'尚未读取服务列表。')),
            h('div',{className:'dr3-footer'},'服务操作需确认，停止需输入确认词 · 仅支持使用 systemd 的 Linux 服务器')
          ):
        view==='terminal'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},button('← 文件列表',()=>setView('files')),
              h('b',null,'SSH 交互终端 · '+selected),h('span',{className:'dr3-grow'}),
              terminalDisconnected&&h('span',{className:'dr3-tip'},'会话已断开'),
              button('Ctrl+C',()=>task(()=>terminalCommand('\x03')),{disabled:terminalDisconnected}),
              button('断开终端',()=>task(closeTerminal),{danger:true,disabled:!terminalSession})),
            h('div',{className:'dr3-terminal',role:'log','aria-label':'SSH 终端输出'},
              (terminalOutput||'连接中…').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'')),
            h('div',{className:'dr3-terminal-bar'},
              h('input',{className:'dr3-input',value:terminalInput,disabled:terminalDisconnected,
                placeholder:'输入 SSH 命令，按 Enter 发送',onChange:e=>setTerminalInput(e.target.value),
                onKeyDown:e=>{
                  if(e.key==='Enter'){e.preventDefault();task(submitCommand);}
                  if(e.key==='ArrowUp'&&commandHistory.length){e.preventDefault();const next=Math.min(commandHistory.length-1,historyPosition+1);setHistoryPosition(next);setTerminalInput(commandHistory[next]);}
                  if(e.key==='ArrowDown'&&historyPosition>=0){e.preventDefault();const next=historyPosition-1;setHistoryPosition(next);setTerminalInput(next>=0?commandHistory[next]:'');}
                }}),button('发送',()=>task(submitCommand),{disabled:terminalDisconnected})),
            h('div',{className:'dr3-footer'},'持久 SSH PTY 会话 · 只支持行输入，尚不支持 vim/top 等全屏 TUI；断线不自动重放命令')
          ):
        view==='editor'?
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},button('← 文件列表',()=>task(async()=>{if(!dirty||await askConfirm('放弃未保存修改？'))setView('files');})),
              h('span',{className:'dr3-path'},file),dirty&&h('b',null,'● 未保存'),h('span',{className:'dr3-grow'}),
              button('保存 Ctrl+S',()=>task(saveFile),{primary:true,disabled:busy||readOnly})),
            h('textarea',{className:'dr3-editor',value:content,readOnly,onChange:e=>setContent(e.target.value),
              onKeyDown:e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(!readOnly)task(saveFile);}}}),
            h('div',{className:'dr3-footer'},'UTF-8 · SHA-256 冲突保护 · 网络失败时不自动重放写入')
          ):
          h(React.Fragment,null,
            h('div',{className:'dr3-tools'},h('span',{className:'dr3-path'},selected?selected+' : '+dir:'请选择服务器'),h('span',{className:'dr3-grow'}),...primaryTools,
              advancedTools.length&&h('details',{className:'dr3-more-actions'},h('summary',{className:'dr3-btn'},'更多操作'),h('div',{className:'dr3-more-panel'},...advancedTools)),
              helpTip('拖入文件到下方列表区域，或点击上传。单文件上限 128 MiB；同名文件不覆盖；取消可随时请求，但已经提交到远程服务器的文件不能撤销。')),
            h('div',{className:'dr3-scroll'+(dragActive?' dr3-dragging':''),
              onDragOver:e=>{e.preventDefault();if(!picked||readOnly||busy)return;e.dataTransfer.dropEffect='copy';setDragActive(true);},
              onDragLeave:e=>{if(!e.currentTarget.contains(e.relatedTarget))setDragActive(false);},
              onDrop:e=>{e.preventDefault();setDragActive(false);if(!picked||readOnly||busy)return;
                const entries=Array.from(e.dataTransfer.items||[]);
                if(entries.some(x=>x.webkitGetAsEntry?.()?.isDirectory)){setError('暂不支持直接拖拽文件夹；请选择文件上传。');return;}
                task(()=>uploadFiles(e.dataTransfer.files));}},
              !readOnly&&picked&&h('div',{className:'dr3-dropzone',role:'note'},dragActive?'松开上传到当前目录':'拖入文件上传（可多选）',helpTip('拖动本机的一个或多个文件到此区域。上传不覆盖同名文件，单文件上限 128 MiB；传输期间可在上方点击取消。')),
              transferProgress&&h('div',{className:'dr3-transfer-progress',role:'status'},transferProgress),
              h('table',{className:'dr3-table'},
                h('thead',null,h('tr',null,h('th',null,'名称'),h('th',null,'大小'),h('th',null,'修改时间'),h('th',null,'操作'))),
                h('tbody',null,files.map(f=>h('tr',{key:f.name},
                  h('td',null,h('button',{className:'dr3-link',onClick:()=>task(()=>f.type==='directory'?browse(dir.replace(/\/$/,'')+'/'+f.name):openFile(f))},f.type==='directory'?'📁 ':'📄 ',f.name)),
                  h('td',null,f.type==='directory'?'—':String(f.size||0)),h('td',null,f.modified?String(f.modified):'—'),
                  h('td',null,f.type==='file'&&button('下载',()=>task(()=>downloadFile(f)),{disabled:busy}),
                    !readOnly&&button('重命名',()=>task(()=>renameEntry(f))),
                    !readOnly&&button('删除',()=>task(()=>deleteEntry(f)),{danger:true})))))),
              files.length===0&&h('p',{className:'dr3-muted'},selected?'点击左侧服务器以连接，或点击「刷新」读取远程目录。':'请在左侧添加或选择服务器。')
            ),
            h('div',{className:'dr3-footer'},'插件托管远程工作区：文件使用连接协议，Shell 命令只支持 SSH；不使用资源管理器或 SSHFS · 删除工作区可清理插件标识文件')
          )
      )
    ),
    dialog && h('div',{className:'dr3-dialog-backdrop',onClick:e=>{if(e.target===e.currentTarget)finishDialog(null);}},
      h('section',{className:'dr3-dialog',role:'dialog','aria-modal':true,'aria-label':dialog.title,
        onKeyDown:e=>{if(e.key==='Escape'){e.preventDefault();finishDialog(null);}else if(e.key==='Enter'&&e.target?.tagName==='INPUT'){
          e.preventDefault();if(dialog.kind==='confirm')finishDialog(true);
          else if(dialog.kind==='input')finishDialog(dialogInput);
          else if(dialog.kind==='typed'&&dialogInput===dialog.confirmation)finishDialog(dialogInput);
        }}},
        h('h3',null,dialog.title),
        dialog.message&&h('pre',{className:'dr3-dialog-message'},dialog.message),
        dialog.kind==='typed'&&h('div',{className:'dr3-dialog-token'},'请输入确认词：'+dialog.confirmation),
        dialog.kind!=='confirm'&&h('input',{className:'dr3-input','aria-label':dialog.kind==='typed'?'输入清理确认词':'输入名称',
          autoFocus:true,autoComplete:'off',spellCheck:false,value:dialogInput,
          placeholder:dialog.kind==='typed'?dialog.confirmation:'请输入名称',onChange:e=>setDialogInput(e.target.value)}),
        h('div',{className:'dr3-dialog-actions'},
          button('取消',()=>finishDialog(null)),
          button(dialog.kind==='typed'?'确认清理本地数据':dialog.kind==='input'?'确定':'确认',()=>{
            finishDialog(dialog.kind==='confirm'?true:dialogInput);
          },{danger:dialog.kind==='typed',primary:dialog.kind!=='typed',
            disabled:dialog.kind==='typed'?dialogInput!==dialog.confirmation:dialog.kind==='input'?!dialogInput.trim():false})
        )
      )
    )
  );
}
// Keep optional UI failures from blocking Host activation.
const RW_CLIENT_DIAGNOSTICS_KEY = '__DSH_REMOTE_WORKSPACE_DIAGNOSTICS__';
function reportClientError(phase, error) {
  const detail = error && (error.stack || error.message) ? String(error.stack || error.message) : String(error);
  const entry = { phase, detail: detail.slice(0, 12000), at: new Date().toISOString() };
  try {
    // Only diagnostic exceptions, never connection data, credentials or context.
    const list = Array.isArray(window[RW_CLIENT_DIAGNOSTICS_KEY]) ? window[RW_CLIENT_DIAGNOSTICS_KEY] : [];
    list.push(entry);
    if (list.length > 10) list.shift();
    window[RW_CLIENT_DIAGNOSTICS_KEY] = list;
  } catch (_) { /* standalone Client simulation */ }
  try { console.error('[dsh-remote-workspace/client] ' + phase, error); } catch (_) {}
}
function SafePanel(props) {
  try { return Panel(props); }
  catch (error) {
    reportClientError('main.render', error);
    return h('div', {className:'dr3-root',style:{padding:'24px'}},
      h('h3', null, '远程工作区界面出现异常'),
      h('p', null, 'SSH/SFTP 后端不受影响。打开开发者工具 Console，查看 [dsh-remote-workspace/client] 日志。'),
      h('pre', {style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}, String(error?.stack || error)));
  }
}
function PanelIcon({size=18}) { return h('span',{style:{fontSize:size+'px',display:'inline-block',lineHeight:1},'aria-hidden':true},'▣'); }
exports.inject=['slots'];
exports.apply=function apply(ctx) {
  // Different Desktop releases may reject an optional slot at registration
  // time. A failed sidebar/panel extension should be logged, not break Web boot.
  const contribute = (name, options, component) => {
    const register = () => {
      try {
        return ctx.slots.register(options, component);
      } catch (error) {
        reportClientError('slots.register:' + name, error);
        return undefined;
      }
    };
    try {
      const result = ctx.slots.inject(name, register);
      // Guard implementations that report deferred injection failures.
      if (result && typeof result.catch === 'function') {
        return result.catch(error => reportClientError('slots.inject.async:' + name, error));
      }
      return result;
    } catch (error) {
      reportClientError('slots.inject:' + name, error);
      return undefined;
    }
  };
  contribute('sidebar.panellist', {
    name:'sidebar.panellist', id:NAV_ID, order:85, label:'远程工作区'
  }, PanelIcon);
  contribute('main', {name:'main', key:NAV_ID}, SafePanel);
};
