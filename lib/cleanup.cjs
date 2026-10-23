'use strict';
// Explicit plugin-local data removal before uninstall. Never touches remote
// files, Harness session logs, user projects or the Downloads transfer root.
const fs = require('node:fs');
const path = require('node:path');
const { auditFile } = require('./audit.cjs');
const { reservedIdForCwd } = require('./virtual-workspace.cjs');
const { vaultPath } = require('./credential-vault.cjs');
const { legacyDataDir } = require('./data-dir.cjs');
const CONFIRM = 'DELETE_PLUGIN_LOCAL_DATA';
const TEMP_FILES = [/^connections\.json\.tmp-\d+-[a-f0-9]{12}$/,/^credentials\.json\.tmp-\d+-[a-f0-9]{10}$/,/^\.binding-trust-[a-f0-9-]{36}\.tmp$/];
function regularFile(filename) {
  try { const s=fs.lstatSync(filename); return s.isFile() && !s.isSymbolicLink(); }
  catch(error) { if(error.code==='ENOENT')return false; throw error; }
}
function preview(service) {
  const root=path.dirname(service.store.file);
  const currentAudit = service.auditFile || auditFile();
  const files=[service.store.file, vaultPath(service.store.file), currentAudit, currentAudit + '.1',
    service.bindingTrust?.file].filter(Boolean);
  const tempFiles=fs.existsSync(root) && fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink()
    ? fs.readdirSync(root).filter(name=>TEMP_FILES.some(p=>p.test(name)))
      .map(name=>path.join(root,name)).filter(regularFile) : [];
  const owned=[...files.filter(regularFile),...tempFiles];
  const anchors=service.virtual.rootPath();
  let ids=[];
  if (fs.existsSync(anchors)) {
    const s=fs.lstatSync(anchors);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Untrusted plugin anchor root');
    ids=fs.readdirSync(anchors);
  }
  const transferRoot=path.join(root,'transfer-cache');
  let transferEntries=[];
  if(fs.existsSync(transferRoot)){
    const st=fs.lstatSync(transferRoot);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Untrusted transfer cache directory');
    transferEntries=fs.readdirSync(transferRoot);
  }
  const oldRoot=legacyDataDir();
  const differentLegacy=path.resolve(oldRoot)!==path.resolve(root) && fs.existsSync(oldRoot) &&
    fs.lstatSync(oldRoot).isDirectory() && !fs.lstatSync(oldRoot).isSymbolicLink();
  const legacyEntries=differentLegacy ? fs.readdirSync(oldRoot).filter(name=>
    ['connections.json','credentials.json','trusted-project-bindings.json','transfer-cache','session-anchors','audit.jsonl'].includes(name)) : [];
  return {
    transferRoot, transferEntries, legacyDataRoot:differentLegacy?oldRoot:null, legacyEntries,
    connectionIds:[...service.store.profiles.keys()],
    registeredWorkspaces:service.virtual.registry?.list?.().filter(w=>reservedIdForCwd(w.path, anchors))?.map(w=>({id:w.id,title:w.title,path:w.path})) || [],
    ownedFiles:owned, temporaryFiles:tempFiles, anchorEntries:ids,
    localProjectBindings:[...(service.bindingTrust?.records?.keys?.()||[])],
    excluded:['Harness historical chat logs','user local projects / old binding files','remote server files','downloaded / uploaded transfer files','unknown files in plugin directory','legacy SSHFS mount directories'],
    confirmation:CONFIRM, dataRoot:root, dataLocationReason:service.dataLocationReason || 'custom',
  };
}
async function purge(service, confirmation) {
  if (confirmation !== CONFIRM) throw new Error('Explicit plugin data deletion confirmation required');
  const before=preview(service);
  if (!service.virtual.registry?.list || !service.virtual.registry?.delete)
    throw new Error('Harness workspace registry unavailable. Cannot safely clean all plugin workspaces');
  // Do not remove a staging file while a remote upload or download still owns it.
  if ([...(service.transfers?.sessions?.values?.() || [])].some(s=>s.busy)) {
    service.transfers.dispose();
    return {complete:false, cleaned:[], errors:[{reason:'Remote transfer is still shutting down; retry cleanup after it finishes'}], remaining:preview(service)};
  }
  const summary=await service.virtual.removeAll();
  const errors=summary.errors;
  // Fail closed on all cleanup errors: do not delete credentials/config while
  // a stale registered workspace may still refer to them.
  if (errors.length) return {complete:false, cleaned:[],errors,remaining:preview(service)};
  const removed=[];
  if(service.transfers?.dispose) service.transfers.dispose();
  if(fs.existsSync(before.transferRoot)){
    for(const name of before.transferEntries){
      const file=path.join(before.transferRoot,name);
      if(!/^rw-[a-f0-9]{32}\.part$/.test(name)||!regularFile(file)){
        errors.push({file,reason:'Unknown or unsafe file in transfer cache'});continue;
      }
      fs.unlinkSync(file);removed.push(file);
    }
    try{fs.rmdirSync(before.transferRoot);removed.push(before.transferRoot);}
    catch(error){if(!['ENOTEMPTY','ENOENT'].includes(error.code))errors.push({file:before.transferRoot,reason:error.message});}
  }
  for(const file of before.ownedFiles) {
    if (!regularFile(file)) { errors.push({file,reason:'Untrusted file changed during cleanup'});continue; }
    fs.unlinkSync(file); removed.push(file);
  }
  // Only delete the plugin data directory if entirely empty, never recursively.
  try { fs.rmdirSync(before.dataRoot); removed.push(before.dataRoot); }
  catch(error) { if(!['ENOTEMPTY','ENOENT'].includes(error.code))errors.push({file:before.dataRoot,reason:error.message}); }
  // Remove only our empty profile-local container, never profileDir itself.
  const parent=path.dirname(before.dataRoot);
  if (path.basename(parent)==='.plugin-data' && path.basename(before.dataRoot)==='dsh-remote-workspace') {
    try { const st=fs.lstatSync(parent); if(st.isDirectory() && !st.isSymbolicLink()) {fs.rmdirSync(parent);removed.push(parent);} }
    catch(error) { if(!['ENOTEMPTY','ENOENT'].includes(error.code))errors.push({file:parent,reason:error.message}); }
  }
  service.store.profiles.clear(); service.store.workspaces.clear(); service.store.sessionPasswords.clear();
  service.store.trustedHostKeys.clear(); service.store.active='';
  service.store.vault.entries={};
  service.bindingTrust?.records?.clear();
  const remaining=preview(service);
  const unexpected=fs.existsSync(before.dataRoot) && fs.lstatSync(before.dataRoot).isDirectory()
    ? fs.readdirSync(before.dataRoot) : [];
  if (unexpected.length) errors.push({reason:'Unrecognized or retained plugin data entries require manual review',entries:unexpected});
  if(remaining.ownedFiles.length || remaining.anchorEntries.length || remaining.transferEntries.length)
    errors.push({reason:'Recognized plugin data still exists after cleanup'});
  if(remaining.legacyEntries.length)
    errors.push({reason:'A separate legacy plugin data directory remains; manual/profile-aware cleanup required',path:remaining.legacyDataRoot,entries:remaining.legacyEntries});
  return {complete:errors.length===0,cleaned:removed,errors,remaining:errors.length?remaining:undefined,excluded:before.excluded,
    note:'Uninstall npm package separately. Historical Harness sessions remain and are marked remote-only.'};
}
module.exports={preview,purge,CONFIRM};
