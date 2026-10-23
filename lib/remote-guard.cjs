'use strict';
// Remote sessions must not fall back to host-local tools.
const { workspaceProfileForCwd, isSshfsWinUnc } = require('./remote-context.cjs');
const { virtualIdForCwd, virtualIdentityMatches, reservedIdForCwd } = require('./virtual-workspace.cjs');
const path = require('node:path');
const { legacyDataDir } = require('./data-dir.cjs');
const {agentScope} = require('./agent-scope.cjs');
const MUTATIONS = new Set(['remote_exec','remote_write','remote_replace','remote_mkdir',
  'remote_rename','remote_delete','remote_upload','remote_download']);
const SAFE_OTHER_TOOLS = new Set(['ask_user_question','todo_write','web_search','web_fetch','exit_plan_mode']);
// Remote project writes have their own mandatory question approval; do not ask twice.
const PROJECT_TOOLS = new Set(['remote_project_list','remote_project_read','remote_project_compare','remote_project_write',
  'remote_binding_status','remote_workspace','remote_profiles','remote_connection_status','remote_connect_request']);
async function remoteToolGuard(service, exec, next) {
  if (exec?.agent && !service.workingDirectory?.ensure && (service.virtual.registry || service.native.registry))
    return {kind:'deny',reason:'workingDirectory unavailable: remote session isolation cannot be verified'};
  let trustedRemoteCwd;
  if (typeof exec?.name==='string' && exec.name.startsWith('remote_')) {
    if (exec.name==='remote_binding_save' || exec.name==='remote_binding_remove')
      return {kind:'deny',reason:'Only the plugin management UI can create, change, or remove remote bindings'};
    let scope;
    try {scope=await agentScope(service,exec);trustedRemoteCwd=scope.cwd;}
    catch(error){return {kind:'deny',reason:String(error.message||error)};}
    if (scope.kind==='local-project' && !PROJECT_TOOLS.has(exec.name))
      return {kind:'deny',reason:'Local project binding only permits remote_project_* scoped tools; use a dedicated remote workspace for other remote actions'};
    if (exec.arguments?.profile && exec.arguments.profile!==scope.profile)
      return {kind:'deny',reason:'AI cannot select a different remote server than the current bound session'};
  }
  const args = exec?.arguments;
  const cwdArg = args && typeof args === 'object' && (args.workdir || args.cwd);
  let cwd = typeof cwdArg === 'string' ? cwdArg : null;
  // The agent/session cwd always wins; a model may not select a local cwd to
  // bypass the remote-only policy while in a remote session.
  if (exec.agent && service.workingDirectory?.ensure) {
    cwd = trustedRemoteCwd || await service.workingDirectory.ensure(exec.agent, exec.signal);
  }
  const legacyRoot = path.join(legacyDataDir(), 'session-anchors');
  const legacyReserved = path.resolve(service.virtual.rootPath()) !== path.resolve(legacyRoot) && reservedIdForCwd(cwd, legacyRoot);
  if (legacyReserved && !SAFE_OTHER_TOOLS.has(exec.name)) return {kind:'deny',reason:'Old remote workspace uses a previous data directory; historical session execution is disabled. Create a new SSH workspace.'};
  const nativeRoot = service.native.rootPath();
  const legacyMountRoot = path.join(legacyDataDir(),'mounts');
  const reservedNative = reservedIdForCwd(cwd,nativeRoot) ||
    (path.resolve(nativeRoot)!==path.resolve(legacyMountRoot) && reservedIdForCwd(cwd,legacyMountRoot)) ||
    (isSshfsWinUnc(cwd) ? 'sshfs-win' : null);
  const nativeId = workspaceProfileForCwd(service.store, cwd, nativeRoot) ||
    workspaceProfileForCwd(service.store, cwd,legacyMountRoot);
  const reservedId = reservedIdForCwd(cwd, service.virtual.rootPath());
  const id = virtualIdForCwd(cwd, service.virtual.rootPath());
  if (reservedId && !id) {
    if (SAFE_OTHER_TOOLS.has(exec.name)) return next();
    return {kind:'deny', reason:`Removed SSH workspace ${reservedId}: local and remote execution disabled for historical session`};
  }
  if (id || reservedNative || nativeId) {
    if (id && !virtualIdentityMatches(service.store, id, service.virtual.rootPath(), cwd)) {
      return { kind:'deny', reason:'Remote session identity changed or connection deleted; create a new connection ID and workspace' };
    }
    // Project binding tools manipulate local AGENTS.md / project files and
    // cannot run from native mounts or plugin-owned remote session anchors.
    if (/^remote_(?:binding_|project_)/.test(exec.name))
      return {kind:'deny',reason:'Local project binding tools are forbidden inside SSH remote workspaces'};
    if (exec.name.startsWith('remote_')) {
      if (reservedNative && !nativeId && !id && !SAFE_OTHER_TOOLS.has(exec.name))
        return {kind:'deny',reason:'Removed SSHFS remote workspace: tools disabled for historical session'};
      if (args?.profile && args.profile !== (id || nativeId)) return { kind:'deny', reason:'Remote workspace profile mismatch' };
      const session=id ? exec.agent?.session : null;
      if (session && service.sessionTitle?.rename && service.sessionTitle?.get) {
        try {
          const old=service.sessionTitle.get(session)?.title || '';
          const profile=service.store.profile(id);
          const remotePath=service.store.workspace(id);
          const leaf=remotePath.split('/').filter(Boolean).at(-1) || '/';
          const prefix=`[SSH ${id}@${profile.host.slice(0,28)}:${leaf.slice(0,20)}] `;
          if (!old.startsWith(prefix)) service.sessionTitle.rename(session, (prefix + (old || '远程服务器会话')).slice(0,120));
        } catch (_) { /* optional session-title service cannot affect SSH tools */ }
      }
    } else if (!SAFE_OTHER_TOOLS.has(exec.name)) {
      return { kind:'deny', reason:`This session targets SSH workspace ${id || nativeId || reservedNative}. Local tool ${exec.name} is forbidden. Use remote_* tools; no local shell, filesystem or code runner is allowed (SSHFS mount protection).` };
    }
  }
  if (MUTATIONS.has(exec.name)) return { kind:'ask', reason:`Remote workspace mutation: ${exec.name}`,
    displayReason:{en:`Approve remote operation ${exec.name}`,zh:`批准远程操作 ${exec.name}`} };
  return next();
}
module.exports = { remoteToolGuard };
