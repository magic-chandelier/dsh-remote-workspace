'use strict';
// Optional OS-level SSHFS bridge. A real mounted filesystem is REQUIRED before
// registering a native Harness workspace; an empty placeholder is never valid.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { checkedPath } = require('./remote.cjs');
function mountRoot() { return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-workspace', 'mounts'); }
function mountPath(profileId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profileId)) throw new Error('Invalid profile ID');
  return path.join(mountRoot(), profileId);
}
function escapeMount(s) { return s.replace(/\\(040|011|012|134)/g, (_m, n) => ({'040':' ','011':'\t','012':'\n','134':'\\'})[n]); }
function mountInfoLinux(dir) {
  const data = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  for (const line of data.split('\n')) {
    const fields = line.split(' '); const sep = fields.indexOf('-');
    if (sep >= 0 && escapeMount(fields[4] || '') === dir && /^(?:fuse\.sshfs|fuse)$/.test(fields[sep + 1] || '')) {
      return { type: fields[sep + 1], source: escapeMount(fields[sep + 2] || '') };
    }
  }
  return null;
}
function mountedLinux(dir) { return Boolean(mountInfoLinux(dir)); }
function isMounted(dir) { return process.platform === 'linux' ? mountedLinux(dir) : false; }
function runProcess(executable, args, { timeoutMs = 25000, runner = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = runner(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env });
    let out = '', err = '', finished = false;
    const settle = (error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(error); else resolve({ stdout: out, stderr: err }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); settle(new Error(executable + ' timed out')); }, timeoutMs);
    child.on('error', e => settle(e));
    child.stdout?.on('data', x => { err; out = (out + x.toString()).slice(-4096); });
    child.stderr?.on('data', x => { err = (err + x.toString()).slice(-4096); });
    child.on('exit', code => settle(code === 0 ? null : new Error(`${executable} failed (${code}): ${err.slice(-600)}`)));
  });
}
// Password-mode SSHFS runs in the foreground: sshpass must remain attached
// to the SSH process while the FUSE mount is alive. The password is sent on
// fd 3, never in argv, the process environment, or an on-disk temp file.
function runPasswordMount(args, { password, mountCheck, timeoutMs = 25000, spawnProcess = spawn } = {}) {
  if (typeof password !== 'string' || !password || /[\r\n\0]/.test(password))
    return Promise.reject(new Error('SSHFS password must be nonempty and cannot contain newline/NUL characters'));
  if (typeof mountCheck !== 'function') return Promise.reject(new Error('SSHFS mount verification unavailable'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess('sshpass', ['-d', '3', 'sshfs', '-f', ...args], {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'], shell: false,
        detached: true, env: process.env
      });
    } catch (error) { reject(error); return; }
    let done = false, stderr = '', poll = null;
    const start = Date.now();
    const sanitized = () => stderr.replaceAll(password, '[REDACTED]').slice(-600);
    const stopMountProcess = () => {
      // sshpass/sshfs live in a separate process group. Only terminate that
      // group on failure, never when a verified mount has been established.
      try { if (child.pid && process.platform === 'linux') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
      catch (_) { /* already exited */ }
    };
    const settle = (error) => {
      if (done) return;
      done = true;
      if (poll) clearTimeout(poll);
      if (error) { stopMountProcess(); reject(error); }
      else {
        // Once SSHFS is mounted the background FUSE process may outlive the
        // Harness process. Do not keep the Node event loop alive with pipes.
        child.unref?.();
        child.stderr?.unref?.();
        resolve({ mounted: true });
      }
    };
    child.on('error', e => settle(e.code === 'ENOENT'
      ? new Error('Password SSHFS requires sshpass and sshfs installed on the Linux Harness host') : e));
    child.on('exit', code => settle(new Error(`Password SSHFS exited before mount (code ${code}): ${sanitized()}`)));
    child.stderr?.on('data', x => { stderr = (stderr + x.toString()).slice(-4096); });
    // Prevent an unhandled EPIPE if the command exits before reading fd 3.
    child.stdio?.[3]?.on('error', () => {});
    if (!child.stdio?.[3]) { settle(new Error('Password pipe unavailable for sshpass')); return; }
    child.stdio[3].end(password + '\n');
    const check = () => {
      if (done) return;
      try { if (mountCheck()) { settle(null); return; } }
      catch (error) { settle(error); return; }
      if (Date.now() - start >= timeoutMs) {
        settle(new Error('Password SSHFS mount timed out or was not verified: ' + sanitized())); return;
      }
      poll = setTimeout(check, 120);
    };
    check();
  });
}
// SSHFS-Win exposes a real filesystem over a Windows UNC provider. No fake
// directory and no secret-bearing `net use` invocation is performed here.
function windowsUncForProfile(p, remotePath) {
  if (!/^[A-Za-z0-9_.-]+$/.test(p.username) || !/^[A-Za-z0-9.-]+$/.test(p.host))
    throw new Error('Windows SSHFS requires a DNS/IPv4 host and standard SSH username');
  if (!Number.isInteger(Number(p.port)) || Number(p.port) < 1 || Number(p.port) > 65535)
    throw new Error('Invalid SSH port');
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || /[\\\r\n\0]/.test(remotePath) || remotePath.split('/').includes('..'))
    throw new Error('Windows SSHFS requires a safe absolute POSIX remote path');
  const prefix = 'sshfs.r'; // Windows credential prompt; do not assume configured Node SSH key is usable by SSHFS-Win.
  // SSHFS-Win .r path is relative to the remote filesystem ROOT.
  const tail = remotePath.split('/').filter(Boolean).join('\\');
  return `\\\\${prefix}\\${p.username}@${p.host}!${Number(p.port)}` + (tail ? `\\${tail}` : '');
}
class NativeWorkspaceManager {
  constructor(store, { mountInfo = process.platform === 'linux' ? mountInfoLinux : () => null, run = runProcess, runPassword = runPasswordMount, registry = null, rootPath = mountRoot, platform = process.platform, windowsStat = p => fs.statSync(p) } = {}) {
    this.store = store; this.mountInfo = mountInfo; this.run = run; this.runPassword = runPassword; this.registry = registry; this.rootPath = rootPath;
    this.inflight = new Map(); this.platform = platform; this.windowsStat = windowsStat; this.windowsRoots = new Map();
  }
  setRegistry(registry) { this.registry = registry; }
  async create(id, { title } = {}) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const promise = this._create(id, { title }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }
  async _create(id, { title } = {}) {
    const p = this.store.profile(id);
    if (!['ssh','sftp'].includes(p.protocol)) throw new Error('Native remote workspace requires SSHFS over SSH');
    if (this.platform === 'win32') return this._createWindows(p, {title});
    if (this.platform !== 'linux') throw new Error('Native SSHFS workspace requires Linux sshfs or Windows SSHFS-Win');
    const sessionPassword = this.store.passwordFor(id);
    const password = sessionPassword || (p.passwordEnv ? process.env[p.passwordEnv] : '');
    const passwordMode = !p.privateKeyPath && Boolean(password);
    if (!p.privateKeyPath && !passwordMode)
      throw new Error('SSHFS authentication missing: set SSH privateKeyPath OR enter a session password (Linux password mode also requires sshpass)');
    if (p.hostTrustMode === 'insecure') throw new Error('Native SSHFS workspace refuses insecure SSH host verification');
    if (!/^[A-Za-z0-9_.-]+$/.test(p.username) || !/^[A-Za-z0-9.-]+$/.test(p.host)) throw new Error('SSHFS mount requires a standard username and DNS/IPv4 host');
    if (!passwordMode && (!fs.existsSync(p.privateKeyPath) || !fs.statSync(p.privateKeyPath).isFile())) throw new Error('SSH private key file not found on Harness host');
    if (!this.registry?.create) throw new Error('Harness workspaceRegistry unavailable');
    const root = this.rootPath(), dir = path.join(root, p.id);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Mount root may not be a symlink');
    fs.mkdirSync(dir, { recursive: true, mode: 0o000 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Mount path may not be a symlink');
    const remotePath = checkedPath(p.remoteRoot, this.store.workspace(p.id));
    const source = `${p.username}@${p.host}:${remotePath}`;
    let info = this.mountInfo(dir);
    if (info && info.source !== source) throw new Error('Mount path already belongs to a different remote source');
    if (!info) {
      // sshfs must authenticate against OpenSSH known_hosts with a pinned/trusted
      // entry configured by the operator; ssh2 TOFU does NOT carry over to SSHFS.
      const opts = [
        'StrictHostKeyChecking=yes', 'ConnectTimeout=15', 'reconnect',
        'ServerAliveInterval=15', 'ServerAliveCountMax=2', `port=${p.port}`,
        ...(passwordMode
          ? ['BatchMode=no', 'PasswordAuthentication=yes', 'KbdInteractiveAuthentication=yes', 'PubkeyAuthentication=no']
          : ['BatchMode=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
             'IdentitiesOnly=yes', `IdentityFile=${p.privateKeyPath}`])
      ];
      // sshfs `-o` is comma-split; refuse option injection via credential filename.
      if (!passwordMode && (p.privateKeyPath.includes(',') || /[\r\n]/.test(p.privateKeyPath)))
        throw new Error('Private key path cannot contain commas/newlines for SSHFS');
      if (p.readOnly !== false) opts.push('ro');
      // FUSE requires a writable mountpoint during mount. Keep an FD for its
      // *underlying* inode, then chmod that inode to 000 even after FUSE covers
      // the directory. An unmounted/stale workspace must not become a writable
      // empty local project on reboot or disconnection.
      fs.chmodSync(dir, 0o700);
      const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        const args = ['-o', opts.join(','), source, dir];
        if (passwordMode) await this.runPassword(args, {
          password,
          mountCheck: () => { const mounted = this.mountInfo(dir); return Boolean(mounted && mounted.source === source); }
        });
        else await this.run('sshfs', args);
        info = this.mountInfo(dir);
        if (!info || info.source !== source) throw new Error('sshfs exited without the expected remote filesystem: native workspace NOT registered');
      } finally {
        try {
          // Linux enforces the underlying mountpoint protection. Windows test
          // doubles may exercise the Linux path but do not support fchmod.
          if (process.platform === 'linux') fs.fchmodSync(fd, 0o000);
        } finally { fs.closeSync(fd); }
      }
    }
    const workspace = await this.registry.create(dir, title || `SSH · ${p.id}`);
    return { native: true, profile: p.id, remotePath, localMount: dir, workspaceId: workspace.id, title: workspace.title };
  }
  async _createWindows(p, {title} = {}) {
    if (!this.registry?.create) throw new Error('Harness workspaceRegistry unavailable');
    if (p.hostTrustMode === 'insecure') throw new Error('Windows native workspace refuses insecure SSH host verification');
    const remotePath = checkedPath(p.remoteRoot, this.store.workspace(p.id));
    const unc = windowsUncForProfile(p, remotePath);
    let stat;
    try { stat = this.windowsStat(unc); }
    catch (error) {
      throw new Error(`Windows SSHFS path is not mounted or accessible: ${unc}. Install WinFsp + SSHFS-Win; open this exact path in Windows Explorer and complete authentication, then retry. (${error.code || error.message})`);
    }
    if (!stat?.isDirectory?.()) throw new Error('Windows SSHFS target is not a directory; workspace NOT registered');
    // Only profile-derived SSHFS-Win UNC strings may be registered. Unlike
    // locally mapped drive letters, this directly binds server identity.
    const workspace = await this.registry.create(unc, title || `SSH · ${p.id}`);
    this.windowsRoots.set(p.id, unc);
    return {native:true, profile:p.id, remotePath, localMount:unc, workspaceId:workspace.id, title:workspace.title, mode:'sshfs-win'};
  }
  windowsPath(id) {
    const p = this.store.profile(id);
    return windowsUncForProfile(p, checkedPath(p.remoteRoot, this.store.workspace(id)));
  }
  status(id) {
    if (this.platform === 'win32') {
      const dir = this.windowsPath(id);
      let mounted = false;
      try { mounted = Boolean(this.windowsStat(dir)?.isDirectory()); } catch (_) { /* offline or not authenticated */ }
      return {profile:id, localMount:dir, mounted, mode:'sshfs-win'};
    }
    const dir = path.join(this.rootPath(), mountPath(id).split(path.sep).at(-1));
    return {profile:id, localMount:dir, mounted:Boolean(this.mountInfo(dir))};
  }
}
module.exports = { NativeWorkspaceManager, mountPath, mountRoot, isMounted, mountedLinux, mountInfoLinux, runProcess, runPasswordMount, windowsUncForProfile };
