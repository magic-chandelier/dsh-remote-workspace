'use strict';
const { bindProject, getBinding, status, unbindProject } = require('./binding.cjs');
const { compareBoundFile } = require('./binding-compare.cjs');
const {bindingIdentity} = require('./binding-trust.cjs');

function projectFromRegistry(service, workspaceId) {
  const registry = service.bindingRegistry;
  if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function')
    throw new Error('Harness workspaceRegistry is not available in this profile; binding UI is disabled');
  if (typeof workspaceId !== 'string' || workspaceId.length > 128 || !workspaceId)
    throw new Error('Choose a registered Harness local workspace');
  const registered = registry.get(workspaceId);
  if (!registered || typeof registered.path !== 'string') throw new Error('Workspace no longer registered in Harness');
  return registered.path; // path is obtained from trusted host registry, NEVER the browser
}
function resolveServer(service, id) {
  try { return service.store.profile(id); } catch { return null; }
}
async function handleBindingApi(service, body) {
  if (body.action === 'workspace_list') {
    if (!service.bindingRegistry) return { available: false, workspaces: [], reason: 'Harness workspaceRegistry unavailable' };
    return { available: true, workspaces: service.bindingRegistry.list().slice(0, 200).map(w => ({ id: w.id, title: w.title || w.id, path: w.path })) };
  }
  const root = projectFromRegistry(service, body.workspaceId);
  if (body.action === 'binding_compare') return compareBoundFile(service, root, body.path);
  if (body.action === 'binding_read')
    return { binding: (await getBinding(root, { optional: true }))?.binding || null,
      status: await status(root, id => resolveServer(service, id)) };
  if (body.action === 'binding_save') {
    if (body.confirmation !== 'BIND_THIS_WORKSPACE') throw new Error('Binding confirmation missing');
    const result = await bindProject(root, { connectionId: body.connectionId, remotePath: body.remotePath, mode: 'manual' },
      id => resolveServer(service, id), { replace: body.replace === true });
    service.bindingTrust.confirm(result.localRoot,result.binding,bindingIdentity(service.store,result.binding.connectionId));
    service.connectionGate?.disconnect(result.binding.connectionId);
    return result;
  }
  if (body.action === 'binding_remove') {
    if (body.confirmation !== 'UNBIND_THIS_WORKSPACE') throw new Error('Unbind confirmation missing');
    const old = await getBinding(root);
    const result = await unbindProject(root);
    service.bindingTrust.revoke(result.localRoot);
    service.connectionGate?.disconnect(old.binding.connectionId);
    return result;
  }
  throw new Error('Unsupported binding action');
}
module.exports = { handleBindingApi, projectFromRegistry, resolveServer };
