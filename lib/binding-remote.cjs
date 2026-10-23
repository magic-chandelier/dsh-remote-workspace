'use strict';
const { getBinding, validateBinding } = require('./binding.cjs');
const { RemoteManager } = require('./remote.cjs');

async function boundRemoteFor(service, localRoot) {
  const { binding } = await getBinding(localRoot);
  let server;
  try { server = service.store.profile(binding.connectionId); } catch { server = null; }
  validateBinding(binding, server);
  // Scoped store is invocation-specific. Never change global active/workspace.
  const scopedStore = Object.create(service.store);
  scopedStore.active = server.id;
  scopedStore.workspace = id => id === server.id ? binding.remotePath : service.store.workspace(id);
  const manager = typeof service.boundRemoteFactory === 'function'
    ? service.boundRemoteFactory(scopedStore)
    : new RemoteManager(scopedStore, { localRoot: service.localRoot });
  return { binding, manager };
}
module.exports = { boundRemoteFor };
