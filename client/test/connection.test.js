'use strict';

// Exercises the client's Connection against the real relay server (no Electron needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Connection } = require('../src/main/connection');

let startServer;
try {
  ({ startServer } = require(path.join(__dirname, '..', '..', 'server', 'src', 'server.js')));
} catch {
  startServer = null; // server deps not installed — skip these tests
}

const skip = startServer ? false : 'run `npm install` in /server to enable these tests';

function waitFor(conn, predicate, timeoutMs = 3000) {
  if (predicate(conn.state)) return Promise.resolve(conn.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.off('state', onState);
      reject(new Error(`timed out; last state: ${JSON.stringify(conn.state)}`));
    }, timeoutMs);
    function onState(s) {
      if (predicate(s)) {
        clearTimeout(timer);
        conn.off('state', onState);
        resolve(s);
      }
    }
    conn.on('state', onState);
  });
}

const PNG = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'server', 'test', 'fixtures', 'tiny.png'));

test('connects, sees friends, sends and receives drops', { skip }, async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const url = `ws://127.0.0.1:${server.port}`;
  const alice = new Connection();
  const bob = new Connection();
  try {
    alice.connect({ url, room: 'TEST', nickname: 'Alice' });
    await waitFor(alice, (s) => s.status === 'connected');
    assert.equal(alice.state.room, 'TEST');
    assert.equal(alice.state.features.giphy, false);

    bob.connect({ url, room: 'TEST', nickname: 'Bob' });
    await waitFor(bob, (s) => s.status === 'connected');
    await waitFor(alice, (s) => s.peers.length === 2);

    const received = new Promise((resolve) => bob.once('drop', resolve));
    const reply = await alice.request({
      type: 'drop',
      to: bob.state.selfId,
      kind: 'image',
      data: PNG.toString('base64'),
      opacity: 0.4,
      durationMs: 2000,
      position: 'fullscreen',
    });
    assert.equal(reply.delivered, 1);
    const drop = await received;
    assert.equal(drop.from.nickname, 'Alice');
    assert.equal(drop.mime, 'image/png');
    assert.equal(drop.opacity, 0.4);

    await assert.rejects(
      alice.request({ type: 'gif-trending' }, { idField: 'reqId' }),
      (err) => err.code === 'giphy_disabled',
    );

    bob.disconnect();
    await waitFor(alice, (s) => s.peers.length === 1);
    assert.equal(bob.state.status, 'disconnected');
  } finally {
    alice.disconnect();
    bob.disconnect();
    await server.close();
  }
});

test('a bad room code stops retrying and reports the error', { skip }, async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, limits: { maxRoomSize: 1 } });
  const url = `ws://127.0.0.1:${server.port}`;
  const a = new Connection();
  const b = new Connection();
  try {
    a.connect({ url, room: 'FULL', nickname: 'A' });
    await waitFor(a, (s) => s.status === 'connected');
    b.connect({ url, room: 'FULL', nickname: 'B' });
    const s = await waitFor(b, (st) => st.status === 'disconnected' && st.error);
    assert.match(s.error, /full/);
  } finally {
    a.disconnect();
    b.disconnect();
    await server.close();
  }
});

test('reconnects and rejoins after the server restarts', { skip }, async () => {
  let server = await startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const port = server.port;
  const conn = new Connection();
  try {
    conn.connect({ url: `ws://127.0.0.1:${port}`, room: 'COMEBACK', nickname: 'Phoenix' });
    await waitFor(conn, (s) => s.status === 'connected');

    await server.close();
    await waitFor(conn, (s) => s.status === 'reconnecting');
    await assert.rejects(conn.request({ type: 'drop' }), /Not connected/);

    server = await startServer({ port, host: '127.0.0.1', log: () => {} });
    const s = await waitFor(conn, (st) => st.status === 'connected', 8000);
    assert.equal(s.room, 'COMEBACK');
    assert.equal(s.nickname, 'Phoenix');
  } finally {
    conn.disconnect();
    await server.close();
  }
});
