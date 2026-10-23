'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHUNK_BYTES = 192 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_SESSIONS = 4;
const EXPIRY_MS = 30 * 60 * 1000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

class TransferSessions {
  constructor(remote, root, options = {}) {
    this.remote = remote;
    this.root = path.join(root, 'transfer-cache');
    this.sessions = new Map();
    this.now = options.now || Date.now;
    this.closed = false;
    this.cleanupStale();
  }
  ensureOpen() { if (this.closed) throw new Error('Transfers are no longer available'); }
  ensureRoot() {
    fs.mkdirSync(this.root, { recursive:true, mode:0o700 });
    if (!fs.lstatSync(this.root).isDirectory()) throw new Error('Transfer directory must be a real directory');
  }
  cleanupStale() {
    if (!fs.existsSync(this.root)) return;
    if (!fs.lstatSync(this.root).isDirectory()) return;
    const now = this.now();
    for (const item of fs.readdirSync(this.root)) {
      if (!/^rw-[0-9a-f]{32}\.part$/.test(item)) continue;
      const target = path.join(this.root,item);
      const st = fs.lstatSync(target);
      if (st.isFile() && now - st.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(target);
    }
  }
  sweep() {
    for (const [token,s] of this.sessions) if (this.now() - s.touched > EXPIRY_MS) this.abort(token);
  }
  identity(id) {
    const {p,base} = this.remote.context(id,'.');
    return crypto.createHash('sha256').update(JSON.stringify([p.id,p.protocol,p.host,p.port,p.username,p.remoteRoot,base,p.readOnly])).digest('hex');
  }
  get(token, id, direction) {
    this.ensureOpen(); this.sweep();
    const s = this.sessions.get(token);
    if (!s || s.id !== id || s.direction !== direction) throw new Error('Transfer session not found or belongs to another connection');
    if (s.cancelled) throw new Error('Transfer was canceled');
    if (s.identity !== this.identity(id)) { this.abort(token); throw new Error('Remote connection changed during transfer'); }
    s.touched = this.now();
    return s;
  }
  reserve(id, pathname, direction, bytes = 0) {
    this.ensureOpen(); this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Too many concurrent transfers');
    if (!id || typeof pathname !== 'string' || !pathname) throw new Error('Transfer connection and path required');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES) throw new Error('Transfer exceeds 128 MiB limit');
    const identity=this.identity(id);
    this.ensureRoot();
    const token = crypto.randomBytes(16).toString('hex');
    const file = path.join(this.root, `rw-${token}.part`);
    fs.writeFileSync(file, '', {flag:'wx',mode:0o600});
    const s = {token,id,pathname,direction,file,identity,total:bytes,received:0,index:0,touched:this.now(),busy:false,cancelled:false};
    this.sessions.set(token,s);
    return s;
  }
  beginUpload(id, pathname, bytes) {
    const {p} = this.remote.context(id,pathname);
    if (p.readOnly !== false) throw new Error('Connection is read-only');
    const s = this.reserve(id,pathname,'upload',bytes);
    return {token:s.token,chunkBytes:CHUNK_BYTES,maxBytes:MAX_BYTES};
  }
  appendUpload(id, token, index, encoded) {
    const s = this.get(token,id,'upload');
    if (s.busy) throw new Error('Transfer is finishing');
    if (index !== s.index || typeof encoded !== 'string' || encoded.length > Math.ceil(CHUNK_BYTES/3)*4 || !BASE64.test(encoded)) throw new Error('Invalid or out-of-order upload chunk');
    const bytes = Buffer.from(encoded,'base64');
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES || s.received + bytes.length > s.total) throw new Error('Upload chunk size mismatch');
    fs.appendFileSync(s.file, bytes);
    s.index++;s.received+=bytes.length;
    return {received:s.received,total:s.total};
  }
  async finishUpload(id, token) {
    const s = this.get(token,id,'upload');
    if (s.busy) throw new Error('Transfer already finishing');
    if (s.received !== s.total) throw new Error('Upload incomplete');
    s.busy = true;
    try {
      const result = await this.remote.uploadStaged(id, s.pathname, s.file, {isCanceled: () => s.cancelled || this.closed});
      // After a successful commit, cancellation cannot undo a remote rename.
      // Report success honestly, rather than claiming the file was canceled.
      return s.cancelled || this.closed ? {...result, committed:true, cancelRequested:true} : result;
    } finally { s.busy = false; this.abort(token); }
  }
  async beginDownload(id, pathname) {
    const s = this.reserve(id,pathname,'download');
    s.busy = true;
    try {
      s.total = await this.remote.downloadStaged(id,pathname,s.file,MAX_BYTES);
      s.busy = false;
      this.get(s.token,id,'download');
      return {token:s.token,filename:path.posix.basename(s.pathname),bytes:s.total,chunkBytes:CHUNK_BYTES,maxBytes:MAX_BYTES};
    } catch(error) {s.busy = false; this.abort(s.token);throw error;}
  }
  startDownload(id, pathname) {
    const s = this.reserve(id, pathname, 'download');
    s.busy = true;
    s.error = null;
    s.downloadPromise = Promise.resolve().then(() =>
      this.remote.downloadStaged(id, pathname, s.file, MAX_BYTES,
        {isCanceled: () => s.cancelled || this.closed})
    ).then(bytes => {
      s.total = bytes;
      s.busy = false;
      if (s.cancelled) this.abort(s.token);
    }).catch(error => {
      s.error = String(error?.message || error);
      s.busy = false;
      if (s.cancelled) this.abort(s.token);
    });
    return {token:s.token, filename:path.posix.basename(pathname), chunkBytes:CHUNK_BYTES, maxBytes:MAX_BYTES};
  }
  downloadStatus(id, token) {
    const s = this.get(token, id, 'download');
    if (s.error) { const error=s.error; this.abort(token); throw new Error(error); }
    return {ready:!s.busy, bytes:s.busy ? null : s.total};
  }
  downloadChunk(id, token, index) {
    const s = this.get(token,id,'download');
    if (s.busy) throw new Error('Download is not ready');
    if (!Number.isSafeInteger(index) || index !== s.index) throw new Error('Download chunk out of order');
    const offset = index * CHUNK_BYTES;
    if (offset >= s.total) throw new Error('No more download data');
    const count = Math.min(CHUNK_BYTES,s.total-offset);
    const buf=Buffer.allocUnsafe(count);
    const fd=fs.openSync(s.file,'r');
    let read;
    try {read=fs.readSync(fd,buf,0,count,offset);} finally{fs.closeSync(fd);}
    if (read !== count) throw new Error('Incomplete local transfer staging file');
    s.index++;
    return {index,contentBase64:buf.toString('base64'),received:offset+read,total:s.total};
  }
  abort(token) {
    const s=this.sessions.get(token);
    if(!s) return {aborted:false};
    s.cancelled = true;
    if (s.busy) return {aborted:true,pending:true};
    this.sessions.delete(token);
    try{fs.unlinkSync(s.file);}catch(error){if(error.code!=='ENOENT')throw error;}
    return {aborted:true};
  }
  cancel(id,token) {
    const s = this.get(token,id,this.sessions.get(token)?.direction);
    return this.abort(s.token);
  }
  dispose() {
    if(this.closed)return;
    this.closed=true;
    for(const token of [...this.sessions.keys()]){ try{this.abort(token);}catch(_){} }
  }
}
module.exports = {TransferSessions,CHUNK_BYTES,MAX_BYTES};
