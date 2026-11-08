'use strict';

const os = require('node:os');
const { EventEmitter } = require('node:events');
const { buildInviteLink } = require('../shared/invite');

/**
 * Runs a MemeDrop room on this PC: the same relay as the standalone server,
 * started inside the app. Two ways for friends to reach it:
 *
 *   'internet' – listen on 127.0.0.1 only (no firewall prompt) and expose it
 *                through a Cloudflare quick tunnel → https://…trycloudflare.com
 *   'lan'      – listen on the local network → http://192.168.x.y:8787
 *
 * Emits 'state' with { status, mode, room, step, progress, inviteLink,
 * localUrl, error } whenever anything changes.
 */
class HostManager extends EventEmitter {
  constructor({ startServer, tunnel, preferredPort = 8787, log = () => {} }) {
    super();
    this.startServer = startServer;
    this.tunnel = tunnel;
    this.preferredPort = preferredPort;
    this.log = log;
    this.server = null;
    this.state = idleState();
    this.runId = 0;

    if (tunnel) {
      tunnel.on('exit', () => {
        if (this.state.status !== 'on' || this.state.mode !== 'internet') return;
        this.setState({
          status: 'error',
          error: 'The internet connection for your room dropped. Click “Restart room” to get a fresh invite link.',
        });
      });
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  get running() {
    return Boolean(this.server);
  }

  /** Start hosting. Resolves with { localUrl, inviteLink } or throws a friendly Error. */
  async start({ room, mode = 'internet', giphyKey = '' }) {
    await this.stop();
    const runId = ++this.runId;
    const cancelled = () => runId !== this.runId;
    this.setState({ ...idleState(), status: 'starting', mode, room, step: 'Starting your room…' });

    try {
      const host = mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
      let server;
      try {
        server = await this.startServer({ port: this.preferredPort, host, giphyApiKey: giphyKey });
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') server = await this.startServer({ port: 0, host, giphyApiKey: giphyKey });
        else throw err;
      }
      if (cancelled()) {
        await server.close();
        throw new Error('cancelled');
      }
      this.server = server;
      const localUrl = `ws://127.0.0.1:${server.port}`;

      let base;
      if (mode === 'lan') {
        const ip = lanAddress();
        if (!ip) throw new Error("Couldn't find your Wi-Fi/network address. Are you connected to a network?");
        base = `http://${ip}:${server.port}`;
      } else {
        if (!this.tunnel) throw new Error('Internet hosting is not available.');
        if (!this.tunnel.isInstalled()) {
          this.setState({ step: 'Downloading the internet helper (one time only)…', progress: 0 });
          await this.tunnel.ensureBinary((p) => {
            if (!cancelled()) this.setState({ progress: p });
          });
        }
        if (cancelled()) throw new Error('cancelled');
        this.setState({ step: 'Opening your room to the internet…', progress: null });
        base = await this.tunnel.start(server.port);
      }
      if (cancelled()) throw new Error('cancelled');

      const inviteLink = buildInviteLink(base, room);
      this.setState({ status: 'on', step: '', progress: null, inviteLink, localUrl, error: null });
      this.log(`hosting ${room} (${mode}) at ${inviteLink}`);
      return { localUrl, inviteLink };
    } catch (err) {
      if (cancelled() || err.message === 'cancelled') throw new Error('cancelled');
      await this.teardown();
      const message = err && err.code === 'EACCES' ? "MemeDrop isn't allowed to open a network port." : err.message;
      this.setState({ status: 'error', step: '', progress: null, error: message });
      throw new Error(message);
    }
  }

  setGiphyKey(key) {
    if (this.server) this.server.setGiphyKey(key);
  }

  async stop() {
    this.runId += 1;
    await this.teardown();
    if (this.state.status !== 'off') this.setState(idleState());
  }

  async teardown() {
    if (this.tunnel) this.tunnel.stop();
    const server = this.server;
    this.server = null;
    if (server) await server.close().catch(() => {});
  }
}

function idleState() {
  return { status: 'off', mode: null, room: null, step: '', progress: null, inviteLink: null, localUrl: null, error: null };
}

/** Best guess at this PC's address on the home network (prefers 192.168.x / 10.x). */
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^169\.254\./.test(iface.address)) continue; // no DHCP
      let score = 0;
      if (/^192\.168\./.test(iface.address)) score += 3;
      else if (/^10\./.test(iface.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) score += 1;
      if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|utun|tailscale|zerotier/i.test(name)) score -= 5;
      candidates.push({ address: iface.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].address : null;
}

module.exports = { HostManager, lanAddress };
