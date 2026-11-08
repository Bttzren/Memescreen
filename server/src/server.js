'use strict';

const http = require('node:http');
const { createRelay } = require('./relay');
const { createGiphyClient } = require('./giphy');
const { normalizeRoom } = require('./validate');

/**
 * Start the HTTP + WebSocket server. HTTP serves a health check and the
 * invite landing page (/join/<ROOM>); everything else happens over the
 * WebSocket.
 *
 * Resolves to { port, server, relay, close(), setGiphyKey(key), hasGiphy() }.
 */
async function startServer({
  port = 8787,
  host = '0.0.0.0',
  giphyApiKey = '',
  giphyOptions = {},
  limits = {},
  log,
} = {}) {
  const makeGiphy = (key) => (key ? createGiphyClient({ apiKey: key, ...giphyOptions }) : null);
  let giphy = makeGiphy(giphyApiKey);

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    if (path === '/' || path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ name: 'memedrop-relay', ok: true, giphy: Boolean(giphy) }));
      return;
    }
    const join = /^\/join\/([^/]+)\/?$/.exec(path);
    const room = join && normalizeRoom(decodeURIComponent(join[1]));
    if (room) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'",
        'referrer-policy': 'no-referrer',
      });
      res.end(invitePage(room));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  const relay = createRelay({ server, giphy, limits, ...(log ? { log } : {}) });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;

  async function close() {
    await relay.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /** Switch GIF search on/off (or to a new key) without restarting. */
  function setGiphyKey(key) {
    giphy = makeGiphy(typeof key === 'string' ? key.trim() : '');
    relay.setGiphy(giphy);
  }

  return { port: actualPort, server, relay, close, setGiphyKey, hasGiphy: () => Boolean(giphy) };
}

/**
 * What a friend sees if they click an invite link in a browser: a button that
 * opens MemeDrop straight into the room (memedrop:// link), plus a fallback.
 */
function invitePage(room) {
  const safeRoom = room.replace(/[^A-Z0-9_-]/g, ''); // already normalised; belt and braces
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${safeRoom} on MemeDrop</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #15121f;
         color: #f4f1ff; font: 16px/1.5 'Segoe UI', system-ui, -apple-system, sans-serif; }
  main { width: min(440px, calc(100% - 32px)); padding: 32px 28px; border-radius: 20px; text-align: center;
         background: #211c32; border: 1px solid #362e50; box-shadow: 0 20px 60px -20px #000; }
  .drop { font-size: 48px; line-height: 1; }
  h1 { margin: 12px 0 4px; font-size: 24px; }
  .room { display: inline-block; margin: 8px 0 20px; padding: 6px 14px; border-radius: 999px;
          background: #2a2440; font-weight: 700; letter-spacing: .08em; }
  a.btn, button { display: block; width: 100%; box-sizing: border-box; margin: 10px 0 0; padding: 14px; border: 0;
         border-radius: 12px; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
  a.btn { background: linear-gradient(135deg, #ff3d8b, #7b2ff7); color: #fff; }
  button { background: #2a2440; color: #f4f1ff; }
  ol { text-align: left; color: #c9c1e3; padding-left: 20px; margin: 22px 0 0; font-size: 14px; }
  li { margin: 6px 0; }
  .muted { color: #9a91b8; font-size: 13px; }
</style></head>
<body><main>
  <div class="drop" aria-hidden="true">💧</div>
  <h1>You're invited to MemeDrop</h1>
  <div class="room">${safeRoom}</div>
  <a class="btn" id="open" href="#">Open in MemeDrop</a>
  <button id="copy" type="button">Copy invite link</button>
  <ol>
    <li>Install MemeDrop (ask the friend who invited you for the installer).</li>
    <li>Click <b>Open in MemeDrop</b> above, or open the app, click <b>Join a room</b> and paste this page's link.</li>
  </ol>
  <p class="muted" id="status"></p>
</main>
<script>
  var link = location.href.split('#')[0];
  document.getElementById('open').href = 'memedrop://join?link=' + encodeURIComponent(link);
  document.getElementById('copy').onclick = function () {
    navigator.clipboard.writeText(link).then(function () {
      document.getElementById('status').textContent = 'Copied! Paste it into MemeDrop → Join a room.';
    });
  };
</script>
</body></html>`;
}

module.exports = { startServer, invitePage };
