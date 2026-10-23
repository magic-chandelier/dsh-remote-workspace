'use strict';
// Password vault for the Host (NEVER bundled into the client).
// AES-256-GCM data keys are sealed with Windows DPAPI CurrentUser. On other
// platforms AES requires an explicit 256-bit master key supplied via env.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VALID = new Set(['none', 'obfuscate', 'aes']);
function identity(p) {
  return crypto.createHash('sha256').update(JSON.stringify([p.protocol, p.host, p.port, p.username])).digest('hex');
}
function vaultPath(configFile) { return path.join(path.dirname(configFile), 'credentials.json'); }
function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = filename + '.tmp-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temp, 0o600); } catch (_) {}
    fs.renameSync(temp, filename);
    try { fs.chmodSync(filename, 0o600); } catch (_) {}
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
// PowerShell receives only base64 through STDIN, not command-line arguments.
// Script source is constant, and credentials are never printed.
const DPAPI_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  'if ($env:DSH_VAULT_DPAPI_ACTION -eq "protect") {',
  ' $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
  '} else {',
  ' $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
  '}',
  '[Console]::Out.Write([Convert]::ToBase64String($result))'
].join('\n');
function windowsDpapi(action, bytes) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')
  ], { input: Buffer.from(bytes).toString('base64'), encoding: 'utf8',
    maxBuffer: 16 * 1024, timeout: 10000, windowsHide: true,
    env: { ...process.env, DSH_VAULT_DPAPI_ACTION: action } });
  const text = String(out).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('Windows DPAPI returned invalid data');
  return Buffer.from(text, 'base64');
}
function envKey() {
  const value = process.env.DSH_REMOTE_VAULT_KEY;
  if (!value) throw new Error('AES password saving requires Windows DPAPI or DSH_REMOTE_VAULT_KEY (32 random bytes, base64) on this OS');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid DSH_REMOTE_VAULT_KEY encoding');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('DSH_REMOTE_VAULT_KEY must contain exactly 32 random bytes');
  return key;
}
function keyForWrite(dpapi, platform = process.platform) {
  if (platform === 'win32') {
    const key = crypto.randomBytes(32);
    return { key, keySource: 'dpapi', wrappedKey: dpapi('protect', key).toString('base64') };
  }
  return { key: envKey(), keySource: 'env' };
}
function keyForRead(record, dpapi, platform = process.platform) {
  if (record.keySource === 'dpapi') {
    if (platform !== 'win32') throw new Error('This AES credential is sealed to a Windows user account');
    const key = dpapi('unprotect', Buffer.from(record.wrappedKey, 'base64'));
    if (key.length !== 32) throw new Error('Invalid Windows DPAPI key');
    return key;
  }
  if (record.keySource === 'env') return envKey();
  throw new Error('Unknown AES key source');
}
function obfuscate(password) {
  // Deliberately reversible and NOT encryption; label accordingly in UI.
  return Buffer.from(password, 'utf8').toString('base64');
}
class CredentialVault {
  constructor(filename, { dpapi = windowsDpapi, platform = process.platform } = {}) {
    this.file = filename;
    this.dpapi = dpapi;
    this.platform = platform;
    this.entries = {};
    this.loadError = null;
    if (fs.existsSync(filename)) {
      try {
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (data?.version !== 1 || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles))
          throw new Error('Unsupported credential vault format');
        this.entries = data.profiles;
      } catch (error) {
        this.loadError = 'Credential vault cannot be read; credentials.json is preserved: ' + error.message;
      }
    }
  }
  status(id, p) {
    const record = this.entries[id];
    return record && record.identity === identity(p) && VALID.has(record.mode) ? record.mode : 'none';
  }
  get(id, p) {
    const r = this.entries[id];
    if (!r || r.identity !== identity(p)) return '';
    try {
      if (r.mode === 'obfuscate') return Buffer.from(r.data, 'base64').toString('utf8');
      if (r.mode === 'aes') {
        const key = keyForRead(r, this.dpapi, this.platform);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'));
        decipher.setAAD(Buffer.from(r.identity, 'utf8'));
        decipher.setAuthTag(Buffer.from(r.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(r.data, 'base64')), decipher.final()]).toString('utf8');
      }
    } catch (_) { throw new Error('Saved SSH password cannot be decrypted. Re-enter the password in connection settings.'); }
    return '';
  }
  remember(id, p, password, mode) {
    if (this.loadError) throw new Error(this.loadError);
    if (!VALID.has(mode)) throw new Error('Invalid password remembering mode');
    if (mode === 'none') { this.forget(id); return; }
    if (typeof password !== 'string' || !password) throw new Error('Enter a password before enabling remember-password');
    const idHash = identity(p);
    let record;
    if (mode === 'obfuscate') record = { mode, identity: idHash, data: obfuscate(password) };
    else {
      const { key, keySource, wrappedKey } = keyForWrite(this.dpapi, this.platform);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(idHash, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
      record = { mode, identity: idHash, keySource, ...(wrappedKey ? { wrappedKey } : {}),
        iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
    }
    this.entries[id] = record;
    this.persist();
  }
  forget(id) {
    if (this.loadError) throw new Error(this.loadError);
    if (Object.hasOwn(this.entries, id)) { delete this.entries[id]; this.persist(); }
  }
  persist() {
    if (this.loadError) throw new Error(this.loadError);
    atomicWrite(this.file, { version: 1, profiles: this.entries });
  }
}
module.exports = { CredentialVault, identity, vaultPath, windowsDpapi, VALID };
