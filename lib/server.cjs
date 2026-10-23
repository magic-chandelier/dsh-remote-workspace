'use strict';
const path = require('node:path');
const os = require('node:os');
const { Store } = require('./store.cjs');
const {ConnectionGate} = require('./connection-gate.cjs');
const {BindingTrust} = require('./binding-trust.cjs');
const {agentScope} = require('./agent-scope.cjs');
const { RemoteManager } = require('./remote.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { OperationsManager, processCommand, serviceCommand } = require('./operations.cjs');
const { handleBindingApi } = require('./binding-api.cjs');
const { NativeWorkspaceManager } = require('./native-workspace.cjs');
const { VirtualWorkspaceManager } = require('./virtual-workspace.cjs');
const { targetFor, requestShellApproval, runApprovedShell } = require('./remote-shell.cjs');
const { resolveAgentProfile } = require('./remote-context.cjs');
const { virtualIdForCwd } = require('./virtual-workspace.cjs');
const { logAudit, commandHash } = require('./audit.cjs');
const { preview: cleanupPreview, purge: cleanupPurge } = require('./cleanup.cjs');
const { resolveDataDir } = require('./data-dir.cjs');
const { TransferSessions } = require('./transfer-sessions.cjs');
const VERSION = String(require('../package.json').version || '0.0.0').split('-')[0];

// Harness requires absence of optional `required`, not `{ required: false }`.
const S = (required = true, description = '') => ({ type: 'string', ...(required ? { required: true } : {}), description });
const B = (required = false, description = '') => ({ type: 'boolean', ...(required ? { required: true } : {}), description });
const I = (required = false, description = '') => ({ type: 'integer', ...(required ? { required: true } : {}), description });
const p = S(false, 'Optional connection ID; omit for selected remote workspace');
const filename = S(true, 'Remote path relative to selected workspace');
const ROUTE = '/api/dsh-remote-workspace';

function createService(config = {}, options = {}) {
  const initial = Array.isArray(config.profiles) ? config.profiles : [];
  const storage = options.filename ? {root:path.dirname(options.filename),reason:'test-file'} : resolveDataDir({dataDir:config.dataDir,profileDir:options.profileDir});
  const dataDir = storage.root;
  const store = new Store(options.filename || path.join(dataDir,'connections.json'), initial);
  const root = config.localRoot || path.join(os.homedir(), 'Downloads', 'dsh-remote-transfers');
  const remote = options.remote || new RemoteManager(store, { localRoot: root });
  const terminal = options.terminal || new TerminalManager(store);
  const operations = options.operations || new OperationsManager(store);
  const service = { store, remote, terminal, operations, stopped:false, localRoot: root, dataDir, dataLocationReason:storage.reason, auditFile:path.join(dataDir,'audit.jsonl'), bindingRegistry: null, questions: null };
  service.bindingTrust = options.bindingTrust || new BindingTrust(dataDir);
  service.transfers = options.transfers || new TransferSessions(remote, dataDir);
  service.connectionGate = options.connectionGate || new ConnectionGate(store,remote,()=>service.questions);
  service.native = options.native || new NativeWorkspaceManager(store, { rootPath: () => path.join(dataDir,'mounts') });
  service.virtual = options.virtual || new VirtualWorkspaceManager(store, { remote, root:path.join(dataDir,'session-anchors') });
  service.dispose = () => {
    if (service.stopped) return;
    service.stopped = true;
    service.connectionGate.clear();
    service.transfers.dispose();
    store.sessionPasswords?.clear();
    if (typeof terminal.dispose === 'function') terminal.dispose();
    else terminal.closeAll();
    service.questions = null;
    service.sessionTitle = null;
    service.workingDirectory = null;
    service.bindingRegistry = null;
    service.native.setRegistry?.(null);
    service.virtual.setRegistry?.(null);
  };
  return service; 
}
// The fields below use the convenient per-property authoring DSL, but we
// register RAW tools, not defineTool() tools. Raw tool registrations MUST expose
// ordinary JSON Schema with a top-level `type: "object"`. The DSL map was the
// root cause of model requests failing with `schema type: null` in 0.2.2.
function toParameterJsonSchema(fields) {
  const properties = {};
  const required = [];
  for (const [key, definition] of Object.entries(fields)) {
    if (!definition || !['string', 'boolean', 'integer', 'number'].includes(definition.type)) {
      throw new TypeError(`Invalid tool parameter ${key}`);
    }
    const { required: isRequired, ...property } = definition;
    if (isRequired === true) required.push(key);
    // JSON Schema `required` belongs on the parent object, never on fields.
    properties[key] = property;
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// A directly registered raw tool is also responsible for input validation:
// defineTool() would normally perform this step for us.
function assertToolArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) throw new TypeError(`Missing required argument: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const descriptor = schema.properties[key];
    if (!descriptor) throw new TypeError(`Unknown argument: ${key}`);
    const valid = descriptor.type === 'integer' ? Number.isInteger(value) :
      descriptor.type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      typeof value === descriptor.type;
    if (!valid) throw new TypeError(`Invalid argument type for ${key}; expected ${descriptor.type}`);
  }
}

function toolsFor(service) {
  const { store, remote } = service;
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  const make = (name, description, fields, work) => {
    const parameters = toParameterJsonSchema(fields);
    return {
      name, description, parameters, output,
      async execute(args = {}, exec) {
        if (service.stopped) throw new Error('Remote workspace plugin has stopped');
        assertToolArgs(parameters, args);
        // Resolve the session's target first. Never let a model-supplied profile
        // pivot a virtual remote workspace to a different server.
        if (Object.hasOwn(parameters.properties, 'profile')) {
          args = { ...args, profile: await resolveAgentProfile(service, args.profile, exec, {skipConnection:name==='remote_connection_status',allowProject:name==='remote_connection_status'||name==='remote_connect_request'}) };
        }
        return JSON.stringify(await work(args, exec));
      }
    };
  };
  return [
    make('remote_profiles', 'Show only the remote server bound to the current Agent session.', {}, async (_args,exec) => {
      const scope=await agentScope(service,exec);
      return {profiles:store.list().filter(p=>p.id===scope.profile)};
    }),
    make('remote_workspace', 'Show only the remote server bound to this Agent session.', {}, async (_args,exec) => {
      const scope=await agentScope(service,exec);
      return {active:scope.profile,workspace:scope.kind==='remote-workspace'?store.workspace(scope.profile):scope.remotePath,
        mode:scope.kind,sessionBound:true,connection:service.connectionGate.state(scope.profile,exec)};
    }),
    make('remote_connection_status', 'Check whether this AI session is authorized to use its remote server. If not, use remote_connect_request or ask the user to connect manually; NEVER switch to local tools.', { profile:p }, async (a,exec) => {
      return service.connectionGate.state(a.profile,exec);
    }),
    make('remote_connect_request', 'Ask the human to authorize connection using remembered credentials, then test the selected remote server. If password was not remembered, request a manual connection in plugin UI.', {profile:p}, async(a,exec)=>service.connectionGate.state(a.profile,exec)),
    make('remote_list', 'Browse remote workspace directory. Select workspace from the visual manager first.', { profile: p, path: S(false, 'Path relative to selected workspace; default current root') }, a => remote.list(a.profile, a.path || '.')),
    make('remote_stat', 'Inspect remote file or directory metadata.', { profile: p, path: filename }, a => remote.stat(a.profile, a.path)),
    make('remote_read', 'Read a UTF-8 remote text file and return SHA-256 for safe editing.', { profile: p, path: filename }, a => remote.read(a.profile, a.path)),
    make('remote_write', 'Safely write a UTF-8 file after reading it: requires expected SHA-256, or empty string only for new files.', { profile: p, path: filename, content: S(true, 'New complete UTF-8 file content'), expectedSha256: S(true, 'SHA-256 of last read or empty string to create') }, a => remote.write(a.profile, a.path, a.content, a.expectedSha256)),
    make('remote_replace', 'Read and replace a uniquely matching exact string with SHA-256 protection.', { profile: p, path: filename, search: S(true, 'Exact substring'), replacement: S(true, 'Replacement text') }, async a => {
      const old = await remote.read(a.profile, a.path);
      if (!a.search || old.content.indexOf(a.search) < 0 || old.content.indexOf(a.search) !== old.content.lastIndexOf(a.search)) throw new Error('Search text must match exactly once');
      return remote.write(a.profile, a.path, old.content.replace(a.search, a.replacement), old.sha256);
    }),
    make('remote_mkdir', 'Create a directory inside the selected remote workspace.', { profile: p, path: filename }, a => remote.mkdir(a.profile, a.path)),
    make('remote_rename', 'Move or rename a remote entry inside the selected workspace.', { profile: p, from: S(true), to: S(true) }, a => remote.rename(a.profile, a.from, a.to)),
    make('remote_delete', 'Delete one file or one empty directory only; destructive action.', { profile: p, path: filename, directory: B(false, 'True only for empty directory') }, a => remote.remove(a.profile, a.path, a.directory === true)),
    make('remote_search', 'Search filename substrings recursively in the selected workspace.', { profile: p, pattern: S(true), path: S(false), depth: I(false) }, a => remote.search(a.profile, a.pattern, a.path || '.', a.depth)),
    make('remote_upload', 'Upload one local file from the configured local transfer root to the remote workspace.', { profile: p, remotePath: S(true), localPath: S(true) }, a => remote.transfer(a.profile, a.remotePath, a.localPath, 'upload')),
    make('remote_download', 'Download one remote file into the configured local transfer root.', { profile: p, remotePath: S(true), localPath: S(true) }, a => remote.transfer(a.profile, a.remotePath, a.localPath, 'download')),
    make('remote_exec', 'Run one exact SSH command from the connection execAllowlist. Does not run arbitrary shell commands.', { profile: p, command: S(true) }, (a, exec) => remote.exec(a.profile, a.command, { signal: exec?.signal })),
    {
      name: 'remote_shell',
      description: 'Execute arbitrary SSH command in selected remote working directory, with a mandatory real user approval for EVERY command. Never silently run local bash instead of SSH.',
      parameters: toParameterJsonSchema({ profile: S(false, 'SSH connection ID. Omit within a plugin remote session workspace'), command: S(true, 'Complete SSH shell command; displayed verbatim to the user'), timeoutMs: I(false, 'Timeout 1..300000 ms') }), output,
      async execute(args, exec) {
        assertToolArgs(toParameterJsonSchema({ profile: S(false), command: S(true), timeoutMs: I(false) }), args);
        const id = await resolveAgentProfile(service, args.profile, exec);
        const target = targetFor(store, id, args.command, args.timeoutMs);
        const event = { tool: 'remote_shell', profile: target.p.id, remoteDirectory: target.cwd,
          commandSha256: commandHash(target.command), callId: String(exec.callId || '') };
        logAudit({ ...event, state: 'requested' }, service.auditFile);
        try {
          await requestShellApproval(service.questions, exec, target);
        } catch (error) {
          logAudit({ ...event, state: 'declined' }, service.auditFile);
          throw error;
        }
        if (service.stopped) throw new Error('Remote workspace plugin has stopped');
        if (service.connectionGate && !service.connectionGate.state(id,exec).authorized)
          throw new Error('Remote connection authorization changed during SSH command approval');
        // Fail closed if audit storage cannot commit before executing a command.
        logAudit({ ...event, state: 'approved' }, service.auditFile);
        try {
          const result = await runApprovedShell(store, target, { signal: exec.signal });
          try { logAudit({ ...event, state: 'completed', exitCode: result.exitCode, truncated: result.truncated }, service.auditFile); }
          catch (_) { result.auditWarning = 'Post-execution audit logging failed; remote command may already have changed server state'; }
          return JSON.stringify(result);
        } catch (error) {
          try { logAudit({ ...event, state: 'error', errorClass: error?.code || error?.name || 'Error' }, service.auditFile); }
          catch (_) { /* original failure and possibility of remote side-effects take priority */ }
          throw error;
        }
      }
    },
    make('remote_monitor', 'Read Linux CPU, load, memory, swap, disks, and network counters over SSH without modifying the server.', { profile: p }, (a, exec) => service.operations.monitor(a.profile, exec?.signal)),
    make('remote_processes', 'List the top 200 Linux processes by CPU with PID, user, memory and status.', { profile: p }, (a, exec) => service.operations.processes(a.profile, exec?.signal)),
    make('remote_services', 'List Linux systemd service states over SSH.', { profile: p }, (a, exec) => service.operations.services(a.profile, exec?.signal)),
    {
      name: 'remote_process_signal', description: 'Send TERM or KILL to a remote PID. Requires explicit approval by the human user for each action.',
      parameters: toParameterJsonSchema({ profile: p, pid: I(true), signal: S(true, 'TERM or KILL') }), output,
      async execute(args, exec) {
        assertToolArgs(toParameterJsonSchema({ profile: p, pid: I(true), signal: S(true) }), args);
        const id = await resolveAgentProfile(service, args.profile, exec);
        const target = targetFor(store, id, processCommand(args.pid, args.signal));
        const event = { tool:'remote_process_signal', profile:id, commandSha256:commandHash(target.command), callId:String(exec?.callId || '') };
        logAudit({...event,state:'requested'},service.auditFile);
        try { await requestShellApproval(service.questions,exec,target); }
        catch(error) { logAudit({...event,state:'declined'},service.auditFile); throw error; }
        if (service.stopped) throw new Error('Remote workspace plugin has stopped');
        if (service.connectionGate && !service.connectionGate.state(id,exec).authorized)
          throw new Error('Remote connection authorization changed during process approval');
        logAudit({...event,state:'approved'},service.auditFile);
        try {
          const result = await service.operations.signalProcess(id,args.pid,args.signal,exec.signal);
          try {logAudit({...event,state:'completed',exitCode:result.exitCode},service.auditFile);}catch(_){}
          return JSON.stringify(result);
        } catch(error) {
          try {logAudit({...event,state:'error'},service.auditFile);}catch(_){}
          throw error;
        }
      }
    },
    {
      name: 'remote_service_control', description: 'Start, stop or restart a systemd service over SSH with individual human approval.',
      parameters: toParameterJsonSchema({ profile: p, unit: S(true, 'Full systemd .service unit name'), action: S(true, 'start, stop or restart') }), output,
      async execute(args, exec) {
        assertToolArgs(toParameterJsonSchema({ profile: p, unit: S(true), action: S(true) }),args);
        const id = await resolveAgentProfile(service,args.profile,exec);
        const target = targetFor(store,id,serviceCommand(args.unit,args.action));
        const event = {tool:'remote_service_control',profile:id,commandSha256:commandHash(target.command),callId:String(exec?.callId||'')};
        logAudit({...event,state:'requested'},service.auditFile);
        try { await requestShellApproval(service.questions,exec,target); }
        catch(error) {logAudit({...event,state:'declined'},service.auditFile);throw error;}
        if (service.stopped) throw new Error('Remote workspace plugin has stopped');
        if (service.connectionGate && !service.connectionGate.state(id,exec).authorized)
          throw new Error('Remote connection authorization changed during service approval');
        logAudit({...event,state:'approved'},service.auditFile);
        try {
          const result = await service.operations.controlService(id,args.unit,args.action,exec.signal);
          try {logAudit({...event,state:'completed',exitCode:result.exitCode},service.auditFile);}catch(_){}
          return JSON.stringify(result);
        } catch(error) {try{logAudit({...event,state:'error'},service.auditFile);}catch(_){}throw error;}
      }
    },
    make('remote_connect_test', 'Test authentication and root directory listing for a configured connection.', { profile: S(true) }, a => remote.test(a.profile))
  ].map(tool => ({
    ...tool,
    async execute(...args) {
      if (service.stopped) throw new Error('Remote workspace plugin has stopped');
      return tool.execute(...args);
    },
  }));
}
async function readLimitedJson(request, maxBytes = 1024 * 1024) {
  if (!request?.body?.getReader) {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > maxBytes) throw new Error('Request too large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  }
  const reader = request.body.getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Request too large');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}
const ACTIONS = new Set(['list', 'save', 'remove', 'test', 'browse', 'select', 'read', 'write', 'mkdir', 'rename', 'delete', 'search', 'status', 'upload', 'download', 'transfer_upload_begin', 'transfer_upload_chunk', 'transfer_upload_finish', 'transfer_download_begin', 'transfer_download_start', 'transfer_download_status', 'transfer_download_chunk', 'transfer_cancel', 'terminal_open', 'terminal_poll', 'terminal_send', 'terminal_resize', 'terminal_close', 'forget_host_key', 'workspace_list', 'binding_read', 'binding_compare', 'binding_save', 'binding_remove', 'native_create', 'native_status', 'virtual_create', 'virtual_status', 'virtual_remove', 'connect_for_agent', 'disconnect_for_agent', 'connection_status', 'cleanup_preview', 'cleanup_purge', 'monitor', 'processes', 'services', 'process_signal', 'service_control']);
function makeRoute(service) {
  const { store, remote, terminal } = service;
  return {
    path: ROUTE, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (service.stopped) return new Response(JSON.stringify({ok:false,error:'Remote workspace plugin has stopped'}), {status:503,headers:{'content-type':'application/json'}});
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      try {
        const length = Number(request.headers?.get('content-length') || 0);
        if (length > 1024 * 1024) return new Response(JSON.stringify({ ok: false, error: 'Request too large' }), { status: 413, headers });
        // Both absent and forged Content-Length are handled by bounded streaming.
        const body = await readLimitedJson(request);
        if (!body || !ACTIONS.has(body.action)) throw new Error('Unknown operation');
        let result;
        switch (body.action) {
          case 'workspace_list':
          case 'binding_read':
          case 'binding_compare':
          case 'binding_save':
          case 'binding_remove': result = await handleBindingApi(service, body); break;
          case 'list': { const cleanup=service.virtual?.prune?.() || {removed:[],retained:[]};result = { profiles: store.list(), active: store.active, localRoot: service.localRoot, dataDir:service.dataDir, dataLocationReason:service.dataLocationReason, vaultWarning:store.vault.loadError || null, cleanup }; break; }
          case 'virtual_create':
            if (!service.workingDirectory?.ensure) throw new Error('Harness workingDirectory service unavailable; cannot safely route remote sessions');
            result = await service.virtual.create(body.id, { title: body.title }); break;
          case 'virtual_status': result = service.virtual.status(body.id); break;
          case 'virtual_remove': result = await service.virtual.remove(body.id); break;
          case 'cleanup_preview': result = cleanupPreview(service); break;
          case 'cleanup_purge': result = await cleanupPurge(service, body.confirmation); break;
          case 'native_create': result = await service.native.create(body.id, { title: body.title }); break;
          case 'native_status': result = service.native.status(body.id); break;
          case 'connect_for_agent': result = await service.connectionGate.connectManually(body.id); break;
          case 'disconnect_for_agent': result = service.connectionGate.disconnect(body.id); break;
          case 'connection_status': result = service.connectionGate.state(body.id); break;
          case 'status': result = { version: VERSION, active: store.active, workspace: store.active ? store.workspace(store.active) : '' }; break;
          case 'monitor': result = await service.operations.monitor(body.id); break;
          case 'processes': result = await service.operations.processes(body.id); break;
          case 'services': result = await service.operations.services(body.id); break;
          case 'process_signal': {
            const command = processCommand(body.pid,body.signal);
            if (body.confirmation !== `SIGNAL_${body.pid}_${body.signal}`) throw new Error('Explicit process confirmation required');
            const event = { tool:'ui_process_signal', profile:body.id, commandSha256:commandHash(command) };
            logAudit({...event,state:'approved'},service.auditFile);
            try {result = await service.operations.signalProcess(body.id,body.pid,body.signal);
              try{logAudit({...event,state:'completed'},service.auditFile);}catch(_){} }
            catch(error){try{logAudit({...event,state:'error'},service.auditFile);}catch(_){}throw error;}
            break;
          }
          case 'service_control': {
            const command = serviceCommand(body.unit,body.operation);
            if (body.confirmation !== `SERVICE_${body.operation}_${body.unit}`) throw new Error('Explicit service confirmation required');
            const event = { tool:'ui_service_control', profile:body.id, commandSha256:commandHash(command) };
            logAudit({...event,state:'approved'},service.auditFile);
            try{result = await service.operations.controlService(body.id,body.unit,body.operation);
              try{logAudit({...event,state:'completed'},service.auditFile);}catch(_){} }
            catch(error){try{logAudit({...event,state:'error'},service.auditFile);}catch(_){}throw error;}
            break;
          }
          case 'save': result = store.upsert(body.profile); break;
          case 'remove': { const cleanup=await service.virtual.remove(body.id);store.remove(body.id);service.connectionGate.disconnect(body.id);result = { removed: body.id, cleanup }; break; }
          case 'forget_host_key': result = store.forgetHostKey(body.id); break;
          case 'test': result = await remote.test(body.id); break;
          case 'browse': result = await remote.list(body.id, body.path || '.', true); break;
          case 'select': result = await remote.select(body.id, body.path); break;
          case 'read': result = await remote.read(body.id, body.path); break;
          case 'write': result = await remote.write(body.id, body.path, body.content, body.expectedSha256); break;
          case 'mkdir': result = await remote.mkdir(body.id, body.path); break;
          case 'rename': result = await remote.rename(body.id, body.from, body.to); break;
          case 'delete': result = await remote.remove(body.id, body.path, body.directory === true); break;
          case 'search': result = await remote.search(body.id, body.pattern, body.path || '.', body.depth || 2); break;
          case 'upload': result = await remote.uploadBase64(body.id, body.path, body.contentBase64, body.overwrite === true); break;
          case 'download': result = await remote.downloadBase64(body.id, body.path); break;
          case 'transfer_upload_begin': result = service.transfers.beginUpload(body.id,body.path,body.bytes); break;
          case 'transfer_upload_chunk': result = service.transfers.appendUpload(body.id,body.token,body.index,body.contentBase64); break;
          case 'transfer_upload_finish': result = await service.transfers.finishUpload(body.id,body.token); break;
          case 'transfer_download_begin': result = await service.transfers.beginDownload(body.id,body.path); break;
          case 'transfer_download_start': result = service.transfers.startDownload(body.id,body.path); break;
          case 'transfer_download_status': result = service.transfers.downloadStatus(body.id,body.token); break;
          case 'transfer_download_chunk': result = service.transfers.downloadChunk(body.id,body.token,body.index); break;
          case 'transfer_cancel': result = service.transfers.cancel(body.id,body.token); break;
          case 'terminal_open': result = await terminal.open(body.id, body.cols, body.rows); break;
          case 'terminal_poll': result = terminal.poll(body.sessionId); break;
          case 'terminal_send': result = terminal.send(body.sessionId, body.input); break;
          case 'terminal_resize': result = terminal.resize(body.sessionId, body.cols, body.rows); break;
          case 'terminal_close': result = terminal.close(body.sessionId); break;
        }
        return new Response(JSON.stringify({ ok: true, data: result }), { status: 200, headers });
      } catch (error) {
        const message = error && error.message ? String(error.message) : 'Unknown error';
        const status = message === 'Request too large' ? 413 : 400;
        return new Response(JSON.stringify({ ok: false, error: message.slice(0, 400) }), { status, headers });
      }
    }
  };
}

module.exports = { toolsFor, createService, makeRoute, readLimitedJson, toParameterJsonSchema, assertToolArgs, ROUTE };
