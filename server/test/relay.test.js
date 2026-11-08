'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, connect, SAMPLE_IMAGES } = require('./helpers');

async function withServer(opts, fn) {
  const server = await startTestServer(opts);
  const clients = [];
  const open = async () => {
    const c = await connect(server.port);
    clients.push(c);
    return c;
  };
  try {
    await fn({ server, open });
  } finally {
    for (const c of clients) c.ws.terminate();
    await server.close();
  }
}

test('health endpoint reports status without leaking rooms', async () => {
  await withServer({}, async ({ server }) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'memedrop-relay', ok: true, giphy: false });
    const missing = await fetch(`http://127.0.0.1:${server.port}/nope`);
    assert.equal(missing.status, 404);
  });
});

test('joining a room returns a welcome with peers, limits and features', async () => {
  await withServer({}, async ({ open }) => {
    const alice = await open();
    const welcome = await alice.join('pizza-gang', 'Alice');
    assert.equal(welcome.room, 'PIZZA-GANG', 'room codes are case-insensitive');
    assert.equal(welcome.nickname, 'Alice');
    assert.equal(welcome.protocol, 1);
    assert.deepEqual(welcome.peers, [{ id: welcome.id, nickname: 'Alice' }]);
    assert.equal(welcome.limits.maxImageBytes, 5 * 1024 * 1024);
    assert.deepEqual(welcome.limits.positions, ['random', 'center', 'fullscreen']);
    assert.equal(welcome.features.giphy, false);
  });
});

test('roster updates when friends join and leave', async () => {
  await withServer({}, async ({ open }) => {
    const alice = await open();
    await alice.join('room1', 'Alice');
    const bob = await open();
    const bobWelcome = await bob.join('ROOM1', 'Bob');
    assert.equal(bobWelcome.peers.length, 2);

    const roster = await alice.next('roster');
    assert.deepEqual(roster.peers.map((p) => p.nickname).sort(), ['Alice', 'Bob']);

    await bob.close();
    const after = await alice.next('roster');
    assert.deepEqual(after.peers.map((p) => p.nickname), ['Alice']);
  });
});

test('duplicate nicknames get a number suffix', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    const c = await open();
    await a.join('dupes', 'Sam');
    assert.equal((await b.join('dupes', 'sam')).nickname, 'sam 2');
    assert.equal((await c.join('dupes', 'Sam')).nickname, 'Sam 3');
  });
});

test('rejects bad room codes and nicknames', async () => {
  await withServer({}, async ({ open }) => {
    const c = await open();
    c.send({ type: 'join', room: 'no spaces!', nickname: 'Al' });
    assert.equal((await c.next('error')).code, 'bad_room');
    c.send({ type: 'join', room: 'ok', nickname: '   ' });
    assert.equal((await c.next('error')).code, 'bad_nickname');
    c.send({ type: 'join', room: 'ok', nickname: 'x'.repeat(25) });
    assert.equal((await c.next('error')).code, 'bad_nickname');
  });
});

test('rooms are isolated from each other', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('red', 'A');
    await b.join('blue', 'B');
    a.send({ type: 'drop', to: 'all', kind: 'image', data: SAMPLE_IMAGES.png.toString('base64') });
    const sent = await a.next('drop-sent');
    assert.equal(sent.delivered, 0);
    await b.expectNone('drop');
  });
});

test('dropping an image on everyone reaches all friends but not the sender', async () => {
  await withServer({}, async ({ open }) => {
    const alice = await open();
    const bob = await open();
    const cat = await open();
    await alice.join('memes', 'Alice');
    await bob.join('memes', 'Bob');
    await cat.join('memes', 'Cat');

    alice.send({
      type: 'drop',
      ref: 7,
      to: 'all',
      kind: 'image',
      data: SAMPLE_IMAGES.jpeg.toString('base64'),
      opacity: 0.5,
      durationMs: 3000,
      position: 'center',
    });

    const [b, c, sent] = await Promise.all([bob.next('drop'), cat.next('drop'), alice.next('drop-sent')]);
    for (const drop of [b, c]) {
      assert.equal(drop.kind, 'image');
      assert.equal(drop.mime, 'image/jpeg');
      assert.equal(drop.data, SAMPLE_IMAGES.jpeg.toString('base64'));
      assert.equal(drop.opacity, 0.5);
      assert.equal(drop.durationMs, 3000);
      assert.equal(drop.position, 'center');
      assert.deepEqual(drop.from, { id: alice.id, nickname: 'Alice' });
    }
    assert.equal(sent.ref, 7);
    assert.equal(sent.delivered, 2);
    assert.equal(sent.to, 'all');
    await alice.expectNone('drop');
  });
});

