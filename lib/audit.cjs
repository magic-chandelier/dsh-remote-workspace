'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
function auditFile() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-workspace', 'audit.jsonl');
}
function checkedAuditFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing untrusted SSH audit path');
  return stat;
}
function logAudit(event, filename = auditFile(), { maxBytes = MAX_AUDIT_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid audit size limit');
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  const size = Buffer.byteLength(body);
  if (size > maxBytes) throw new Error('Audit entry exceeds size limit');
  const existing = checkedAuditFile(filename);

  if (existing && existing.size + size > maxBytes) {
    const previous = filename + '.1';
    if (checkedAuditFile(previous)) fs.unlinkSync(previous);
    fs.renameSync(filename, previous);
  }
  fs.appendFileSync(filename, body, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  fs.chmodSync(filename, 0o600);
}
const commandHash = command => crypto.createHash('sha256').update(command).digest('hex');
module.exports = { auditFile, logAudit, commandHash, MAX_AUDIT_BYTES };
