'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Stable across Host restarts; unlike ConnectionGate.fingerprint this excludes
// transient per-process revision counters used to invalidate session grants.
function bindingIdentity(store,id) {
  const p=store.profile(id);
  return crypto.createHash('sha256').update(JSON.stringify([
    p.id,p.protocol,p.host,p.port,p.username,p.remoteRoot,
    p.hostTrustMode,p.hostKeySha256,p.hostKeySha256Env,
    p.privateKeyPath,p.privateKeyEnv,p.passwordEnv,p.passphraseEnv,
  ])).digest('hex');
}
// A project-local binding file is model-editable. Only the plugin's private
// ledger records a binding established through the management UI.
class BindingTrust {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'trusted-project-bindings.json');
    this.records = this.load();
  }
  load() {
    try {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe binding trust file');
      const contents = fs.readFileSync(this.file, 'utf8');
      if (contents.length > 1024 * 1024) throw new Error('Binding trust file too large');
      const parsed = JSON.parse(contents);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid binding trust format');
      const result = new Map();
      for (const record of parsed.records) {
        if (!record || typeof record.root !== 'string' || !path.isAbsolute(record.root) ||
            typeof record.connectionId !== 'string' || typeof record.remotePath !== 'string' ||
            typeof record.fingerprint !== 'string') throw new Error('Invalid binding trust record');
        result.set(record.root, record);
      }
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      // Corrupt trust must fail closed, never be silently overwritten.
      this.loadError = error;
      return new Map();
    }
  }
  persist(next) {
    if (this.loadError) throw new Error('Trusted binding ledger is damaged; refusing to overwrite');
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe binding trust directory');
    const temp = path.join(directory, `.binding-trust-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify({version:1,records:[...next.values()]},null,2)+'\n',{mode:0o600,flag:'wx'});
      fs.renameSync(temp,this.file);
    } finally {try {fs.unlinkSync(temp);} catch (error) {if (error.code!=='ENOENT') throw error;}}
    this.records = next;
  }
  confirm(root, binding, fingerprint) {
    const next = new Map(this.records);
    next.set(root, {root,connectionId:binding.connectionId,remotePath:binding.remotePath,fingerprint});
    this.persist(next);
  }
  revoke(root) {
    const next = new Map(this.records);
    next.delete(root);
    this.persist(next);
  }
  verify(root, binding, fingerprint) {
    if (this.loadError) throw new Error('Trusted binding ledger unavailable; rebind through the plugin UI after recovery');
    const recorded = this.records.get(root);
    if (!recorded || recorded.connectionId!==binding.connectionId ||
        recorded.remotePath!==binding.remotePath || recorded.fingerprint!==fingerprint)
      throw new Error('Remote project binding is not trusted or has changed; confirm binding in the plugin management UI');
    return true;
  }
}
module.exports = {BindingTrust,bindingIdentity};
