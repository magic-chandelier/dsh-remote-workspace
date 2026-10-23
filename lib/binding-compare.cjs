'use strict';
// Read-only comparison. No synchronization and no write-on-disconnect.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { boundRemoteFor } = require('./binding-remote.cjs');
const { getBinding } = require('./binding.cjs');
const MAX = 1024 * 1024;
const HASH = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relativeFile(input) {
  if (typeof input !== 'string' || input.length > 1024 || !input || input.startsWith('/') ||
    /[\\\0\r\n]/.test(input)) throw new Error('Comparison path must be a relative POSIX file path');
  const segments = input.split('/');
  if (segments.some(s => !s || s === '.' || s === '..')) throw new Error('Path traversal or empty segment is forbidden');
  if (segments.some(s => /^\.env(?:\.|$)/i.test(s) || /^\.git$/i.test(s) || /^\.ssh$/i.test(s) ||
    /^node_modules$/i.test(s) || /^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials|secrets?)$/i.test(s) ||
    /\.(?:pem|key|p12|pfx)$/i.test(s) || s === '.harness-remote.json'))
    throw new Error('Sensitive or generated files cannot be compared');
  return input;
}

function missing(err) {
  return err && (err.code === 'ENOENT' || /(?:no such file|not found|does not exist|550\b)/i.test(String(err.message || '')));
}
async function localSnapshot(root, relative) {
  let next = root;
  const parts = relative.split('/');
  // Check each component, not only the final target: a parent symlink might
  // lead elsewhere even if the final file is a regular file.
  for (const [i, part] of parts.entries()) {
    next = path.join(next, part);
    let stat;
    try { stat = await fs.lstat(next); }
    catch (e) { if (missing(e)) return null; throw e; }
    if (stat.isSymbolicLink()) throw new Error('Local symlinks are not supported in comparison paths');
    if (i !== parts.length - 1 && !stat.isDirectory()) throw new Error('Local comparison parent is not a directory');
    if (i === parts.length - 1 && !stat.isFile()) throw new Error('Local comparison path is not a regular file');
    if (i === parts.length - 1 && stat.size > MAX) throw new Error('Local comparison file exceeds 1 MiB');
  }
  const bytes = await fs.readFile(next);
  if (bytes.length > MAX || bytes.includes(0)) throw new Error('Local comparison file is binary or exceeds 1 MiB');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { content, sha256: HASH(bytes), bytes: bytes.length };
}
function description(data) {
  return data ? { exists: true, sha256: data.sha256, bytes: data.bytes,
    lines: data.content === '' ? 0 : data.content.split('\n').length } : { exists: false };
}
function preview(local, remote) {
  if (!local || !remote || local.sha256 === remote.sha256) return [];
  const a = local.content.split('\n'), b = remote.content.split('\n');
  const size = Math.max(a.length, b.length);
  const differences = [];
  let omitted = 0;
  for (let i = 0; i < size; i++) {
    if (a[i] !== b[i]) {
      if (differences.length < 8) differences.push({ line: i + 1,
        local: a[i]?.slice(0, 180) ?? null, remote: b[i]?.slice(0, 180) ?? null });
      else omitted++;
    }
  }
  if (omitted) differences.push({ omitted });
  return differences;
}
async function compareBoundFile(service, root, filepath, {expectedBinding} = {}) {
  const relative = relativeFile(filepath);
  const actual = (await getBinding(root)).root;
  const { binding, manager } = await boundRemoteFor(service, actual);
  if (expectedBinding && (binding.connectionId !== expectedBinding.connectionId || binding.remotePath !== expectedBinding.remotePath))
    throw new Error('Project remote binding changed after connection approval');
  const local = await localSnapshot(actual, relative);
  let remote;
  try { remote = await manager.read(binding.connectionId, relative); }
  catch (e) { if (!missing(e)) throw e; remote = null; }
  const identical = !!(local && remote && local.sha256 === remote.sha256);
  return { path: relative, connectionId: binding.connectionId, remoteRoot: binding.remotePath,
    status: identical ? 'identical' : !local && !remote ? 'both_missing' : !local ? 'local_missing' :
      !remote ? 'remote_missing' : 'different',
    local: description(local), remote: description(remote), differences: preview(local, remote),
    readOnly: true };
}
module.exports = { relativeFile, localSnapshot, compareBoundFile, preview };
