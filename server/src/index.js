#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');

// Load server/.env if present. Real environment variables win over the file.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`Could not read .env: ${err.message}`);
}

const { startServer } = require('./server');

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const port = envNumber('PORT', 8787);
  const host = process.env.HOST || '0.0.0.0';
  const giphyApiKey = (process.env.GIPHY_API_KEY || '').trim();

  const { port: actualPort, close } = await startServer({
    port,
    host,
    giphyApiKey,
    giphyOptions: {
      rating: process.env.GIPHY_RATING || 'pg-13',
      lang: process.env.GIPHY_LANG || 'en',
      searchTtlMs: envNumber('GIPHY_CACHE_SECONDS', 300) * 1000,
      trendingTtlMs: Math.max(envNumber('GIPHY_CACHE_SECONDS', 300), 600) * 1000,
    },
    limits: {
      maxImageBytes: Math.round(envNumber('MAX_IMAGE_MB', 5) * 1024 * 1024),
      maxRoomSize: envNumber('MAX_ROOM_SIZE', 30),
    },
  });

  console.log('');
  console.log('  MemeDrop relay is running!');
  console.log('');
  console.log(`  Local:    ws://localhost:${actualPort}`);
  for (const addr of lanAddresses()) console.log(`  Network:  ws://${addr}:${actualPort}`);
  console.log('');
  console.log(
    giphyApiKey
      ? '  GIF search: on (GIPHY key loaded)'
      : '  GIF search: off — set GIPHY_API_KEY in server/.env to turn it on',
  );
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, shutting down...`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

main().catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port is already in use. Set a different PORT in server/.env (e.g. PORT=8788).`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
