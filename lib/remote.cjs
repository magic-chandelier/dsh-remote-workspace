'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stream = require('node:stream');
const MAX_TEXT = 1024 * 1024;
const MAX_BINARY = 8 * 1024 * 1024;
const MAX_UI = 512 * 1024;
// Operations use short-lived sessions; retry only idempotent READ operations.
const RETRY_DELAYS_MS = [350, 900];
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
function isTransientConnectionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  // Credential, SSH host-key, permission and missing-directory errors never retry.
  if (/auth(?:entication)? fail|permission denied|access denied|host.?key|fingerprint|verification failed|no such file|not found|not a directory|symlink|outside|invalid|certificate|login incorrect|530\b/i.test(message)) return false;
  return TRANSIENT_CODES.has(code) || /connection (?:lost|closed|reset|refused|timed out)|socket hang up|connect ETIMEDOUT|network (?:unreachable|error)|unexpected end of (?:stream|file)/i.test(message);
}
async function retryTransient(task, { delays = RETRY_DELAYS_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await task(); }
    catch (error) {
      if (attempt >= delays.length || !isTransientConnectionError(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function checkedPath(root, input = '.') {
  const posix = path.posix;
  const base = posix.resolve('/', String(root || '/'));
  const str = String(input == null || input === '' ? '.' : input);
  if (str.includes('\0') || /[\r\n]/.test(str)) throw new Error('Invalid remote path');
  const resolved = str.startsWith('/') ? posix.resolve('/', str) : posix.resolve(base, str);
  if (resolved !== base && !resolved.startsWith(base.replace(/\/$/, '') + '/')) throw new Error('Path is outside remote workspace');
  return resolved;
}
function localPath(root, input) {
  if (!root) throw new Error('Local transfer root not configured');
  const normalized = path.resolve(root);
  const file = path.resolve(normalized, input);
  if (file !== normalized && !file.startsWith(normalized + path.sep)) throw new Error('Local path outside transfer root');
  if (fs.lstatSync(normalized).isSymbolicLink()) throw new Error('Local transfer root cannot be a symbolic link');
  let entry;
  try { entry = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entry?.isSymbolicLink()) throw new Error('Local transfer source or target cannot be a symbolic link');
  const actualRoot = fs.realpathSync(normalized);
  const parent = entry ? fs.realpathSync(file) : fs.realpathSync(path.dirname(file));
  if (parent !== actualRoot && !parent.startsWith(actualRoot + path.sep)) throw new Error('Local transfer symlink escapes root');
  return file;
}
function getPinned(p) {
  const value = p.hostKeySha256 || (p.hostKeySha256Env ? process.env[p.hostKeySha256Env] : '');
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const base64 = String(value).replace(/^SHA256:/, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(base64)) throw new Error('Invalid SSH SHA-256 fingerprint');
  return Buffer.from(base64, 'base64').toString('hex');
}
function authOptions(p, store) {
  const result = { host: p.host, port: p.port, username: p.username, readyTimeout: 15000, timeout: 15000 };
  const password = typeof store.passwordFor === 'function' ? store.passwordFor(p.id) : (store.sessionPasswords.get(p.id) || (p.passwordEnv ? process.env[p.passwordEnv] : ''));
  if (password) result.password = password;
  if (p.privateKeyPath) result.privateKey = fs.readFileSync(p.privateKeyPath);
  else if (p.privateKeyEnv && process.env[p.privateKeyEnv]) result.privateKey = process.env[p.privateKeyEnv];
  if (p.passphraseEnv && process.env[p.passphraseEnv]) result.passphrase = process.env[p.passphraseEnv];
  // ssh2's default tryKeyboard requires an event handler. Explicit authHandler
  // objects work with both raw ssh2 Clients and ssh2-sftp-client's wrapper.
  // Never auto-answer OTP/2FA prompts using the account password.
  if (password && (p.protocol === 'ssh' || p.protocol === 'sftp')) {
    const sequence = [{ type: 'password', username: p.username, password }];
    if (result.privateKey) sequence.push({ type: 'publickey', username: p.username, key: result.privateKey, passphrase: result.passphrase });
    sequence.push({ type: 'keyboard-interactive', username: p.username,
      prompt(_name, _instructions, _language, prompts, finish) {
        if (prompts.length === 1 && typeof prompts[0]?.prompt === 'string' &&
            /(?:password|passwd|密码)/i.test(prompts[0].prompt) && !/otp|one.time|verification code|验证码|令牌/i.test(prompts[0].prompt)) {
          finish([password]);
        } else finish([]); // MFA needs an explicit separate interaction.
      } });
    result.authHandler = sequence;
  }
  if (p.protocol === 'sftp' || p.protocol === 'ssh') {
    const mode = p.hostTrustMode || ((p.hostKeySha256 || p.hostKeySha256Env) ? 'pinned' : 'tofu');
    if (mode === 'pinned') {
      const pin = getPinned(p);
      if (!pin) throw new Error('Pinned mode requires SHA-256 fingerprint');
      result.hostHash = 'sha256';
      result.hostVerifier = hex => typeof hex === 'string' && hex.toLowerCase() === pin;
    } else if (mode === 'tofu') {
      result.hostHash = 'sha256';
      result.hostVerifier = hex => {
        if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/i.test(hex)) return false;
        try { return store.rememberHostKey(p.id, hex.toLowerCase()); }
        catch (_) { return false; } // failure to persist trust must reject connection
      };
    } else if (mode === 'insecure') {
      // Explicit opt-out ONLY. ssh2's default host-key behavior accepts without checking.
      result.hostVerifier = () => true;
    } else throw new Error('Unknown SSH trust mode');
  }
  return result;
}
async function withRemote(p, store, fn, options = {}) {
  const attempt = async () => {
    if (p.protocol === 'sftp' || p.protocol === 'ssh') {
      const Sftp = require('ssh2-sftp-client');
      const client = new Sftp('dsh-remote-workspace');
      try {
        await client.connect(authOptions(p, store));
        return await fn({ kind: 'sftp', client });
      } finally { try { await client.end(); } catch (_) {} }
    }
    if (p.protocol === 'ftp' && !p.allowInsecureFtp) throw new Error('Plaintext FTP is disabled; enable allowInsecureFtp explicitly');
    const ftp = require('basic-ftp');
    const client = new ftp.Client(15000);
    client.ftp.verbose = false;
    try {
      await client.access({ host: p.host, port: p.port, user: p.username,
        password: typeof store.passwordFor === 'function' ? store.passwordFor(p.id) : (store.sessionPasswords.get(p.id) || (p.passwordEnv && process.env[p.passwordEnv]) || ''),
        secure: p.protocol === 'ftps',
        secureOptions: p.protocol === 'ftps' ? { rejectUnauthorized: true } : undefined });
      return await fn({ kind: 'ftp', client });
    } finally { client.close(); }
  };
  return options.retryRead ? retryTransient(attempt) : attempt();
}
async function ensureSftpBoundary(session, root, target, creating = false) {
  if (session.kind !== 'sftp') return;
  const c = session.client;
  const baseReal = await c.realPath(root);
  const verify = (base, real) => {
    if (real !== base && !real.startsWith(base.replace(/\/$/, '') + '/')) throw new Error('Symbolic link escapes allowed remote directory');
  };
  const check = creating ? path.posix.dirname(target) : target;
  const checkReal = await c.realPath(check);
  verify(baseReal, checkReal);
}
// The bound workspace can be narrower than the server root. A symlink that
// stays inside remoteRoot may still escape the bound project's directory.
// Validate the bound root against the server root, then the operation target
// against the bound root, resolving SFTP symlinks on the remote host.
async function ensureRemoteBoundary(session, remoteRoot, workspaceRoot, target, creating = false) {
  await ensureSftpBoundary(session, remoteRoot, workspaceRoot);
  await ensureSftpBoundary(session, workspaceRoot, target, creating);
}
function toInfo(x) {
  const name = x.name || '';
  const type = x.type === 'd' || x.type === 2 ? 'directory' : x.type === 'l' || x.type === 3 ? 'symlink' : 'file';
  return { name, type, size: Number(x.size || 0), modified: x.modifyTime || x.modifiedAt || null };
}
function editAllowed(p) { if (p.readOnly !== false) throw new Error('Connection is read-only; explicitly disable readOnly to modify remote files'); }
class RemoteManager {
  constructor(store, options = {}) { this.store = store; this.localRoot = options.localRoot || ''; this.connect = options.connect || withRemote; }
  context(id, input, browse = false) {
    const p = this.store.profile(id);
    const base = browse ? p.remoteRoot : this.store.workspace(p.id);
    return { p, base, target: checkedPath(base, input) };
  }
  async list(id, pathname = '.', browse = false) {
    const { p, base, target } = this.context(id, pathname, browse);
    return this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      const entries = await s.client.list(target);
      return { profile: p.id, directory: target, workspace: this.store.workspace(p.id),
        entries: entries.filter(x => x.name !== '.' && x.name !== '..').map(toInfo).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1) };
    }, { retryRead: true });
  }
  async stat(id, pathname = '.') {
    const { p, base, target } = this.context(id, pathname);
    return this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      if (s.kind === 'sftp') { const x = await s.client.stat(target); return { path: target, size: Number(x.size), modified: x.modifyTime, directory: x.isDirectory }; }
      const dir = path.posix.dirname(target), name = path.posix.basename(target);
      const x = (await s.client.list(dir)).find(e => e.name === name);
      if (!x) throw new Error('File not found');
      return { path: target, size: Number(x.size), modified: x.modifiedAt, directory: x.type === 2 };
    }, { retryRead: true });
  }
  async read(id, pathname) {
    const { p, base, target } = this.context(id, pathname);
    return this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      let bytes;
      if (s.kind === 'sftp') {
        const st = await s.client.stat(target);
        if (st.size > MAX_TEXT) throw new Error('Text file exceeds 1 MiB preview limit');
        bytes = await s.client.get(target);
      } else {
        const chunks = [];
        let size = 0;
        const out = new stream.Writable({ write(chunk, _, cb) {
          size += chunk.length;
          if (size > MAX_TEXT) return cb(new Error('Text file exceeds preview limit'));
          chunks.push(Buffer.from(chunk));
          cb();
        } });
        await s.client.downloadTo(out, target);
        bytes = Buffer.concat(chunks);
      }
      if (bytes.length > MAX_TEXT || bytes.includes(0)) throw new Error('Binary or oversized file cannot be edited as text');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const content = decoder.decode(bytes);
      return { path: target, content, sha256: sha(bytes), bytes: bytes.length };
    }, { retryRead: true });
  }
  async write(id, pathname, content, expectedSha) {
    const { p, base, target } = this.context(id, pathname); editAllowed(p);
    if (typeof content !== 'string') throw new Error('Text content required');
    if (typeof expectedSha !== 'string') throw new Error('expectedSha256 required (read first; use empty string only for a new file)');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_TEXT) throw new Error('File exceeds text edit limit');
    return this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target, true);
      let old;
      try {
        if (s.kind === 'sftp') {
          const info = await s.client.stat(target);
          if (info.size > MAX_TEXT) throw new Error('Existing file exceeds 1 MiB edit limit');
          old = await s.client.get(target);
        } else {
          const entry = (await s.client.list(path.posix.dirname(target))).find(x => x.name === path.posix.basename(target));
          if (entry && entry.size > MAX_TEXT) throw new Error('Existing file exceeds 1 MiB edit limit');
          const chunks = []; let size = 0;
          await s.client.downloadTo(new stream.Writable({ write(b, _, cb) {
            size += b.length;
            if (size > MAX_TEXT) return cb(new Error('Existing file exceeds 1 MiB edit limit'));
            chunks.push(Buffer.from(b)); cb();
          } }), target);
          old = Buffer.concat(chunks);
        }
      } catch (e) {
        if (expectedSha !== '' || !/(not found|no such file|550|ENOENT|does not exist)/i.test(String(e.message))) throw e;
      }
      if (old && s.kind === 'sftp') await ensureRemoteBoundary(s, p.remoteRoot, base, target); // Also reject existing symlink targets outside root.
      if (old && sha(old) !== expectedSha) throw new Error('File changed since it was read (SHA-256 mismatch)');
      if (!old && expectedSha !== '') throw new Error('File no longer exists');
      if (s.kind === 'sftp') await s.client.put(bytes, target);
      else await s.client.uploadFrom(stream.Readable.from([bytes]), target);
      return { path: target, sha256: sha(bytes), bytes: bytes.length };
    });
  }
  async mkdir(id, pathname) {
    const { p, base, target } = this.context(id, pathname); editAllowed(p);
    await this.connect(p, this.store, async s => { await ensureRemoteBoundary(s, p.remoteRoot, base, target, true);
      if (s.kind === 'sftp') await s.client.mkdir(target, false); else await s.client.ensureDir(target); });
    return { created: target };
  }
  async rename(id, oldpath, newpath) {
    const { p, base, target: old } = this.context(id, oldpath); editAllowed(p);
    const target = this.context(id, newpath).target;
    await this.connect(p, this.store, async s => { await ensureRemoteBoundary(s, p.remoteRoot, base, old); await ensureRemoteBoundary(s, p.remoteRoot, base, target, true);
      const exists = s.kind === 'sftp' ? Boolean(await s.client.exists(target)) :
        (await s.client.list(path.posix.dirname(target))).some(entry => entry.name === path.posix.basename(target));
      if (exists) throw new Error('Rename destination already exists; refusing overwrite');
      await s.client.rename(old, target); });
    return { from: old, to: target };
  }
  async remove(id, pathname, isDirectory = false) {
    const { p, base, target } = this.context(id, pathname); editAllowed(p);
    if (target === p.remoteRoot || target === this.store.workspace(p.id)) throw new Error('Cannot remove remote root/workspace root');
    await this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      if (s.kind === 'sftp') { if (isDirectory) await s.client.rmdir(target, false); else await s.client.delete(target); }
      else if (isDirectory) await s.client.send('RMD ' + target); else await s.client.remove(target);
    });
    return { removed: target };
  }
  async search(id, pattern, directory = '.', depth = 3) {
    const { p, base, target } = this.context(id, directory);
    const match = String(pattern || '').toLowerCase();
    if (!match) throw new Error('Search term required');
    const result = [], limit = 200, maxDepth = Math.min(5, Math.max(0, Number(depth) || 0));
    await this.connect(p, this.store, async s => {
      // A failed partial traversal must not leak duplicate results into retries.
      result.length = 0;
      async function walk(dir, level) {
        if (result.length >= limit) return;
        await ensureRemoteBoundary(s, p.remoteRoot, base, dir);
        for (const x of await s.client.list(dir)) {
          if (x.name === '.' || x.name === '..') continue;
          const info = toInfo(x), child = path.posix.join(dir, x.name);
          if (info.name.toLowerCase().includes(match)) result.push({ ...info, path: child });
          if (info.type === 'directory' && level < maxDepth && result.length < limit) await walk(child, level + 1);
        }
      }
      await walk(target, 0);
    }, { retryRead: true });
    return { matches: result, truncated: result.length >= limit };
  }
  async transfer(id, remotePath, localFile, direction) {
    const { p, base, target } = this.context(id, remotePath);
    if (direction === 'upload') editAllowed(p);
    if (!['upload', 'download'].includes(direction)) throw new Error('Unknown transfer direction');
    const local = localPath(this.localRoot, localFile);
    if (direction === 'upload') {
      if (fs.statSync(local).size > MAX_BINARY) throw new Error('Transfer exceeds 8 MiB limit');
      // Reuse the staged, non-overwriting upload path for legacy AI uploads.
      const result = await this.uploadStaged(id, remotePath, local);
      return { direction, remote: result.uploaded, local };
    }
    // Never stream onto an existing local file. A failed FTP download must not
    // corrupt the last good copy. Final hard-link is exclusive (EEXIST-safe).
    if (fs.existsSync(local)) throw new Error('Local download destination already exists');
    const tmp = local + '.partial-' + crypto.randomBytes(8).toString('hex');
    try {
      await this.connect(p, this.store, async s => {
        await ensureRemoteBoundary(s, p.remoteRoot, base, target);
        if (s.kind === 'sftp') {
          const stat = await s.client.stat(target);
          if (stat.size > MAX_BINARY) throw new Error('Transfer exceeds 8 MiB limit');
          await s.client.fastGet(target, tmp);
        } else {
          let size = 0;
          const fd = fs.openSync(tmp, 'wx', 0o600);
          try {
            const limitedSink = new stream.Writable({ write(chunk, _, cb) {
              size += chunk.length;
              if (size > MAX_BINARY) return cb(new Error('Transfer exceeds 8 MiB limit'));
              try {
                let offset = 0;
                while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
                cb();
              } catch (error) { cb(error); }
            } });
            await s.client.downloadTo(limitedSink, target);
          } finally { fs.closeSync(fd); }
        }
      }, { retryRead: true });
      if (fs.statSync(tmp).size > MAX_BINARY) throw new Error('Transfer exceeds 8 MiB limit');
      fs.linkSync(tmp, local); // exclusive and same-directory filesystem
      return { direction, remote: target, local };
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  async uploadStaged(id, pathname, localFile, options = {}) {
    const {p,base,target}=this.context(id,pathname); editAllowed(p);
    if (!fs.statSync(localFile).isFile()) throw new Error('Upload staging file is invalid');
    return this.connect(p,this.store,async s=>{
      await ensureRemoteBoundary(s,p.remoteRoot,base,target,true);
      const exists = async file => s.kind==='sftp' ? Boolean(await s.client.exists(file)) :
        (await s.client.list(path.posix.dirname(file))).some(x=>x.name===path.posix.basename(file));
      if (await exists(target)) throw new Error('Remote file already exists; upload will not overwrite it');
      const staged=path.posix.join(path.posix.dirname(target),'.dsh-upload-'+crypto.randomBytes(12).toString('hex'));
      const ensureNotCanceled = () => { if (options.isCanceled?.()) throw new Error('Upload canceled before remote commit'); };
      try {
        ensureNotCanceled();
        if(s.kind==='sftp')await s.client.put(localFile,staged);
        else await s.client.uploadFrom(localFile,staged);
        ensureNotCanceled();
        if(await exists(target))throw new Error('Remote file appeared during transfer; refusing overwrite');
        ensureNotCanceled();
        await s.client.rename(staged,target);
      }catch(error){
        try {if(s.kind==='sftp')await s.client.delete(staged);else await s.client.remove(staged);}catch(_){}
        throw error;
      }
      return {uploaded:target,bytes:fs.statSync(localFile).size};
    });
  }
  async downloadStaged(id,pathname,destination,limit,options = {}) {
    const {p,base,target}=this.context(id,pathname);
    return this.connect(p,this.store,async s=>{
      await ensureRemoteBoundary(s,p.remoteRoot,base,target);
      if(s.kind==='sftp'){
        const st=await s.client.stat(target);
        if(st.isDirectory || st.size > limit)throw new Error('Download exceeds transfer limit or is a directory');
      }else if(typeof s.client.size==='function'){
        try{if(await s.client.size(target)>limit)throw new Error('Download exceeds transfer limit');}
        catch(error){if(/exceeds transfer limit/.test(error.message))throw error;}
      }
      const ensureNotCanceled = () => { if (options.isCanceled?.()) throw new Error('Download canceled'); };
      ensureNotCanceled();
      let size=0;
      const fd=fs.openSync(destination,'w',0o600);
      const sink=new stream.Writable({write(chunk,_enc,cb){
        if (options.isCanceled?.()) return cb(new Error('Download canceled'));
        size+=chunk.length;
        if(size>limit)return cb(new Error('Download exceeds transfer limit'));
        try {
          let offset=0;
          while(offset<chunk.length)offset+=fs.writeSync(fd,chunk,offset,chunk.length-offset);
          cb();
        } catch(error){cb(error);}
      }});
      try {
        if(s.kind==='sftp')await s.client.get(target,sink);
        else await s.client.downloadTo(sink,target);
        ensureNotCanceled();
        return size;
      } finally {fs.closeSync(fd);}
    },{retryRead:true});
  }
  async uploadBase64(id, pathname, encoded, overwrite = false) {
    const { p, base, target } = this.context(id, pathname); editAllowed(p);
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid base64 upload');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_UI)
      throw new Error('Browser upload limited to 512 KiB');
    await this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target, true);
      {
        let exists = false;
        if (s.kind === 'sftp') exists = Boolean(await s.client.exists(target));
        else exists = (await s.client.list(path.posix.dirname(target))).some(x => x.name === path.posix.basename(target));
        if (exists && !overwrite) throw new Error('Remote file already exists; refuse overwrite without confirmation');
        if (exists && s.kind === 'sftp') await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      }
      if (s.kind === 'sftp') await s.client.put(bytes, target);
      else await s.client.uploadFrom(stream.Readable.from([bytes]), target);
    });
    return { uploaded: target, bytes: bytes.length };
  }
  async downloadBase64(id, pathname) {
    const { p, base, target } = this.context(id, pathname);
    return this.connect(p, this.store, async s => {
      await ensureRemoteBoundary(s, p.remoteRoot, base, target);
      let bytes;
      if (s.kind === 'sftp') {
        const st = await s.client.stat(target);
        if (st.size > MAX_UI) throw new Error('Browser download limited to 512 KiB; use remote_download for larger files');
        bytes = await s.client.get(target);
      } else {
        const chunks = [];
        let total = 0;
        const out = new stream.Writable({ write(chunk, _, cb) {
          total += chunk.length;
          if (total > MAX_UI) return cb(new Error('Browser download limited to 512 KiB'));
          chunks.push(Buffer.from(chunk)); cb();
        }});
        await s.client.downloadTo(out, target);
        bytes = Buffer.concat(chunks);
      }
      if (bytes.length > MAX_UI) throw new Error('Browser download limited to 512 KiB');
      return { filename: path.posix.basename(target), contentBase64: bytes.toString('base64'), bytes: bytes.length };
    }, { retryRead: true });
  }
  async exec(id, command, options = {}) {
    const p = this.store.profile(id);
    if (!['sftp', 'ssh'].includes(p.protocol)) throw new Error('SSH commands require SFTP/SSH connection');
    const cmd = String(command || '');
    if (!cmd || cmd.length > 4096 || /[\r\n\0]/.test(cmd) || !p.execAllowlist.includes(cmd))
      throw new Error('Command must exactly match a safe execAllowlist entry');
    const { signal, timeoutMs = 60_000, clientFactory } = options;
    if (signal?.aborted) throw new Error('SSH command canceled');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid SSH timeout');
    const { Client } = clientFactory ? { Client: clientFactory } : require('ssh2');
    const c = new Client();
    return new Promise((resolve, reject) => {
      let settled = false, channel;
      const timer = setTimeout(() => done(new Error('SSH command timed out')), timeoutMs);
      const canceled = () => done(new Error('SSH command canceled'));
      const done = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', canceled);
        try { channel?.close?.(); } catch (_) {}
        try { c.end(); } catch (_) {}
        error ? reject(error) : resolve(result);
      };
      signal?.addEventListener?.('abort', canceled, { once: true });
      if (signal?.aborted) return canceled();
      c.on('ready', () => {
        if (settled) return;
        try {
          c.exec(cmd, (error, ch) => {
            if (settled) { try { ch?.close?.(); } catch (_) {} return; }
            if (error) return done(error);
            channel = ch;
            let stdout = '', stderr = '';
            const append = (field, chunk) => {
              const text = chunk.toString();
              if (field === 'out') stdout += text.slice(0, Math.max(0, 100_000 - stdout.length));
              else stderr += text.slice(0, Math.max(0, 100_000 - stderr.length));
              if (stdout.length >= 100_000 || stderr.length >= 100_000) done(new Error('SSH command output exceeds 100000 characters'));
            };
            ch.on('data', chunk => append('out', chunk));
            ch.stderr?.on('data', chunk => append('err', chunk));
            ch.on('error', done);
            ch.on('close', code => done(null, { code, stdout, stderr }));
          });
        } catch (error) { done(error); }
      });
      c.on('error', done);
      try { c.connect(authOptions(p, this.store)); } catch (error) { done(error); }
    });
  }
  async select(id, target) {
    const p = this.store.profile(id);
    const real = checkedPath(p.remoteRoot, target);
    await this.connect(p, this.store, async s => {
      await ensureSftpBoundary(s, p.remoteRoot, real);
      if (s.kind === 'sftp') {
        const stat = await s.client.stat(real);
        if (!stat.isDirectory) throw new Error('Selected path is not a directory');
      } else await s.client.list(real);
    }, { retryRead: true });
    return this.store.setWorkspace(p.id, real);
  }
  async test(id) { const p = this.store.profile(id); await this.list(p.id, '.', true); return { connected: true, profile: p.id, protocol: p.protocol }; }
}
module.exports = { RemoteManager, checkedPath, localPath, getPinned, authOptions, ensureRemoteBoundary, isTransientConnectionError, retryTransient, RETRY_DELAYS_MS, MAX_TEXT, MAX_BINARY, MAX_UI };
