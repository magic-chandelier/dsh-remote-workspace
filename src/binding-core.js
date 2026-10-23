// Pure Node backend: DOES NOT register a dsh.client entry, routes or terminal.
// Caller must derive cwd from current Agent, not from a process-global selection.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const BINDING_FILE = '.harness-remote.json'
export const BEGIN = '<!-- DSH_REMOTE_WORKSPACE_BINDING_BEGIN -->'
export const END = '<!-- DSH_REMOTE_WORKSPACE_BINDING_END -->'
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function validateRemotePath(remotePath, remoteRoot) {
  if (typeof remotePath !== 'string' || typeof remoteRoot !== 'string') throw new Error('Invalid remote paths')
  for (const p of [remotePath, remoteRoot]) {
    if (!p.startsWith('/') || /[\0\r\n\\]/.test(p) || p.split('/').some(s => s === '.' || s === '..')) {
      throw new Error('Remote directory must be an absolute POSIX path without traversal')
    }
  }
  const project = path.posix.normalize(remotePath).replace(/\/$/, '') || '/'
  const root = path.posix.normalize(remoteRoot).replace(/\/$/, '') || '/'
  if (project === '/' || (root !== '/' && project !== root && !project.startsWith(root + '/'))) {
    throw new Error('Remote project is outside the configured server root or is /')
  }
  return project
}