test('dropping on one friend only reaches that friend', async () => {
  await withServer({}, async ({ open }) => {
    const alice = await open();
    const bob = await open();
    const cat = await open();
    await alice.join('memes', 'Alice');
    await bob.join('memes', 'Bob');
    await cat.join('memes', 'Cat');

    alice.send({ type: 'drop', to: bob.id, kind: 'image', data: SAMPLE_IMAGES.png.toString('base64') });
    const drop = await bob.next('drop');
    assert.equal(drop.mime, 'image/png');
    const sent = await alice.next('drop-sent');
    assert.equal(sent.delivered, 1);
    assert.equal(sent.to, bob.id);
    await cat.expectNone('drop');
  });
});

test('all four image formats are accepted and sniffed by content', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('fmt', 'A');
    await b.join('fmt', 'B');
    const expected = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    for (const [name, buf] of Object.entries(SAMPLE_IMAGES)) {
      a.send({ type: 'drop', to: 'all', kind: 'image', data: buf.toString('base64'), mime: 'text/html' });
      const drop = await b.next('drop');
      assert.equal(drop.mime, expected[name], `${name} should be detected from its bytes`);
    }
  });
});

test('rejects unsupported files, junk base64 and oversized images', async () => {
  const maxImageBytes = 1024;
  await withServer({ limits: { maxImageBytes } }, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('caps', 'A');
    await b.join('caps', 'B');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    a.send({ type: 'drop', ref: 1, to: 'all', kind: 'image', data: svg.toString('base64') });
    let err = await a.next('error');
    assert.equal(err.code, 'bad_image');
    assert.equal(err.ref, 1);
    assert.match(err.message, /PNG, JPG, GIF and WebP/);

    a.send({ type: 'drop', to: 'all', kind: 'image', data: 'not base64!!' });
    assert.equal((await a.next('error')).code, 'bad_image');

    const big = Buffer.concat([SAMPLE_IMAGES.png, Buffer.alloc(maxImageBytes)]);
    a.send({ type: 'drop', to: 'all', kind: 'image', data: big.toString('base64') });
    err = await a.next('error');
    assert.equal(err.code, 'bad_image');
    assert.match(err.message, /too big/);

    await b.expectNone('drop');
  });
});

test('clamps opacity and duration, and defaults unknown positions to random', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('clamp', 'A');
    await b.join('clamp', 'B');
    const data = SAMPLE_IMAGES.png.toString('base64');

    a.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 7, durationMs: 999999, position: 'everywhere' });
    let drop = await b.next('drop');
    assert.equal(drop.opacity, 1);
    assert.equal(drop.durationMs, 15000);
    assert.equal(drop.position, 'random');

    a.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: -1, durationMs: 1, position: 'fullscreen' });
    drop = await b.next('drop');
    assert.equal(drop.opacity, 0.1);
    assert.equal(drop.durationMs, 1000);
    assert.equal(drop.position, 'fullscreen');

    a.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 'abc' });
    drop = await b.next('drop');
    assert.equal(drop.opacity, 1);
    assert.equal(drop.durationMs, 4000);
  });
});

