'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CredentialVault, vaultPath, VALID: REMEMBER_MODES, identity } = require('./credential-vault.cjs');
const VALID = new Set(['ssh', 'sftp', 'ftps', 'ftp']);
const TRUST_MODES = new Set(['tofu', 'pinned', 'insecure']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
function dataPath() { return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-workspace', 'connections.json'); }
function positivePort(value, protocol) {
  const n = value === undefined || value === null || value === '' ? (['ssh', 'sftp'].includes(protocol) ? 22 : protocol === 'ftps' ? 21 : 21) : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid TCP port');
  return n;
}
function normalizeProfile(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid profile');
  const id = String(input.id || '').trim();
  if (!SAFE_ID.test(id)) throw new Error('Connection ID must match [A-Za-z0-9_.-]');
  const protocol = String(input.protocol || 'sftp').toLowerCase();
  if (!VALID.has(protocol)) throw new Error('Protocol must be ssh, sftp, ftp or ftps');
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  if (!host || host.length > 253 || /[\s/?#@]/.test(host)) throw new Error('Invalid host');
  if (!username || username.length > 255) throw new Error('Username is required');
  const remoteRoot = require('node:path').posix.resolve('/', String(input.remoteRoot || '/'));
  if (input.rememberMode !== undefined && !REMEMBER_MODES.has(input.rememberMode)) throw new Error('Invalid remember-password mode');
  const hostTrustMode = String(input.hostTrustMode || ((input.hostKeySha256 || input.hostKeySha256Env) ? 'pinned' : 'tofu')).toLowerCase();
  if (!TRUST_MODES.has(hostTrustMode)) throw new Error('Invalid SSH host trust mode');
  if (hostTrustMode === 'pinned' && !input.hostKeySha256 && !input.hostKeySha256Env) throw new Error('Pinned mode requires host fingerprint or fingerprint env');
  const val = {
    id, protocol, host, port: positivePort(input.port, protocol), username, remoteRoot,
    hostTrustMode, terminalEnabled: input.terminalEnabled === true && protocol === 'ssh',
    readOnly: input.readOnly !== false,
    privateKeyPath: String(input.privateKeyPath || ''),
    privateKeyEnv: String(input.privateKeyEnv || ''),
    passwordEnv: String(input.passwordEnv || ''),
    rememberMode: REMEMBER_MODES.has(input.rememberMode) ? input.rememberMode : 'none',
    passphraseEnv: String(input.passphraseEnv || ''),
    hostKeySha256: String(input.hostKeySha256 || '').trim(),
    hostKeySha256Env: String(input.hostKeySha256Env || ''),
    allowInsecureFtp: input.allowInsecureFtp === true,
    execAllowlist: Array.isArray(input.execAllowlist) ? input.execAllowlist.map(x => String(x)).filter(Boolean).slice(0, 32) : []
  };
  return val;
}
class Store {
  constructor(filename = dataPath(), initial = []) {
    this.file = filename;
    this.vault = new CredentialVault(vaultPath(filename));
    this.sessionPasswords = new Map();
    this.revisions = new Map();
    this.profiles = new Map();
    this.workspaces = new Map();
    this.trustedHostKeys = new Map();
    this.active = '';
    this.loadError = null;
    let legacy = null;
    if (fs.existsSync(filename)) {
      try { legacy = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch (error) {
        // A damaged user file must not bring down Harness or be overwritten.
        this.loadError = 'Cannot read connections.json: ' + error.message;
      }
    }
    // Read previous 0.2.0 layouts (array, {profiles}, {connections}).
    const entries = Array.isArray(legacy) ? legacy : (legacy?.profiles || legacy?.connections || []);
    const list = [...initial, ...(Array.isArray(entries) ? entries : Object.values(entries || {}))];
    for (const p of list) {
      try { const x = normalizeProfile(p); this.profiles.set(x.id, x); } catch (_) { /* ignore malformed legacy items */ }
    }
    for (const [id, record] of Object.entries(legacy?.trustedHostKeys || {})) {
      const p = this.profiles.get(id);
      if (p && record && record.host === p.host && record.port === p.port && /^[a-f0-9]{64}$/i.test(String(record.hex || '')))
        this.trustedHostKeys.set(id, { host: p.host, port: p.port, hex: record.hex.toLowerCase() });
    }
    const oldWorkspaces = legacy?.workspaces || {};
    for (const [id, value] of Object.entries(oldWorkspaces)) if (this.profiles.has(id) && typeof value === 'string') this.workspaces.set(id, value);
    for (const p of list) if (p && this.profiles.has(p.id) && typeof p.workspaceRoot === 'string') this.workspaces.set(p.id, p.workspaceRoot);
    this.active = String(legacy?.active || legacy?.activeProfile || legacy?.selectedProfile || '');
    if (!this.profiles.has(this.active)) this.active = '';
  }
  list() {
    return [...this.profiles.values()].map(p => ({ ...p, rememberMode: this.vault.status(p.id, p),
      hasSessionPassword: this.sessionPasswords.has(p.id), trustedHostKeySha256: this.trustedHostKeys.get(p.id)?.hex || '', workspace: this.workspaces.get(p.id) || p.remoteRoot, active: this.active === p.id }));
  }
  profile(id) {
    const key = id || this.active;
    const p = this.profiles.get(key);
    if (!p) throw new Error(key ? `Unknown profile ID: ${key}. Call remote_profiles first.` : 'No active remote workspace; select a connection first.');
    return p;
  }
  workspace(id) {
    const p = this.profile(id);
    const selected = this.workspaces.get(p.id);
    if (!selected) return p.remoteRoot;
    const posix = path.posix;
    const normalized = posix.resolve('/', selected);
    return normalized === p.remoteRoot || normalized.startsWith(p.remoteRoot.replace(/\/$/, '') + '/') ? normalized : p.remoteRoot;
  }
  setWorkspace(id, folder) {
    const p = this.profile(id);
    const target = path.posix.resolve('/', String(folder));
    if (target !== p.remoteRoot && !target.startsWith(p.remoteRoot.replace(/\/$/, '') + '/')) throw new Error('Folder outside configured remoteRoot');
    this.workspaces.set(id, target);
    this.active = id;
    this.save();
    return { profile: id, workspace: target };
  }
  rememberHostKey(id, hex) {
    const p = this.profile(id);
    if (!/^[a-f0-9]{64}$/i.test(String(hex))) throw new Error('Invalid SSH host fingerprint');
    const old = this.trustedHostKeys.get(id);
    if (old) return old.host === p.host && old.port === p.port && old.hex === hex.toLowerCase();
    this.trustedHostKeys.set(id, { host: p.host, port: p.port, hex: hex.toLowerCase() });
    try { this.save(); return true; }
    catch (error) { this.trustedHostKeys.delete(id); throw error; }
  }
  forgetHostKey(id) {
    this.profile(id);
    const previous = this.trustedHostKeys.get(id);
    this.trustedHostKeys.delete(id);
    try { this.save(); } catch (error) { if (previous) this.trustedHostKeys.set(id, previous); throw error; }
    if (previous) this.revisions.set(id,this.revision(id)+1);
    return {id, forgotten: Boolean(previous)};
  }
  revision(id) { return this.revisions.get(id) || 0; }
  passwordFor(id) {
    const p = this.profile(id);
    return this.sessionPasswords.get(p.id) || this.vault.get(p.id, p) || (p.passwordEnv ? process.env[p.passwordEnv] : '') || '';
  }
  upsert(raw) {
    const val = normalizeProfile(raw);
    const previous = this.profiles.get(val.id);
    const requestedMode = raw.rememberMode === undefined ? this.vault.status(val.id, previous || val) : val.rememberMode;
    if (!REMEMBER_MODES.has(requestedMode)) throw new Error('Invalid remember-password mode');
    const providedPassword = typeof raw.password === 'string' && raw.password.length > 0 ? raw.password : '';
    const sameIdentity = previous && identity(previous) === identity(val);
    if (requestedMode !== 'none') {
      const savedMode = sameIdentity ? this.vault.status(val.id, val) : 'none';
      if (providedPassword || requestedMode !== savedMode) {
        const password = providedPassword || (sameIdentity ? this.passwordFor(val.id) : '');
        this.vault.remember(val.id, val, password, requestedMode);
      }
    } else this.vault.forget(val.id);
    if (raw.clearPassword) this.sessionPasswords.delete(val.id);
    if (providedPassword) this.sessionPasswords.set(val.id, providedPassword);
    else if (!sameIdentity) this.sessionPasswords.delete(val.id);
    val.rememberMode = requestedMode;
    const before = this.profiles.get(val.id);
    if (before && (before.host !== val.host || before.port !== val.port || before.username !== val.username)) this.trustedHostKeys.delete(val.id);
    this.profiles.set(val.id, val);
    // Validate the *stored* path after changing remoteRoot, not workspace(),
    // which silently falls back to the new root and hides an invalid selection.
    const previousWorkspace = this.workspaces.get(val.id);
    if (previousWorkspace) {
      const root = path.posix.resolve('/', val.remoteRoot);
      const old = path.posix.resolve('/', previousWorkspace);
      if (old !== root && !old.startsWith(root.replace(/\/$/, '') + '/')) {
        this.workspaces.delete(val.id);
      }
    }
    this.save();
    this.revisions.set(val.id,this.revision(val.id)+1);
    return { id: val.id };
  }
  remove(id) {
    if (!this.profiles.has(id)) throw new Error('Unknown profile ID');
    this.vault.forget(id);
    this.profiles.delete(id); this.workspaces.delete(id); this.sessionPasswords.delete(id); this.trustedHostKeys.delete(id);
    if (this.active === id) this.active = '';
    this.save();
    this.revisions.set(id,this.revision(id)+1);
  }
  save() {
    if (this.loadError) throw new Error(this.loadError + '. Restore or rename the damaged file before saving.');
    const body = {
      version: 2, active: this.active,
      profiles: [...this.profiles.values()],
      trustedHostKeys: Object.fromEntries(this.trustedHostKeys),
      workspaces: Object.fromEntries(this.workspaces)
    };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp-' + process.pid + '-' + require('node:crypto').randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(tmp, 0o600); } catch (_) {}
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch (_) {}
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}
module.exports = { Store, normalizeProfile, dataPath };
