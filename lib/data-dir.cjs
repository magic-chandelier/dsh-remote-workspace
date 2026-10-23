'use strict';
// Keep writable user data OUTSIDE the disposable pnpm package directory.
// The profile's .plugin-data folder lives next to node_modules, is stable
// across package updates, and can be relocated to another drive explicitly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA_NAME = 'dsh-remote-workspace';
function legacyDataDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-workspace');
}
function checkPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()))
    throw new Error(label + ' must be an absolute filesystem path');
  return path.resolve(value.trim());
}
function newProfileDataDir(profileDir) {
  return path.join(checkPath(profileDir, 'Harness profile directory'), '.plugin-data', DATA_NAME);
}
function existingLegacy() {
  const old = legacyDataDir();
  return ['connections.json','credentials.json','session-anchors'].some(x=>fs.existsSync(path.join(old,x)));
}
function resolveDataDir({dataDir = '',profileDir = '',preserveLegacy = true} = {}) {
  // Explicit location always wins. Nonexistent directories are created lazily.
  const explicit = dataDir || process.env.DSH_REMOTE_WORKSPACE_DATA_DIR || '';
  if (explicit) return { root: checkPath(explicit, 'Remote workspace dataDir'), reason: 'configured' };
  // Existing users retain their current data without moving session anchors:
  // those paths may be referenced by preserved Harness chat sessions.
  if (preserveLegacy && existingLegacy()) return { root: legacyDataDir(), reason:'legacy-preserved' };
  if (profileDir) return { root:newProfileDataDir(profileDir), reason:'profile-local' };
  return { root:legacyDataDir(), reason:'profile-unavailable' };
}
module.exports = { legacyDataDir, newProfileDataDir, resolveDataDir };
