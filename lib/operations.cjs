'use strict';
const { targetFor, runApprovedShell } = require('./remote-shell.cjs');

const MONITOR_COMMAND = [
  'export LC_ALL=C',
  "printf 'RW_CPU_A\\n'", 'head -n 1 /proc/stat',
  'sleep 0.25', "printf 'RW_CPU_B\\n'", 'head -n 1 /proc/stat',
  "printf 'RW_UPTIME\\n'", 'cat /proc/uptime',
  "printf 'RW_LOAD\\n'", 'cat /proc/loadavg',
  "printf 'RW_MEMORY\\n'", 'cat /proc/meminfo',
  "printf 'RW_DISK\\n'", 'df -Pk',
  "printf 'RW_NETWORK\\n'", 'cat /proc/net/dev',
].join('; ');
const PROCESS_COMMAND = 'LC_ALL=C ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,stat=,etime=,comm= --sort=-pcpu | head -n 201';
const SERVICE_COMMAND = 'LC_ALL=C systemctl list-units --type=service --all --no-pager --no-legend --plain | head -n 161';
const SERVICE_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*\.service$/;

function markerSections(stdout) {
  const sections = {};
  let current;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (/^RW_[A-Z_]+$/.test(line)) { current = line.slice(3); sections[current] = []; }
    else if (current) sections[current].push(line);
  }
  return sections;
}
const finite = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const rounded = number => Math.round(number * 10) / 10;
function parseCpu(line) {
  const fields = String(line || '').trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 5) return null;
  const values = fields.slice(1).map(finite);
  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function parseMonitor(stdout) {
  const data = markerSections(stdout);
  const first = parseCpu(data.CPU_A?.[0]), second = parseCpu(data.CPU_B?.[0]);
  if (!first || !second || !data.MEMORY || !data.DISK) throw new Error('Linux /proc metrics unavailable on remote host');
  const delta = second.total - first.total;
  const cpuPercent = delta > 0 ? rounded(100 * Math.max(0, Math.min(1, 1 - (second.idle - first.idle) / delta))) : null;
  const memory = {};
  for (const line of data.MEMORY) {
    const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB/.exec(line);
    if (match) memory[match[1]] = Number(match[2]) * 1024;
  }
  const totalMemory = memory.MemTotal || 0, availableMemory = memory.MemAvailable || 0;
  const swapTotal = memory.SwapTotal || 0;
  const disks = (data.DISK || []).slice(1).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !/^\d+$/.test(fields[1])) return [];
    return [{ filesystem: fields[0], mount: fields.slice(5).join(' '), totalBytes: Number(fields[1]) * 1024,
      usedBytes: Number(fields[2]) * 1024, availableBytes: Number(fields[3]) * 1024,
      usedPercent: finite(fields[4].replace('%', '')) }];
  }).slice(0, 48);
  const interfaces = (data.NETWORK || []).slice(2).flatMap(line => {
    const colon = line.indexOf(':');
    if (colon < 0) return [];
    const values = line.slice(colon + 1).trim().split(/\s+/);
    if (values.length < 16) return [];
    return [{ name: line.slice(0, colon).trim(), rxBytes: finite(values[0]), txBytes: finite(values[8]) }];
  }).slice(0, 48);
  return { cpuPercent, uptimeSeconds: Math.floor(finite(data.UPTIME?.[0]?.split(/\s+/)[0])),
    load: (data.LOAD?.[0] || '').trim().split(/\s+/).slice(0, 3).map(finite),
    memory: { totalBytes: totalMemory, usedBytes: Math.max(0, totalMemory - availableMemory), availableBytes: availableMemory,
      swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - (memory.SwapFree || 0)) },
    disks, interfaces, networkCountersSinceBoot: true };
}
function parseProcesses(stdout) {
  return String(stdout).split(/\r?\n/).flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) return [];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpuPercent: finite(m[4]), memoryPercent: finite(m[5]),
      rssBytes: Number(m[6]) * 1024, state: m[7], elapsed: m[8], command: m[9] }];
  }).slice(0, 200);
}
function parseServices(stdout) {
  return String(stdout).split(/\r?\n/).flatMap(line => {
    const m = /^\s*([\w.@:~-]+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)/.exec(line);
    if (!m) return [];
    return [{ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].slice(0, 200) }];
  }).slice(0, 160);
}
function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 4194304) throw new Error('PID must be an integer greater than 1');
  return pid;
}
function validateSignal(signal) {
  if (!['TERM', 'KILL'].includes(signal)) throw new Error('Only TERM or KILL is supported');
  return signal;
}
function validateService(unit) {
  if (typeof unit !== 'string' || unit.length > 160 || !SERVICE_NAME_RE.test(unit) || unit.includes('..')) throw new Error('Invalid systemd service name');
  return unit;
}
function processCommand(pid, signal) { return `kill -s ${validateSignal(signal)} -- ${validatePid(pid)}`; }
function serviceCommand(unit, operation) {
  if (!['start', 'stop', 'restart'].includes(operation)) throw new Error('Invalid systemd action');
  return `systemctl ${operation} -- ${validateService(unit)}`;
}
class OperationsManager {
  constructor(store, { runner = runApprovedShell } = {}) { this.store = store; this.runner = runner; }
  async execute(id, command, signal, timeoutMs = 16000) {
    const p = this.store.profile(id);
    if (!['ssh', 'sftp'].includes(p.protocol)) throw new Error('Monitoring and process management require SSH/SFTP');
    const controller = signal ? null : new AbortController();
    const result = await this.runner(this.store, targetFor(this.store, id, command, timeoutMs), { signal: signal || controller.signal });
    if (result.truncated) throw new Error('Remote command output exceeds safe preview limit');
    if (result.exitCode !== 0) throw new Error('Remote command failed: ' + String(result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 400));
    return result;
  }
  async monitor(id, signal) { return { profile: id, ...parseMonitor((await this.execute(id, MONITOR_COMMAND, signal)).stdout), capturedAt: new Date().toISOString() }; }
  async processes(id, signal) { return { profile: id, processes: parseProcesses((await this.execute(id, PROCESS_COMMAND, signal)).stdout), capturedAt: new Date().toISOString() }; }
  async services(id, signal) { return { profile: id, services: parseServices((await this.execute(id, SERVICE_COMMAND, signal)).stdout), capturedAt: new Date().toISOString() }; }
  async signalProcess(id, pid, sig, signal) { const result = await this.execute(id, processCommand(pid, sig), signal); return { profile: id, pid, signal: sig, exitCode: result.exitCode }; }
  async controlService(id, unit, action, signal) { const result = await this.execute(id, serviceCommand(unit, action), signal); return { profile: id, unit, action, exitCode: result.exitCode }; }
}
module.exports = { OperationsManager, parseMonitor, parseProcesses, parseServices, processCommand, serviceCommand,
  MONITOR_COMMAND, PROCESS_COMMAND, SERVICE_COMMAND };
