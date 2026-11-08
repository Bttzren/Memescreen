'use strict';

const http = require('node:http');
const { createRelay } = require('./relay');
const { createGiphyClient } = require('./giphy');

/**
 * Start the HTTP + WebSocket server. HTTP only serves a tiny health check
 * (handy for hosting platforms); everything else happens over the WebSocket.
 *
 * Resolves to { port, url, close(), relay, giphy }.
 */
async function startServer({
  port = 8787,
  host = '0.0.0.0',
  giphyApiKey = '',
  giphyOptions = {},
  limits = {},
  log,
} = {}) {
  const giphy = giphyApiKey ? createGiphyClient({ apiKey: giphyApiKey, ...giphyOptions }) : null;

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ name: 'memedrop-relay', ok: true, giphy: Boolean(giphy) }));
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

  return { port: actualPort, server, relay, giphy, close };
}

module.exports = { startServer };
