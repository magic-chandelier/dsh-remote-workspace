'use strict';
// Cross-platform Harness session anchors. These directories are NOT mounts,
// caches, mirrored files, or user-selected projects. Remote IO uses SSH/SFTP.
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { checkedPath } = require('./remote.cjs');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const MARKER = '.dsh-remote-workspace-anchor';
function virtualRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-workspace', 'session-anchors');
}
function anchorPath(id, root = virtualRoot()) {
  if (!ID.test(String(id))) throw new Error('Invalid remote profile ID');
  return path.join(root, String(id));
}
function identityFor(store, id) {
  const p = store.profile(id);
  const identity = [p.protocol,p.host,p.port,p.username,p.remoteRoot,store.workspace(id)];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function expectedMarker(store, id) { return id + '\n' + identityFor(store, id) + '\n'; }
function virtualIdentityMatches(store, id, root = virtualRoot(), cwd = null) {
  try {
    if (cwd) return fs.readFileSync(path.join(path.resolve(root, reservedIdForCwd(cwd,root)), MARKER),'utf8') === expectedMarker(store,id);
    // For legacy calls, inspect all anchors, not just the v0.5.5 flat id path.
    return anchorEntries(root).some(name => readMarkerProfile(name,root) === id &&
      fs.readFileSync(path.join(root,name,MARKER),'utf8') === expectedMarker(store,id));
  } catch (_) { return false; }
}
function readMarkerProfile(name, root) {
  try {
    const dir=anchorPath(name,root); ensureNoSymlink(dir);
    const marker=path.join(dir,MARKER), stat=fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const text=fs.readFileSync(marker,'utf8');
    const match=/^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\n[a-f0-9]{64}\n$/.exec(text);
    return match ? match[1] : null;
  } catch (_) { return null; }
}
function anchorEntries(root) {
  if (!fs.existsSync(root)) return [];
  ensureNoSymlink(root);
  return fs.readdirSync(root).filter(name=>ID.test(name));
}
function ensureNoSymlink(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Remote session anchor must be a real local directory');
}
// Classify an historical remote cwd by its reserved plugin-owned pathname,
// even after its on-disk marker/directory has been removed. Fail closed.
function reservedIdForCwd(cwd, root = virtualRoot()) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const canonicalRoot = path.resolve(root), current = path.resolve(cwd);
  const relative = path.relative(canonicalRoot, current);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  const id = relative.split(path.sep)[0];
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(id) ? id : null;
}
function virtualIdForCwd(cwd, root = virtualRoot()) {
  root ||= virtualRoot();
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const canonicalRoot = path.resolve(root), current = path.resolve(cwd);
  const relative = path.relative(canonicalRoot, current);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  const id = relative.split(path.sep)[0];
  if (!ID.test(id)) return null;
  // Marker separates plugin-managed anchors from arbitrary local directories.
  // Profile deletion MUST NOT remove the guard for an existing Harness session.
  try {
    ensureNoSymlink(canonicalRoot);
    const home = anchorPath(id, canonicalRoot);
    ensureNoSymlink(home);
    const marker = path.join(home, MARKER);
    const s = fs.lstatSync(marker);
    return s.isFile() && !s.isSymbolicLink() ? readMarkerProfile(id,canonicalRoot) : null;
  } catch (_) { return null; }
}
class VirtualWorkspaceManager {
  constructor(store, { root = virtualRoot(), registry = null, remote = null } = {}) {
    this.store = store;
    this.root = root;
    this.registry = registry;
    this.remote = remote;
  }
  setRegistry(registry) { this.registry = registry; }
  // Removal is deliberately restricted to the plugin marker and empty anchor.
  // Never remove user files, arbitrary folders, mounts, or remote server data.
  _cleanAnchor(id, { requireUnregistered = true } = {}) {
    const dir = anchorPath(id, this.root);
    if (!fs.existsSync(dir)) return { profile:id, removed:false, retained:false };
    ensureNoSymlink(this.root);
    ensureNoSymlink(dir);
    if (requireUnregistered && (!this.registry?.list || this.registry.list().some(w => path.resolve(w.path) === path.resolve(dir))))
      throw new Error('Workspace still registered or registry unavailable; refusing cleanup');
    const marker = path.join(dir, MARKER);
    const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || !readMarkerProfile(id,this.root))
      throw new Error('Unowned or invalid remote anchor; refusing cleanup: '+dir);
    const extras = fs.readdirSync(dir).filter(x => x !== MARKER);
    if (extras.length) return { profile:id, removed:false, retained:true, reason:'Unexpected user files in anchor: '+extras.join(', ') };
    fs.unlinkSync(marker); fs.rmdirSync(dir);
    // The root is plugin-managed. Only remove it when empty.
    try { fs.rmdirSync(this.root); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
    return { profile:id, removed:true, retained:false };
  }
  async remove(id) {
    // Input remains a *profile* ID; one profile may own multiple historical
    // anchors. Remove only registry entries pointing to confirmed owned paths.
    this.store.profile(id);
    const entries=anchorEntries(this.root).filter(name => readMarkerProfile(name,this.root)===id);
    if (entries.length && (!this.registry?.list || !this.registry?.delete))
      throw new Error('Harness workspace registry unavailable; cannot safely unregister remote workspace');
    const cleaned=[];
    for (const name of entries) {
      const dir=anchorPath(name,this.root);
      for (const w of this.registry.list().filter(w=>path.resolve(w.path)===path.resolve(dir)))
        await this.registry.delete(w.id);
      cleaned.push(this._cleanAnchor(name));
    }
    return {profile:id, removed:cleaned.some(x=>x.removed), anchors:cleaned};
  }
  async removeAll() {
    if (!this.registry?.list || !this.registry?.delete) throw new Error('Harness workspace registry unavailable');
    const cleaned=[], errors=[];
    for (const name of anchorEntries(this.root)) {
      if (!readMarkerProfile(name,this.root)) {
        errors.push({name,reason:'Unowned or malformed anchor - manual review required'});
        continue;
      }
      try {
        const dir=anchorPath(name,this.root);
        for (const w of this.registry.list().filter(w=>path.resolve(w.path)===path.resolve(dir)))
          await this.registry.delete(w.id);
        const result=this._cleanAnchor(name);
        cleaned.push(result);
        if (result.retained) errors.push({name,reason:result.reason});
      } catch(e) { errors.push({name,reason:String(e.message||e)}); }
    }
    return {cleaned,errors};
  }
  // Lazy cleanup after deletion via the native Harness sidebar (which has no
  // plugin-specific delete hook). Called when the plugin UI next loads.
  prune() {
    if (!this.registry?.list || !fs.existsSync(this.root)) return { removed:[], retained:[] };
    ensureNoSymlink(this.root);
    const registered=new Set(this.registry.list().map(w=>path.resolve(w.path)));
    const removed=[], retained=[];
    for (const id of fs.readdirSync(this.root)) {
      if (!ID.test(id) || registered.has(path.resolve(anchorPath(id,this.root)))) continue;
      try {
        const result=this._cleanAnchor(id);
        if(result.removed) removed.push(id);
        if(result.retained) retained.push({id, reason:result.reason});
      } catch(error) { retained.push({id, reason:String(error.message||error)}); }
    }
    return { removed, retained };
  }
  rootPath() { return this.root; }
  status(id) {
    const profile = this.store.profile(id);
    const names=anchorEntries(this.root).filter(name=>readMarkerProfile(name,this.root)===id);
    const paths=names.map(name=>anchorPath(name,this.root));
    return { profile: profile.id, mode: ['ftp','ftps'].includes(profile.protocol) ? 'plugin-remote' : 'plugin-ssh', remotePath: this.store.workspace(id),
      localAnchor: paths[0] || null,
      registered: Boolean(this.registry?.list?.().some(w => paths.some(x=>path.resolve(w.path)===path.resolve(x)))),
      identityValid: virtualIdentityMatches(this.store, profile.id, this.root) };
  }
  async create(id, { title } = {}) {
    const profile = this.store.profile(id);
    if (!['ssh', 'sftp', 'ftp', 'ftps'].includes(profile.protocol)) throw new Error('Plugin remote session workspace requires SSH/SFTP/FTP/FTPS');
    if (!this.registry?.create) throw new Error('Harness workspaceRegistry unavailable');
    const remotePath = checkedPath(profile.remoteRoot, this.store.workspace(profile.id));
    if (!this.remote?.test) throw new Error('Remote connection tester unavailable');
    // A failed connection must never register an apparently usable workspace.
    await this.remote.test(profile.id);
    fs.mkdirSync(path.dirname(this.root), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.root)) ensureNoSymlink(this.root);
    else fs.mkdirSync(this.root, { mode: 0o700 });
    ensureNoSymlink(this.root);
    // Every newly-created registration uses an immutable unique cwd token:
    // reusing a connection ID must never revive an old deleted chat session.
    const registeredPaths = (this.registry.list?.() || []).map(w=>w.path);
    const registeredForId=anchorEntries(this.root).filter(name=>
      readMarkerProfile(name,this.root)===profile.id &&
      registeredPaths.some(x=>path.resolve(x)===path.resolve(anchorPath(name,this.root))));
    if (registeredForId.some(name=>fs.readFileSync(path.join(this.root,name,MARKER),'utf8')!==expectedMarker(this.store,profile.id)))
      throw new Error('Invalid remote workspace anchor marker; remove old registration before creating a new one');
    const existing = anchorEntries(this.root).filter(name=>
      readMarkerProfile(name,this.root)===profile.id &&
      registeredPaths.some(x=>path.resolve(x)===path.resolve(anchorPath(name,this.root))) &&
      fs.readFileSync(path.join(this.root,name,MARKER),'utf8')===expectedMarker(this.store,profile.id));
    const dir = existing.length ? anchorPath(existing[0],this.root) :
      anchorPath(profile.id+'--'+randomBytes(8).toString('hex'), this.root);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    ensureNoSymlink(dir);
    const marker = path.join(dir, MARKER);
    if (fs.existsSync(marker)) {
      const info = fs.lstatSync(marker);
      if (!info.isFile() || info.isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== expectedMarker(this.store, profile.id))
        throw new Error('Invalid remote workspace anchor marker');
    } else fs.writeFileSync(marker, expectedMarker(this.store, profile.id), { flag:'wx', mode:0o600 });
    // Native WorkspaceRegistry only owns a session cwd. ALL remote file and
    // command operations continue through the plugin; no OS mount is involved.
    const record = await this.registry.create(dir, title || `${profile.protocol.toUpperCase()} · ${profile.id} · ${profile.username}@${profile.host}:${remotePath}`);
    return { mode:['ftp','ftps'].includes(profile.protocol)?'plugin-remote':'plugin-ssh', profile: profile.id, remotePath,
      workspaceId: record.id, title: record.title, localAnchor: dir,
      note: 'Only a Harness session anchor. Remote files are not present locally; use remote_* tools.' };
  }
}
module.exports = { VirtualWorkspaceManager, virtualRoot, anchorPath, reservedIdForCwd, virtualIdForCwd, virtualIdentityMatches, identityFor, MARKER };
