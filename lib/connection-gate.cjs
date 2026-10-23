'use strict';

// Agent authorization is not an SSH socket. Each remote operation still makes
// its own connection; this gate authorizes the first connection of a session.
const crypto = require('node:crypto');

function fingerprint(store, id) {
  const p = store.profile(id);
  return crypto.createHash('sha256').update(JSON.stringify([
    p.id, p.protocol, p.host, p.port, p.username, p.remoteRoot,
    store.workspace(id), p.privateKeyPath, p.privateKeyEnv, p.passwordEnv,
    p.rememberMode, store.revision?.(id) || 0,
  ])).digest('hex');
}
function hasReusableAuth(store, id) {
  const p = store.profile(id);
  if (p.privateKeyPath || (p.privateKeyEnv && process.env[p.privateKeyEnv])) return true;
  if (p.passwordEnv && process.env[p.passwordEnv]) return true;
  // A password typed but not remembered is not permission for AI auto-connect.
  return Boolean(store.vault && store.vault.status(id, p) !== 'none');
}
function contextKey(exec) {
  const session = exec?.agent?.session;
  if (typeof session === 'string' || typeof session === 'number') return `session:${session}`;
  const stableId = session?.id ?? session?.sessionId;
  if (typeof stableId === 'string' || typeof stableId === 'number') return `session:${stableId}`;
  if (session && (typeof session === 'object' || typeof session === 'function')) return session;
  return exec?.agent || null;
}
async function requestPermission(questions, exec, p) {
  if (!exec?.agent || !exec?.signal || exec.signal.aborted || !questions?.ask)
    throw new Error('远程连接需要用户审批；当前会话无法弹出审批，请先在插件页面手动连接。不会改用本地工具。');
  const id = 'rw-connect-approval';
  const reply = await questions.ask({
    questions: [{id, header:'连接远程服务器',
      question:`DeepSeek 请求连接 ${p.username}@${p.host}:${p.port}，是否允许？`,
      detail:`连接 ID：${p.id}\n远程工作区：${p.remoteRoot}\n将使用已保存的凭据验证远程连接。此授权仅适用于当前 AI 会话，不代表批准修改服务器或执行命令。`,
      options:[
        {label:'允许连接',description:'验证连接并在当前会话中使用远程工具'},
        {label:'暂不连接',description:'保持远程工作区未连接，不操作本地文件'},
      ]}],agent:exec.agent,signal:exec.signal,
  });
  const answers = reply?.answers?.filter(answer => answer.id === id) || [];
  if (answers.length !== 1 || answers[0].selected?.length !== 1 ||
      answers[0].selected[0] !== '允许连接' || answers[0].custom !== undefined)
    throw new Error('用户未批准连接远程服务器，AI 不会操作本机文件。');
}
async function requestManualConnection(questions, exec, p) {
  const instructions = `远程工作区 ${p.id} 未记住登录密码。请打开插件「远程工作区」，输入密码并保存（选择“不记住”），点击「手动连接供 AI 使用」。确认连接成功后再继续。AI 不会操作本地文件夹。`;
  if (!exec?.agent || !exec?.signal || exec.signal.aborted || !questions?.ask)
    throw new Error(instructions);
  const id = 'rw-manual-connect';
  const reply = await questions.ask({questions:[{id,header:'需要手动连接远程服务器',
    question:`请先手动连接 ${p.username}@${p.host}:${p.port}，完成后选择「已手动连接」。`,
    detail:instructions,
    options:[{label:'已手动连接',description:'我已在插件页面验证连接'},
      {label:'取消',description:'保持离线，不使用本地文件工具'}]}],
    agent:exec.agent,signal:exec.signal});
  const answers=reply?.answers?.filter(answer=>answer.id===id) || [];
  if (answers.length!==1 || answers[0].selected?.length!==1 ||
      answers[0].selected[0]!=='已手动连接' || answers[0].custom!==undefined)
    throw new Error('用户未完成手动连接。' + instructions);
}
class ConnectionGate {
  constructor(store, remote, getQuestions = () => null) {
    this.store = store;
    this.remote = remote;
    this.getQuestions = getQuestions;
    this.objectSessions = new WeakMap();
    this.idSessions = new Map();
    this.manual = new Map();
    this.objectPending = new WeakMap();
    this.idPending = new Map();
    this.epochs = new Map();
    this.stopped = false;
  }
  sessionMap(key) {return typeof key === 'string' ? this.idSessions.get(key) : this.objectSessions.get(key);}
  setSessionMap(key,value) {
    if (typeof key === 'string') {
      // Bounded string session IDs; object keys use weak references.
      if (this.idSessions.size >= 256 && !this.idSessions.has(key)) this.idSessions.delete(this.idSessions.keys().next().value);
      this.idSessions.set(key,value);
    } else this.objectSessions.set(key,value);
  }
  state(id, exec) {
    if (this.stopped) throw new Error('Remote workspace plugin has stopped');
    const stamp = fingerprint(this.store,id);
    const key = contextKey(exec);
    const token = stamp + ':' + (this.epochs.get(id) || 0);
    const granted = key && this.sessionMap(key)?.get(id) === token;
    const manualProof = this.manual.get(id);
    const manualReady = Boolean(manualProof && manualProof.token === token && manualProof.expires > Date.now());
    const reusable = hasReusableAuth(this.store,id);
    return {profile:id, authorized:Boolean(granted), manualReady,
      method:granted?'approved':null,
      credentialAvailable:reusable, next:granted?'ready':reusable?'request-approval':'manual-connect'};
  }
  async ensure(id,exec) {
    const state = this.state(id,exec);
    if (exec?.signal?.aborted) throw new Error('Remote connection authorization aborted');
    if (state.authorized) return state;
    const key = contextKey(exec);
    if (!key) throw new Error('远程连接需要有效的 AI 会话，禁止无身份自动连接。');
    const pending = typeof key === 'string' ? this.idPending : this.objectPending;
    let concurrent = pending.get(key);
    if (!concurrent) { concurrent = new Map();pending.set(key,concurrent); }
    if (concurrent.has(id)) return concurrent.get(id);
    const expected = fingerprint(this.store,id);
    const epoch = this.epochs.get(id) || 0;
    const attempt = (async () => {
      if (!state.credentialAvailable) {
        await requestManualConnection(this.getQuestions(),exec,this.store.profile(id));
        if (this.stopped) throw new Error('Remote workspace plugin has stopped');
        if (exec.signal?.aborted) throw new Error('Remote connection authorization aborted');
        const current = this.state(id,exec);
        const proof = this.manual.get(id);
        if (!current.manualReady || !proof || proof.token !== expected + ':' + epoch ||
            fingerprint(this.store,id)!==expected || (this.epochs.get(id) || 0)!==epoch)
          throw new Error('尚未完成经过验证的手动连接。请在插件页面点击「手动连接供 AI 使用」后重试，不能改用本地文件工具。');
        // A verified manual action is a single-use handoff, not permission for all chats.
        this.manual.delete(id);
        const allowed = this.sessionMap(key) || new Map();
        allowed.set(id, expected + ':' + epoch); this.setSessionMap(key,allowed);
        return this.state(id,exec);
      }
      await requestPermission(this.getQuestions(),exec,this.store.profile(id));
      if (this.stopped) throw new Error('Remote workspace plugin has stopped');
        if (exec.signal?.aborted) throw new Error('Remote connection authorization aborted');
      if (fingerprint(this.store,id) !== expected) throw new Error('远程服务器配置已变化，请重新确认连接。');
      await this.remote.test(id);
      if (this.stopped) throw new Error('Remote workspace plugin has stopped');
        if (exec.signal?.aborted) throw new Error('Remote connection authorization aborted');
      if (fingerprint(this.store,id) !== expected || (this.epochs.get(id) || 0) !== epoch)
        throw new Error('连接验证期间配置或授权已变化，请重试。');
      const allowed = this.sessionMap(key) || new Map();
      allowed.set(id,expected + ':' + epoch);this.setSessionMap(key,allowed);
      return this.state(id,exec);
    })();
    concurrent.set(id,attempt);
    try {return await attempt;}
    finally {concurrent.delete(id);if (!concurrent.size)pending.delete(key);}
  }
  async connectManually(id) {
    if (this.stopped) throw new Error('Remote workspace plugin has stopped');
    const p = this.store.profile(id);
    if (!['ssh','sftp','ftp','ftps'].includes(p.protocol)) throw new Error('Unsupported remote connection protocol');
    const expected = fingerprint(this.store,id);
    const epoch = this.epochs.get(id) || 0;
    if (!this.store.passwordFor(id) && !p.privateKeyPath && !(p.privateKeyEnv && process.env[p.privateKeyEnv]))
      throw new Error('请先编辑连接并输入登录密码，再手动连接。');
    await this.remote.test(id);
    if (this.stopped) throw new Error('Remote workspace plugin has stopped');
    if (fingerprint(this.store,id) !== expected || (this.epochs.get(id) || 0) !== epoch)
      throw new Error('连接验证期间配置或授权已变化，请重试。');
    this.manual.set(id,{token:expected + ':' + epoch,expires:Date.now()+120000});
    return {profile:id,connected:true,authorized:false,manualReady:true,method:'manual-pending'};
  }
  disconnect(id) {
    this.manual.delete(id);
    this.epochs.set(id,(this.epochs.get(id) || 0)+1);
    for (const grants of this.idSessions.values()) grants.delete(id);
    return {profile:id,authorized:false};
  }
  clear() {this.stopped = true;this.objectSessions = new WeakMap();this.idSessions.clear();this.manual.clear();this.objectPending = new WeakMap();this.idPending.clear();this.epochs.clear();}
}
module.exports = {ConnectionGate,hasReusableAuth,fingerprint,requestPermission,requestManualConnection};
