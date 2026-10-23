'use strict';
const { status, getBinding } = require('./binding.cjs');
const { boundRemoteFor } = require('./binding-remote.cjs');
const { compareBoundFile } = require('./binding-compare.cjs');
const { resolveServer } = require('./binding-api.cjs');
const { requestBindingApproval } = require('./binding-approval.cjs');
const {createHash} = require('node:crypto');
const {agentScope,authorizedAgentScope} = require('./agent-scope.cjs');
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
function registerBindingTools(ctx, service, defineTool) {
  if (!ctx?.workingDirectory?.ensure || !ctx?.tools?.register) throw new Error('Host workingDirectory/tools not ready');
  if (!service.workingDirectory) service.workingDirectory=ctx.workingDirectory;
  const rootOf = async exec => {
    const scope = await agentScope(service,exec);
    if (scope.kind!=='local-project') throw new Error('Local project tools are unavailable in remote SSH workspaces');
    return scope.root;
  };
  const authorizedBinding = async exec => {
    const scope = await authorizedAgentScope(service,exec,{allowProject:true});
    if (scope.kind !== 'local-project') throw new Error('Local project tools are unavailable in remote SSH workspaces');
    return {root:scope.root,binding:scope.binding};
  };
  const register = spec => ctx.tools.register(defineTool({ ...spec, output }));
  const bindingFor = async exec => {
    const {root, binding} = await authorizedBinding(exec);
    const result = await boundRemoteFor(service, root);
    if (result.binding.connectionId !== binding.connectionId || result.binding.remotePath !== binding.remotePath)
      throw new Error('Project remote binding changed after connection approval');
    return result;
  };
  register({ name:'remote_binding_status', description:'Inspect binding of the CURRENT agent local workspace to a remote SSH directory.', parameters:{},
    async execute(_args, exec) { return JSON.stringify(await status(await rootOf(exec), id=>resolveServer(service,id))); } });
  // Binding is a trusted UI action, never an AI capability. Retain names
  // as compatibility stubs so old agents fail safely instead of inventing a path.
  register({name:'remote_binding_save',description:'Unavailable to AI. Bind from the trusted plugin management UI.',
    parameters:{connectionId:{type:'string',required:true},remotePath:{type:'string',required:true},confirmation:{type:'string',required:true},replace:{type:'boolean'}},
    async execute(){throw new Error('AI cannot create or modify remote bindings; use plugin management UI');}});
  register({name:'remote_binding_remove',description:'Unavailable to AI. Unbind from the trusted plugin management UI.',
    parameters:{confirmation:{type:'string',required:true}},
    async execute(){throw new Error('AI cannot remove remote bindings; use plugin management UI');}});
  register({ name:'remote_project_list', description:'List files in the remote folder BOUND to the CURRENT agent local project. Never use the globally selected remote profile.',
    parameters:{path:{type:'string'}},async execute(a,exec) { const {binding,manager}=await bindingFor(exec);return JSON.stringify(await manager.list(binding.connectionId,a.path||'.')); } });
  register({ name:'remote_project_read', description:'Read remote text file in the SSH directory BOUND to the CURRENT agent local project. Returns SHA-256.',
    parameters:{path:{type:'string',required:true}},async execute(a,exec) { const {binding,manager}=await bindingFor(exec);return JSON.stringify(await manager.read(binding.connectionId,a.path)); } });
  register({ name:'remote_project_compare', description:'READ-ONLY: compare SHA-256 and a small text difference preview for one relative file in CURRENT local workspace and its bound SSH/SFTP project; secrets and symlinks are excluded.',
    parameters:{path:{type:'string',required:true}},
    async execute(a,exec) { const {root,binding}=await authorizedBinding(exec);
      return JSON.stringify(await compareBoundFile(service, root, a.path, {expectedBinding:binding})); } });
  register({ name:'remote_project_write', description:'Write a text file ONLY within the current project binding using SHA-256 conflict protection. Get explicit user approval first; never replay on disconnect.',
    parameters:{path:{type:'string',required:true},content:{type:'string',required:true},expectedSha256:{type:'string',required:true},confirmation:{type:'string',required:true}},
    async execute(a,exec) { if(a.confirmation!=='WRITE_REMOTE_PROJECT')throw new Error('Explicit user approval required for remote writes');
      const {binding,manager}=await bindingFor(exec);
      const text = String(a.content);
      const digest = createHash('sha256').update(text,'utf8').digest('hex');
      await requestBindingApproval(service.questions,exec,'write',`服务器：${binding.connectionId}\n目录：${binding.remotePath}\n文件：${a.path}\n内容字节数：${Buffer.byteLength(text,'utf8')}\nSHA-256：${digest}\n内容预览：${text.slice(0,400)}`);
      if (service.stopped || exec.signal?.aborted || !service.connectionGate.state(binding.connectionId,exec).authorized)
        throw new Error('Remote authorization changed during project write approval');
      const current = (await getBinding(await rootOf(exec))).binding;
      if (current.connectionId!==binding.connectionId || current.remotePath!==binding.remotePath)
        throw new Error('Remote project binding changed during project write approval');
      return JSON.stringify(await manager.write(binding.connectionId,a.path,a.content,a.expectedSha256)); } });
}
module.exports = { registerBindingTools };
