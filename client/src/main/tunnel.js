'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/**
 * Makes a hosted room reachable from anywhere using a free Cloudflare "quick
 * tunnel" — no account, no router settings. The first time, it downloads
 * Cloudflare's small `cloudflared` helper into the app's data folder.
 *
 * Events: 'exit' (code) when the tunnel stops unexpectedly.
 */

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const READY_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return { file: 'cloudflared.exe', url: RELEASES + (arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe') };
  }
  if (platform === 'darwin') {
    return { file: 'cloudflared', url: RELEASES + (arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'), tgz: true };
  }
  const linuxArch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch] || 'amd64';
  return { file: 'cloudflared', url: RELEASES + `cloudflared-linux-${linuxArch}` };
}

class Tunnel extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dir         folder to keep the helper in
   * @param {Function} opts.fetch     fetch implementation (Electron's net.fetch in the app)
   * @param {string} [opts.binary]    use this helper instead (tests); a .js file is run with Node
   */
  constructor({ dir, fetch, binary } = {}) {
    super();
    this.dir = dir;
    this.fetch = fetch;
    this.override = binary || null;
    this.asset = assetFor();
    this.proc = null;
    this.url = null;
  }

  binaryPath() {
    return this.override || path.join(this.dir, this.asset.file);
  }

  isInstalled() {
    return fs.existsSync(this.binaryPath());
  }

  /** Download the helper if needed. onProgress(fraction 0–1 or null). */
  async ensureBinary(onProgress = () => {}) {
    if (this.isInstalled()) return this.binaryPath();
    if (!this.fetch) throw new Error('No way to download the internet helper.');
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.binaryPath();
    const tmp = `${target}.download`;
    let res;
    try {
      res = await this.fetch(this.asset.url, { redirect: 'follow' });
    } catch {
      throw new Error("Couldn't download the internet helper. Check your connection, or pick “Only people on my Wi-Fi”.");
    }
    if (!res.ok || !res.body) throw new Error(`Couldn't download the internet helper (error ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress(total ? received / total : null);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw new Error(`Download of the internet helper failed: ${err.message}`);
    }
    if (this.asset.tgz) {
      await run('tar', ['-xzf', tmp, '-C', this.dir]);
      fs.rmSync(tmp, { force: true });
    } else {
      fs.renameSync(tmp, target);
    }
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    return target;
  }

  /**
   * Start a tunnel to http://127.0.0.1:<port>. Resolves with the public
   * https URL once Cloudflare has registered the connection.
   */
  start(port, { timeoutMs = 60_000 } = {}) {
    this.stop();
    const bin = this.binaryPath();
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    const isScript = bin.endsWith('.js');
    const proc = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...args] : args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isScript ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    });
    this.proc = proc;
    this.url = null;

    return new Promise((resolve, reject) => {
      let url = null;
      let ready = false;
      let settled = false;
      let tail = '';
      let timer = null;
      let graceTimer = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (err) {
          this.stop();
          reject(err);
        } else {
          this.url = url;
          resolve(url);
        }
      };
      const onData = (chunk) => {
        const text = String(chunk);
        tail = (tail + text).slice(-2000);
        if (!url) {
          const m = URL_RE.exec(text);
          if (m) {
            url = m[0];
            // Usually "registered" follows within a second; don't wait forever for it.
            graceTimer = setTimeout(() => finish(), 8000);
          }
        }
        if (READY_RE.test(text)) ready = true;
        if (url && ready) finish();
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => finish(new Error(`Couldn't start the internet helper: ${err.message}`)));
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        if (!settled) {
          finish(new Error(`The internet tunnel closed before it was ready (code ${code}). ${lastLine(tail)}`.trim()));
        } else {
          this.url = null;
          this.emit('exit', code);
        }
      });
      timer = setTimeout(
        () => finish(new Error('Cloudflare took too long to open a tunnel. Try again, or pick “Only people on my Wi-Fi”.')),
        timeoutMs,
      );
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    if (proc && proc.exitCode === null) {
      proc.removeAllListeners('exit');
      proc.kill();
    }
  }
}

function lastLine(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

module.exports = { Tunnel, assetFor, URL_RE };
