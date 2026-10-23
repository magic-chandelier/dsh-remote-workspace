'use strict';
// SSH command execution for the Agent. Commands are approved by a HUMAN on
// the Host before ssh2 sees any bytes; approval is never a model-supplied token.
const { authOptions, checkedPath } = require('./remote.cjs');
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function validateCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16_384 || /\0/.test(command)) throw new Error('Invalid SSH command');
  return command;
}
function targetFor(store, profile, command, timeoutMs) {
  const p = store.profile(profile);
  if (!['ssh', 'sftp'].includes(p.protocol)) throw new Error('SSH shell requires an SSH/SFTP profile');
  const cwd = store.workspace(p.id);
  if (typeof timeoutMs !== 'undefined' && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) throw new Error('SSH timeout must be 1..300000 ms');
  return { p, cwd: checkedPath(p.remoteRoot, cwd), command: validateCommand(command), timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS };
}
async function requestShellApproval(questions, exec, target) {
  if (!exec?.agent || !exec?.signal || !questions?.ask) throw new Error('User approval unavailable; SSH command denied');
  const id = 'dsh-remote-shell-confirm';
  const answer = await questions.ask({
    questions: [{ id, header: '远程 SSH 命令审批', question: `允许在 ${target.p.username}@${target.p.host}:${target.cwd} 执行此命令吗？`,
      detail: `服务器：${target.p.id} (${target.p.host}:${target.p.port})\n工作目录：${target.cwd}\n\n${target.command}`,
      options: [{ label: '允许执行', description: '仅批准本次完整命令' }, { label: '拒绝执行', description: '不连接服务器执行此命令' }] }],
    agent: exec.agent, signal: exec.signal
  });
  const matches = answer?.answers?.filter(x => x.id === id) || [];
  if (exec.signal.aborted || matches.length !== 1 || matches[0].selected?.length !== 1 || matches[0].selected[0] !== '允许执行' || matches[0].custom !== undefined) throw new Error('Remote SSH command declined by user');
}
function runApprovedShell(store, target, { signal, ClientCtor, log = () => {} } = {}) {
  if (!signal || typeof signal.addEventListener !== 'function' || signal.aborted) return Promise.reject(new Error('SSH command aborted'));
  const { p, cwd, command, timeoutMs } = target;
  const fullCommand = `cd -- ${shellQuote(cwd)} && ${command}`;
  return new Promise((resolve, reject) => {
    const client = new (ClientCtor || require('ssh2').Client)();
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, truncated = false;
    let settled = false, channel = null;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); try { client.end(); } catch (_) {} };
    const finish = (error, result) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => { try { channel?.signal('KILL'); channel?.close(); } catch (_) {} finish(new Error('SSH command aborted; command may have had partial remote effects')); };
    const timer = setTimeout(() => {
      try { channel?.signal('KILL'); channel?.close(); } catch (_) {}
      finish(new Error('SSH command timed out; remote effects may have occurred'));
    }, timeoutMs);
    const append = (which, chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (which === 'stdout') {
        stdoutBytes += buf.length;
        if (Buffer.byteLength(stdout) < MAX_OUTPUT_BYTES) stdout += buf.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stdout))).toString('utf8');
      } else {
        stderrBytes += buf.length;
        if (Buffer.byteLength(stderr) < MAX_OUTPUT_BYTES) stderr += buf.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stderr))).toString('utf8');
      }
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) truncated = true;
    };
    signal.addEventListener('abort', aborted, { once: true });
    client.on('error', err => finish(err));
    client.on('ready', () => {
      if (settled) return;
      client.exec(fullCommand, { pty: false }, (error, ch) => {
        if (error) return finish(error);
        channel = ch;
        ch.on('data', bytes => append('stdout', bytes));
        ch.stderr.on('data', bytes => append('stderr', bytes));
        ch.on('error', err => finish(err));
        ch.on('close', (code, signalName) => finish(null, {
          profile: p.id, remoteDirectory: cwd, exitCode: Number.isInteger(code) ? code : null,
          exitSignal: signalName || null, stdout, stderr, truncated,
          stdoutBytes, stderrBytes
        }));
      });
    });
    try { log({ event: 'ssh_command_start', profile: p.id, cwd, command, timeoutMs }); client.connect(authOptions(p, store)); }
    catch (error) { finish(error); }
  });
}
module.exports = { targetFor, requestShellApproval, runApprovedShell, shellQuote, validateCommand, MAX_OUTPUT_BYTES };
