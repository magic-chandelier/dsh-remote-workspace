'use strict';
const path = require('node:path');
const { legacyDataDir } = require('./data-dir.cjs');
const { mountRoot, windowsUncForProfile } = require('./native-workspace.cjs');
const { checkedPath } = require('./remote.cjs');
const { virtualIdForCwd } = require('./virtual-workspace.cjs');
function isSshfsWinUnc(cwd) {
  return typeof cwd === 'string' && /^\\\\sshfs(?:\.[a-z])?\\/i.test(cwd);
}
function workspaceProfileForCwd(store, cwd, root = mountRoot()) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const norm = path.resolve(cwd);
  for (const p of store.list()) {
    if (!['ssh','sftp'].includes(p.protocol)) continue;
    const home = path.join(root,p.id);
    if (norm === home || norm.startsWith(home + path.sep)) return p.id;
    if (process.platform === 'win32') {
      try {
        const unc = path.win32.normalize(windowsUncForProfile(p, checkedPath(p.remoteRoot, store.workspace(p.id)))).toLowerCase();
        const current = path.win32.normalize(cwd).toLowerCase();
        if (current === unc || current.startsWith(unc + '\\')) return p.id;
      } catch (_) { /* invalid profile */ }
    }
  }
  return null;
}
async function resolveAgentProfile(service, id, exec, options = {}) {
  const {authorizedAgentScope} = require('./agent-scope.cjs');
  // A model-provided profile can narrow access, never select a server.
  return (await authorizedAgentScope(service, exec, {...options, expectedProfile:id})).profile;
}
function shellGuardedWorkspace(exec, store, root = mountRoot()) {
  const arg = exec?.arguments;
  const workdir = arg && typeof arg === 'object' && (arg.workdir || arg.cwd);
  return workspaceProfileForCwd(store, workdir, root);
}
module.exports = { workspaceProfileForCwd, isSshfsWinUnc, resolveAgentProfile, shellGuardedWorkspace, virtualIdForCwd };
