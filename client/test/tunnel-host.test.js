'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { Tunnel, assetFor } = require('../src/main/tunnel');
const { HostManager } = require('../src/main/host');
const { startServer } = require('../src/relay/server');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cloudflared.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memedrop-test-'));

function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('picks the right cloudflared download for each platform', () => {
  assert.match(assetFor('win32', 'x64').url, /cloudflared-windows-amd64\.exe$/);
  assert.equal(assetFor('win32', 'x64').file, 'cloudflared.exe');
  assert.match(assetFor('darwin', 'arm64').url, /cloudflared-darwin-arm64\.tgz$/);
  assert.match(assetFor('linux', 'arm64').url, /cloudflared-linux-arm64$/);
});

test('tunnel resolves with the public URL once Cloudflare registers it', async () => {
  const tunnel = new Tunnel({ dir: tmp(), binary: FAKE });
  try {
    const url = await tunnel.start(8787, { timeoutMs: 5000 });
    assert.equal(url, 'https://silly-test-words-here.trycloudflare.com');
    assert.equal(tunnel.url, url);
  } finally {
    tunnel.stop();
  }
  assert.equal(tunnel.proc, null);
});

test('tunnel reports a helpful error if cloudflared dies early', async () => {
  await withEnv({ FAKE_TUNNEL_MODE: 'die' }, async () => {
    const tunnel = new Tunnel({ dir: tmp(), binary: FAKE });
    await assert.rejects(tunnel.start(8787, { timeoutMs: 5000 }), /closed before it was ready.*429/);
  });
});

test('tunnel still resolves if the "registered" line never shows up', async () => {
  await withEnv({ FAKE_TUNNEL_MODE: 'no-register' }, async () => {
    const tunnel = new Tunnel({ dir: tmp(), binary: FAKE });
    try {
      const url = await tunnel.start(8787, { timeoutMs: 15000 });
      assert.match(url, /trycloudflare\.com$/);
    } finally {
      tunnel.stop();
    }
  });
});

test('tunnel emits exit when cloudflared stops on its own', async () => {
  const tunnel = new Tunnel({ dir: tmp(), binary: FAKE });
  await tunnel.start(8787, { timeoutMs: 5000 });
  const exited = new Promise((r) => tunnel.once('exit', r));
  tunnel.proc.kill();
  await exited;
  assert.equal(tunnel.url, null);
});

test('downloads the helper once, with progress', async () => {
  const payload = Buffer.alloc(300 * 1024, 7);
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url.includes('missing')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': payload.length });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = tmp();
    const tunnel = new Tunnel({ dir, fetch: (url, opts) => fetch(url.replace(/^https:\/\/github\.com.*\//, `${base}/`), opts) });
    assert.equal(tunnel.isInstalled(), false);
    const progress = [];
    const file = await tunnel.ensureBinary((p) => progress.push(p));
    assert.ok(fs.readFileSync(file).equals(payload));
    assert.equal(progress[progress.length - 1], 1);
    if (process.platform !== 'win32') assert.ok(fs.statSync(file).mode & 0o100, 'executable');
    await tunnel.ensureBinary();
    assert.equal(hits, 1, 'not downloaded twice');

    const broken = new Tunnel({ dir: tmp(), fetch: (url, opts) => fetch(`${base}/missing`, opts) });
    await assert.rejects(broken.ensureBinary(), /error 404/);
    const offline = new Tunnel({ dir: tmp(), fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(offline.ensureBinary(), /Couldn't download/);
  } finally {
    server.close();
  }
});

/** A stand-in tunnel for host tests. */
function fakeTunnel({ url = 'https://fake-tunnel.trycloudflare.com', fail = null } = {}) {
  const t = new EventEmitter();
  t.installed = false;
  t.isInstalled = () => t.installed;
  t.ensureBinary = async (onProgress) => {
    onProgress(0.5);
    onProgress(1);
    t.installed = true;
  };
  t.start = async (port) => {
    t.port = port;
    if (fail) throw new Error(fail);
    return url;
  };
  t.stop = () => {
    t.stopped = true;
  };
  return t;
}

function wsJoin(url, room, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') resolve({ ws, welcome: msg });
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, nickname })));
  });
}

test('hosting over the internet: starts the relay, downloads the helper, opens a tunnel', async () => {
  const tunnel = fakeTunnel();
  const host = new HostManager({ startServer: (o) => startServer({ ...o, log: () => {} }), tunnel, preferredPort: 0 });
  const states = [];
  host.on('state', (s) => states.push({ ...s }));
  try {
    const { localUrl, inviteLink } = await host.start({ room: 'TACO-1234', mode: 'internet' });
    assert.equal(inviteLink, 'https://fake-tunnel.trycloudflare.com/join/TACO-1234');
    assert.match(localUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(host.state.status, 'on');
    assert.ok(states.some((s) => /Downloading/.test(s.step)), 'shows the download step');
    assert.ok(states.some((s) => s.progress === 0.5), 'reports progress');
    assert.equal(tunnel.port, Number(localUrl.split(':').pop()));

    const { ws, welcome } = await wsJoin(localUrl, 'TACO-1234', 'Host');
    assert.equal(welcome.features.giphy, false);
    const features = new Promise((r) => ws.on('message', (raw) => JSON.parse(raw).type === 'features' && r(JSON.parse(raw))));
    host.setGiphyKey('abcdefghijklmnopqrstuvwxyz123456');
    assert.equal((await features).features.giphy, true);
    ws.close();

    tunnel.emit('exit', 1);
    assert.equal(host.state.status, 'error');
    assert.match(host.state.error, /Restart room/);
  } finally {
    await host.stop();
  }
  assert.equal(host.state.status, 'off');
  assert.equal(tunnel.stopped, true);
});

test('hosting on Wi-Fi only: no tunnel, invite uses the LAN address', async () => {
  const tunnel = fakeTunnel();
  const host = new HostManager({ startServer: (o) => startServer({ ...o, log: () => {} }), tunnel, preferredPort: 0 });
  try {
    const { inviteLink } = await host.start({ room: 'LAN-1', mode: 'lan' });
    const lanIp = require('../src/main/host').lanAddress();
    if (lanIp) {
      assert.match(inviteLink, new RegExp(`^http://${lanIp.replace(/\./g, '\\.')}:\\d+/join/LAN-1$`));
      const res = await fetch(inviteLink);
      assert.equal(res.status, 200, 'landing page reachable on the LAN address');
    }
    assert.equal(tunnel.port, undefined, 'tunnel not used');
  } catch (err) {
    if (!/network address/.test(err.message)) throw err; // machine without a LAN: fine
  } finally {
    await host.stop();
  }
});

test('falls back to another port if 8787 is busy, and cleans up after tunnel failure', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;
  const host = new HostManager({
    startServer: (o) => startServer({ ...o, log: () => {} }),
    tunnel: fakeTunnel({ fail: 'Cloudflare took too long' }),
    preferredPort: busyPort,
  });
  try {
    await assert.rejects(host.start({ room: 'BUSY-1', mode: 'internet' }), /Cloudflare took too long/);
    assert.equal(host.state.status, 'error');
    assert.equal(host.server, null, 'relay closed again');

    const ok = new HostManager({ startServer: (o) => startServer({ ...o, log: () => {} }), tunnel: fakeTunnel(), preferredPort: busyPort });
    const { localUrl } = await ok.start({ room: 'BUSY-2', mode: 'internet' });
    assert.notEqual(Number(localUrl.split(':').pop()), busyPort);
    await ok.stop();
  } finally {
    blocker.close();
    await host.stop();
  }
});