async function workspacePath(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Harness workspace must have an absolute local path')
  const root = await fs.realpath(cwd)
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Local workspace is not a directory')
  return root
}
async function safeProjectFile(root, file) {
  const target = path.join(root, file)
  const stat = await fs.lstat(target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${file} must be a regular file, not a symlink`)
  return target
}
function validateId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid connection ID')
  return id
}
export function validateBinding(input, server) {
  const connectionId = validateId(input?.connectionId)
  if (!server || server.id !== connectionId) throw new Error('Selected server is not configured')
  if (!['ssh', 'sftp'].includes(server.protocol)) throw new Error('Project binding requires SSH/SFTP; FTP/FTPS cannot verify remote symlink isolation')
  const remotePath = validateRemotePath(input.remotePath, server.remoteRoot)
  if (input.mode !== undefined && input.mode !== 'manual') throw new Error('Only manual transfer mode is supported')
  return {
    version: 1,
    connectionId,
    remotePath,
    mode: 'manual',
    autoDeploy: false,
    // Credentials, host IP and private keys are deliberately NOT stored.
  }
}
export function noticeBlock() {
  return `${BEGIN}\n## Remote workspace binding (DeepSeek Harness)\nThis directory is the LOCAL project workspace, bound to a remote SSH/SFTP project by .harness-remote.json.\n- First read .harness-remote.json and check the active connection before remote actions.\n- Local read/edit/bash tools act on LOCAL files; do not claim they execute on the SSH host.\n- For the bound server, use remote_project_list/read/compare/write tools (not globally selected remote_* tools).\n- Before upload or deployment, review differences and ask the user to confirm. Never silently overwrite or delete remote files.\n- Do not leak tokens, passwords, private keys or .env files into chat or repositories.\n- A disconnected server does not mean this binding is deleted; confirm connectivity when recovering.\n${END}\n`
}
function modifyNotice(existing, insert) {
  const b = existing.indexOf(BEGIN), e = existing.indexOf(END)
  if ((b < 0) !== (e < 0) || (b >= 0 && e < b)) throw new Error('AGENTS.md contains an incomplete binding notice')
  if (b < 0) return insert ? `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${noticeBlock()}` : existing
  const prefix = existing.slice(0, b), suffix = existing.slice(e + END.length).replace(/^\n/, '')
  return `${prefix}${insert ? noticeBlock() : ''}${suffix}`
}
async function atomicWrite(file, content, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.dsh-${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(tmp, content, { mode, flag: 'wx' })
    await fs.rename(tmp, file)
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
}
export async function getBinding(cwd, { optional = false } = {}) {
  const root = await workspacePath(cwd)
  const filename = await safeProjectFile(root, BINDING_FILE)
  let text
  try { text = await fs.readFile(filename, 'utf8') }
  catch (e) { if (e.code === 'ENOENT' && optional) return null; throw e }
  if (Buffer.byteLength(text, 'utf8') > 8192) throw new Error('Binding file too large')
  let raw
  try { raw = JSON.parse(text) } catch { throw new Error('Binding JSON is invalid; refusing automatic overwrite') }
  if (!raw || raw.version !== 1 || !idPattern.test(raw.connectionId || '') ||
    typeof raw.remotePath !== 'string' || !raw.remotePath.startsWith('/') ||
    /[\0\r\n\\]/.test(raw.remotePath) ||
    raw.remotePath.split('/').some(s => s === '..' || s === '.') ||
    raw.remotePath === '/' || raw.mode !== 'manual' || raw.autoDeploy !== false) {
    throw new Error('Invalid local remote binding; do not trust this file')
  }
  return { root, binding: raw }
}
export async function bindProject(cwd, input, resolveServer, { replace = false } = {}) {
  const root = await workspacePath(cwd)
  if (typeof resolveServer !== 'function') throw new Error('resolveServer function is required')
  const server = await resolveServer(input?.connectionId)
  const binding = validateBinding(input, server)
  const bindingPath = await safeProjectFile(root, BINDING_FILE)
  const agentsPath = await safeProjectFile(root, 'AGENTS.md')
  const oldBinding = await fs.readFile(bindingPath, 'utf8').catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))
  if (oldBinding && !replace) throw new Error('Workspace is already bound. Confirm explicit replace.')
  if (oldBinding) await getBinding(root) // refuse overwriting corrupt bindings
  const oldAgents = await fs.readFile(agentsPath, 'utf8').catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))
  const updatedAgents = modifyNotice(oldAgents ?? '', true)
  if (Buffer.byteLength(updatedAgents, 'utf8') > 1024 * 1024) throw new Error('AGENTS.md exceeds 1 MiB limit')
  const updatedBinding = JSON.stringify(binding, null, 2) + '\n'
  // Best-effort two-file rollback on write error (not a cross-file atomic transaction).
  try {
    await atomicWrite(agentsPath, updatedAgents)
    await atomicWrite(bindingPath, updatedBinding)
  } catch (error) {
    if (oldAgents === null) await fs.rm(agentsPath, { force: true }).catch(() => {})
    else await atomicWrite(agentsPath, oldAgents).catch(() => {})
    if (oldBinding === null) await fs.rm(bindingPath, { force: true }).catch(() => {})
    else await atomicWrite(bindingPath, oldBinding).catch(() => {})
    throw error
  }
  return { localRoot: root, binding }
}
export async function unbindProject(cwd) {
  const { root } = await getBinding(cwd)
  const filename = await safeProjectFile(root, BINDING_FILE)
  const agentsPath = await safeProjectFile(root, 'AGENTS.md')
  const agents = await fs.readFile(agentsPath, 'utf8').catch(e => e.code === 'ENOENT' ? null : Promise.reject(e))
  if (agents !== null) {
    const updated = modifyNotice(agents, false)
    if (updated !== agents) {
      if (updated.trim()) await atomicWrite(agentsPath, updated)
      else await fs.rm(agentsPath, { force: true })
    }
  }
  await fs.rm(filename)
  return { localRoot: root, unbound: true }
}
export async function status(cwd, resolveServer) {
  const result = await getBinding(cwd, { optional: true })
  if (!result) return { bound: false }
  const server = await resolveServer(result.binding.connectionId)
  let error = null
  try { validateBinding(result.binding, server) } catch (e) { error = e.message }
  return { bound: true, localRoot: result.root, binding: result.binding, configuredServer: !!server, validationError: error }
}
