#!/usr/bin/env node
// Pretends to be `cloudflared tunnel --url ...` for tests. Mode via FAKE_TUNNEL_MODE.
const mode = process.env.FAKE_TUNNEL_MODE || 'ok';
const url = process.env.FAKE_TUNNEL_URL || 'https://silly-test-words-here.trycloudflare.com';
const log = (line) => process.stderr.write(`2026-11-08T00:00:00Z INF ${line}\n`);
log('Requesting new quick Tunnel on trycloudflare.com...');
if (mode === 'die') {
  log('ERR failed to request quick Tunnel: 429 Too Many Requests');
  process.exit(1);
}
setTimeout(() => {
  log('+--------------------------------------------------------------------------------------------+');
  log('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  log(`|  ${url}                                         |`);
  log('+--------------------------------------------------------------------------------------------+');
  if (mode === 'ok') setTimeout(() => log('Registered tunnel connection connIndex=0 connection=abc location=yyz'), 100);
}, 100);
setInterval(() => {}, 1000);
