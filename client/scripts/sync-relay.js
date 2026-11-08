#!/usr/bin/env node
'use strict';

/**
 * Copies the relay server code (server/src) into the app (client/src/relay)
 * so MemeDrop can host rooms itself — no separate server needed.
 *
 * server/src is the single source of truth; this runs automatically before
 * `npm start`, `npm test` and `npm run dist`. Don't edit client/src/relay.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'server', 'src');
const DEST = path.join(__dirname, '..', 'src', 'relay');
const FILES = ['cache.js', 'giphy.js', 'relay.js', 'server.js', 'validate.js'];

if (!fs.existsSync(SRC)) {
  if (fs.existsSync(path.join(DEST, 'relay.js'))) process.exit(0); // already synced (e.g. packaged source)
  console.error(`sync-relay: can't find ${SRC}`);
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
for (const file of FILES) {
  const body = fs.readFileSync(path.join(SRC, file), 'utf8');
  const header = `// GENERATED from server/src/${file} by client/scripts/sync-relay.js. Edit the original, not this copy.\n`;
  const out = path.join(DEST, file);
  const next = header + body;
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== next) fs.writeFileSync(out, next);
}
