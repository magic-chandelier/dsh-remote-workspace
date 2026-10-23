'use strict';
// Interactive SSH PTY sessions are an explicit opt-in, separate from AI remote_exec.
// Sessions are memory only; disconnect never auto-replays commands or auto-restarts a shell.
const crypto = require('node:crypto');
const { authOptions } = require('./remote.cjs');
const MAX_BUFFER = 128 * 1024;
const MAX_SESSIONS = 4;
const IDLE_MS = 15 * 60 * 1000;
const CLOSED_MS = 60 * 1000;
function dims(n, fallback, min, max) {
  const x = Number(n);
  return Number.isInteger(x) && x >= min && x <= max ? x : fallback;
}
class TerminalManager {
  constructor(store, options = {}) {
    this.store = store;
    this.sessions = new Map();
    this.Client = options.Client || null;
    this.now = options.now || (() => Date.now());
    this.timer = null;
    this.pending = new Set();
    this.stopped = false;
  }
  sweep() {
    const now = this.now();
    for (const [id,s] of this.sessions) {
      if (now - s.lastUsed > (s.closed ? CLOSED_MS : IDLE_MS)) this.close(id);
    }
  }
  async open(id, cols = 100, rows = 28) {
    if (this.stopped) throw new Error('SSH terminal manager has stopped');
    this.sweep();
    const p = this.store.profile(id);
    if (p.protocol !== 'ssh') throw new Error('Interactive terminal requires SSH + SFTP protocol');
    if (!p.terminalEnabled) throw new Error('SSH terminal is disabled for this connection; enable it explicitly');
    if ([...this.sessions.values()].filter(x=>!x.closed).length >= MAX_SESSIONS) throw new Error('Maximum 4 active SSH terminals');
    const client = this.Client ? new this.Client() : new (require('ssh2').Client)();
    const sessionId = crypto.randomBytes(20).toString('hex');
    const pending = { client, cancel: null };
    this.pending.add(pending);
    const s = { id: sessionId, profile:p.id, client, channel:null, output:'', closed:false,
      lastUsed:this.now(), exitCode:null, reason:'' };
    const append = chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      s.output = (s.output + text).slice(-MAX_BUFFER);
    };
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        pending.cancel = () => finish(new Error('SSH terminal manager has stopped'));
        if (this.stopped) { pending.cancel(); return; }
        timeout = setTimeout(() => finish(new Error('SSH terminal connection timed out')), 20000);
        function finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error); else resolve();
        }
        client.on('error', error => { if(!settled) finish(error); else {s.closed=true; s.reason=error.message;} });
        client.on('close', () => {s.closed=true;});
        client.once('ready', () => {
          if (this.stopped) { finish(new Error('SSH terminal manager has stopped')); return; }
          client.shell({term:'xterm',cols:dims(cols,100,20,300),rows:dims(rows,28,5,100)}, (err, channel) => {
            if (err) return finish(err);
            if (settled || this.stopped) {
              try { channel?.close?.(); } catch (_) {}
              finish(new Error('SSH terminal manager has stopped'));
              return;
            }
            s.channel = channel;
            channel.on('data', append);
            channel.stderr?.on('data', append);
            channel.on('close', (code) => {s.closed=true;s.exitCode=code??null;});
            channel.on('error', err => {s.closed=true;s.reason=err.message;});
            finish();
          });
        });
        try { client.connect(authOptions(p,this.store)); } catch (err) { finish(err); }
      });
    } catch (error) {
      this.pending.delete(pending);
      client.end();
      if (/all configured authentication methods failed|all authentication methods have failed/i.test(String(error?.message)))
        throw new Error('SSH authentication failed: check username, password/private-key and SSH login policy. After a Harness restart, re-enter a session-only password or enable remember-password; keyboard-interactive password is supported, MFA/OTP requires separate handling.');
      throw error;
    }
    this.pending.delete(pending);
    if (this.stopped) {
      try { s.channel?.close?.(); } catch (_) {}
      client.end();
      throw new Error('SSH terminal manager has stopped');
    }
    this.sessions.set(sessionId,s);
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), 60_000);
      this.timer.unref?.();
    }
    return { sessionId, profile:p.id, connected:true };
  }
  get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{40}$/.test(id)) throw new Error('Invalid SSH session');
    this.sweep();
    const s=this.sessions.get(id);
    if (!s) throw new Error('Terminal session expired or not found');
    s.lastUsed=this.now();
    return s;
  }
  poll(id) {
    const s=this.get(id), output=s.output;
    s.output='';
    return {sessionId:id,output,closed:s.closed,exitCode:s.exitCode,reason:s.reason};
  }
  send(id, input) {
    const s=this.get(id);
    if (s.closed || !s.channel) throw new Error('Terminal is disconnected. Open a new terminal; commands will not be replayed.');
    if (typeof input !== 'string' || Buffer.byteLength(input,'utf8') > 8192) throw new Error('Terminal input exceeds 8 KiB');
    s.channel.write(input);
    return {sent:Buffer.byteLength(input,'utf8')};
  }
  resize(id, cols, rows) {
    const s=this.get(id);
    if (s.closed) throw new Error('Terminal is disconnected');
    const c=dims(cols,100,20,300), r=dims(rows,28,5,100);
    s.channel.setWindow?.(r,c,0,0);
    return {cols:c,rows:r};
  }
  close(id) {
    const s=this.sessions.get(id);
    if (!s) return {closed:true};
    this.sessions.delete(id);
    if (!this.sessions.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    s.closed=true;
    try {s.channel?.close?.();} catch (_) {}
    try {s.client.end();} catch (_) {}
    return {closed:true};
  }
  closeAll() {
    for (const pending of this.pending) {
      pending.cancel?.();
      try { pending.client.end(); } catch (_) {}
    }
    this.pending.clear();
    for (const id of [...this.sessions.keys()]) this.close(id);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.closeAll();
  }
}
module.exports = {TerminalManager,MAX_BUFFER,MAX_SESSIONS,IDLE_MS};
