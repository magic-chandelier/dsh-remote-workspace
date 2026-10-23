'use strict';
const path = require('node:path');
const {legacyDataDir} = require('./data-dir.cjs');
const {virtualIdForCwd,virtualIdentityMatches,reservedIdForCwd} = require('./virtual-workspace.cjs');
const {getBinding,validateBinding} = require('./binding.cjs');
const {bindingIdentity} = require('./binding-trust.cjs');
const {workspaceProfileForCwd,isSshfsWinUnc} = require('./remote-context.cjs');

async function agentScope(service, exec) {
  if (service.stopped) throw new Error('Remote workspace plugin has stopped');
  if (!exec?.agent || !service.workingDirectory?.ensure)
    throw new Error('Trusted Harness Agent and workingDirectory are required; remote tool access denied');
  if (exec.signal?.aborted) throw new Error('Remote agent request aborted');
  const cwd = await service.workingDirectory.ensure(exec.agent, exec.signal);
  if (isSshfsWinUnc(cwd) && !workspaceProfileForCwd(service.store,cwd,service.native.rootPath()))
    throw new Error('Unknown or removed SSHFS-Win session: local fallback forbidden');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Harness Agent workspace identity is unavailable');
  if (exec.signal?.aborted || service.stopped) throw new Error('Remote agent request aborted');
  const dataDir = legacyDataDir();
  const legacyVirtual = path.join(dataDir,'session-anchors');
  const virtualRoot = service.virtual.rootPath();
  const nativeRoot = service.native.rootPath();
  const legacyNative = path.join(dataDir,'mounts');
  const reservedVirtual = reservedIdForCwd(cwd,virtualRoot) ||
    (path.resolve(legacyVirtual)!==path.resolve(virtualRoot) && reservedIdForCwd(cwd,legacyVirtual));
  const reservedNative = reservedIdForCwd(cwd,nativeRoot) ||
    (path.resolve(legacyNative)!==path.resolve(nativeRoot) && reservedIdForCwd(cwd,legacyNative));
  const virtualId = virtualIdForCwd(cwd,virtualRoot);
  if (reservedVirtual) {
    if (!virtualId || !virtualIdentityMatches(service.store,virtualId,virtualRoot,cwd))
      throw new Error('Historical remote workspace identity changed or removed; create a new trusted remote session');
    service.store.profile(virtualId);
    return {kind:'remote-workspace',profile:virtualId,cwd};
  }
  const nativeId = workspaceProfileForCwd(service.store,cwd,nativeRoot) ||
    workspaceProfileForCwd(service.store,cwd,legacyNative);
  if (reservedNative || isSshfsWinUnc(cwd)) {
    if (!nativeId) throw new Error('Unknown or removed SSHFS workspace; access denied');
    service.store.profile(nativeId);
    return {kind:'remote-workspace',profile:nativeId,cwd};
  }
  const possible = await getBinding(cwd,{optional:true});
  if (!possible) throw new Error('Current AI session is not bound to a remote server; bind the workspace in the plugin UI first');
  const {root,binding} = possible;
  const profile = service.store.profile(binding.connectionId);
  validateBinding(binding,profile);
  if (!service.bindingTrust) throw new Error('Trusted binding ledger unavailable');
  service.bindingTrust.verify(root,binding,bindingIdentity(service.store,binding.connectionId));
  return {kind:'local-project',profile:binding.connectionId,cwd,root,remotePath:binding.remotePath,binding};
}
// Single authorization path for generic remote tools and pinned project tools.
// Both the connection approval and trusted binding can change while waiting.
async function authorizedAgentScope(service, exec, {allowProject = false, skipConnection = false, expectedProfile} = {}) {
  const before = await agentScope(service, exec);
  if (expectedProfile && expectedProfile !== before.profile)
    throw new Error(`Remote session workspace belongs to ${before.profile}, not ${expectedProfile}`);
  if (before.kind === 'local-project' && !allowProject)
    throw new Error('Local project binding permits only remote_project_* tools; open a dedicated remote workspace for generic remote tools');
  if (!skipConnection) {
    if (!service.connectionGate?.ensure) throw new Error('Remote authorization gate unavailable');
    await service.connectionGate.ensure(before.profile, exec);
  }
  if (exec.signal?.aborted || service.stopped) throw new Error('Remote agent request aborted');
  const after = await agentScope(service, exec);
  if (before.kind !== after.kind || before.profile !== after.profile ||
      before.cwd !== after.cwd || before.root !== after.root || before.remotePath !== after.remotePath)
    throw new Error('Remote session binding changed during authorization');
  return after;
}
module.exports={agentScope,authorizedAgentScope};