test('GIF drops carry only the GIPHY URL, and non-GIPHY URLs are refused', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('gifs', 'A');
    await b.join('gifs', 'B');

    const url = 'https://media2.giphy.com/media/abc123/giphy.gif?cid=x&rid=giphy.gif';
    a.send({ type: 'drop', to: b.id, kind: 'gif', url, width: 480, height: 270, title: 'dancing cat', opacity: 0.8 });
    const drop = await b.next('drop');
    assert.equal(drop.kind, 'gif');
    assert.equal(drop.url, url);
    assert.equal(drop.width, 480);
    assert.equal(drop.height, 270);
    assert.equal(drop.title, 'dancing cat');
    assert.equal(drop.data, undefined);

    for (const bad of [
      'http://media.giphy.com/media/abc/giphy.gif', // not https
      'https://evil.example.com/tracker.gif',
      'https://giphy.com.evil.example/x.gif',
      'https://user:pass@media.giphy.com/x.gif',
      'https://media.giphy.com:8443/x.gif',
      'javascript:alert(1)',
      42,
    ]) {
      a.send({ type: 'drop', to: 'all', kind: 'gif', url: bad });
      const err = await a.next('error');
      assert.equal(err.code, 'bad_gif', `should reject ${bad}`);
    }
    await b.expectNone('drop');
  });
});

test('must join before dropping, and unknown targets are reported', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    a.send({ type: 'drop', to: 'all', kind: 'image', data: SAMPLE_IMAGES.png.toString('base64') });
    assert.equal((await a.next('error')).code, 'not_joined');

    await a.join('x', 'A');
    a.send({ type: 'drop', to: 'deadbeef', kind: 'image', data: SAMPLE_IMAGES.png.toString('base64') });
    assert.equal((await a.next('error')).code, 'peer_not_found');

    a.send({ type: 'drop', to: a.id, kind: 'image', data: SAMPLE_IMAGES.png.toString('base64') });
    assert.equal((await a.next('error')).code, 'peer_not_found', "can't target yourself");
  });
});

test('rate limits drop spam', async () => {
  await withServer({ limits: { dropsPerWindow: 3, dropWindowMs: 60_000 } }, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('spam', 'A');
    await b.join('spam', 'B');
    const data = SAMPLE_IMAGES.png.toString('base64');
    for (let i = 0; i < 4; i += 1) a.send({ type: 'drop', ref: i, to: 'all', kind: 'image', data });
    for (let i = 0; i < 3; i += 1) assert.equal((await a.next('drop-sent')).ref, i);
    const err = await a.next('error');
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.ref, 3);
  });
});

test('room size cap', async () => {
  await withServer({ limits: { maxRoomSize: 2 } }, async ({ open }) => {
    const a = await open();
    const b = await open();
    const c = await open();
    await a.join('tiny', 'A');
    await b.join('tiny', 'B');
    c.send({ type: 'join', room: 'tiny', nickname: 'C' });
    assert.equal((await c.next('error')).code, 'room_full');
  });
});

test('switching rooms leaves the old one', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    const b = await open();
    await a.join('one', 'A');
    await b.join('one', 'B');
    await a.next('roster'); // B joined
    await b.join('two', 'B');
    const roster = await a.next('roster');
    assert.deepEqual(roster.peers.map((p) => p.nickname), ['A']);
  });
});

test('malformed and unknown messages get an error, not a crash', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    a.ws.send('{not json');
    assert.equal((await a.next('error')).code, 'bad_message');
    a.send({ type: 'hack-the-planet' });
    assert.equal((await a.next('error')).code, 'bad_message');
    a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await a.next('error')).code, 'bad_message');
    // Still alive afterwards:
    await a.join('alive', 'A');
  });
});

test('oversized frames beyond maxPayload close the connection instead of buffering', async () => {
  await withServer({ limits: { maxImageBytes: 1024 } }, async ({ open }) => {
    const a = await open();
    await a.join('huge', 'A');
    const closed = new Promise((resolve) => a.ws.once('close', (code) => resolve(code)));
    a.send({ type: 'drop', to: 'all', kind: 'image', data: 'A'.repeat(2 * 1024 * 1024) });
    assert.equal(await closed, 1009);
  });
});

test('GIF search reports when GIPHY is not configured', async () => {
  await withServer({}, async ({ open }) => {
    const a = await open();
    await a.join('nogif', 'A');
    a.send({ type: 'gif-trending', reqId: 'r1' });
    const err = await a.next('error');
    assert.equal(err.code, 'giphy_disabled');
    assert.equal(err.reqId, 'r1');
  });
});
