'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { startServer } = require('../src/server');

const silentLog = () => {};

async function startTestServer(opts = {}) {
  return startServer({ port: 0, host: '127.0.0.1', log: silentLog, ...opts });
}

/**
 * A test client that records every message and lets tests `await` the next
 * message of a given type.
 */
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const client = {
    ws,
    inbox,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    /** Resolve with the next message matching `type` (string) or predicate. */
    next(typeOrFn, timeoutMs = 2000) {
      const match = typeof typeOrFn === 'function' ? typeOrFn : (m) => m.type === typeOrFn;
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for ${typeof typeOrFn === 'string' ? typeOrFn : 'message'}`));
        }, timeoutMs);
        waiters.push({ match, resolve, timer });
      });
    },
    /** Assert that no message matching `type` arrives within `ms`. */
    async expectNone(type, ms = 150) {
      await new Promise((r) => setTimeout(r, ms));
      const found = inbox.find((m) => m.type === type);
      if (found) throw new Error(`Expected no "${type}" but got ${JSON.stringify(found).slice(0, 200)}`);
    },
    async join(room, nickname) {
      client.send({ type: 'join', room, nickname });
      const welcome = await client.next((m) => m.type === 'welcome' || m.type === 'error');
      if (welcome.type === 'error') throw new Error(`join failed: ${welcome.message}`);
      client.id = welcome.id;
      client.nickname = welcome.nickname;
      return welcome;
    },
    close() {
      ws.close();
      return new Promise((r) => ws.once('close', r));
    },
  };
  return client;
}

// Real (tiny) images for each supported format, made with Pillow.
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const SAMPLE_IMAGES = {
  png: fixture('tiny.png'),
  jpeg: fixture('tiny.jpg'),
  gif: fixture('tiny.gif'),
  webp: fixture('tiny-lossy.webp'),
};

/** A fake GIPHY API that counts calls and returns canned results. */
function fakeGiphyFetch({ status = 200, delayMs = 0 } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (status !== 200) {
      return { ok: false, status, json: async () => ({ message: 'nope' }) };
    }
    const offset = Number(u.searchParams.get('offset') || 0);
    const label = u.pathname.endsWith('/trending') ? 'trend' : u.searchParams.get('q');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [0, 1].map((i) => makeGif(`${label}-${offset + i}`)),
        pagination: { total_count: 100, count: 2, offset },
      }),
    };
  };
  return { fetch, calls };
}

function makeGif(id) {
  return {
    id,
    title: `GIF ${id}`,
    user: { username: 'someone', display_name: 'Some One' },
    images: {
      original: {
        url: `https://media1.giphy.com/media/${id}/giphy.gif`,
        webp: `https://media1.giphy.com/media/${id}/giphy.webp`,
        width: '480',
        height: '270',
        size: '2000000',
        webp_size: '900000',
      },
      fixed_width_still: {
        url: `https://media1.giphy.com/media/${id}/200w_s.gif`,
        width: '200',
        height: '113',
      },
      fixed_width_downsampled: {
        url: `https://media1.giphy.com/media/${id}/200w_d.gif`,
        webp: `https://media1.giphy.com/media/${id}/200w_d.webp`,
        width: '200',
        height: '113',
      },
    },
  };
}

module.exports = { startTestServer, connect, SAMPLE_IMAGES, fixture, fakeGiphyFetch, makeGif };
