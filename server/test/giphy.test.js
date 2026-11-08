'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGiphyClient, normalizeGif, normalizeResponse } = require('../src/giphy');
const { startTestServer, connect, fakeGiphyFetch, makeGif } = require('./helpers');

const KEY = 'test-key-123';

test('search calls GIPHY with the key and returns slim items', async () => {
  const fake = fakeGiphyFetch();
  const giphy = createGiphyClient({ apiKey: KEY, fetch: fake.fetch, rating: 'pg' });
  const res = await giphy.search('  Cats  ', 0);

  assert.equal(fake.calls.length, 1);
  const url = fake.calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.giphy.com/v1/gifs/search');
  assert.equal(url.searchParams.get('api_key'), KEY);
  assert.equal(url.searchParams.get('q'), 'Cats');
  assert.equal(url.searchParams.get('rating'), 'pg');
  assert.equal(url.searchParams.get('limit'), '24');

  assert.equal(res.items.length, 2);
  const item = res.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['full', 'id', 'preview', 'title', 'user']);
  assert.match(item.preview.url, /^https:\/\/media1\.giphy\.com\/.*200w_d\.webp$/);
  assert.match(item.full.url, /giphy\.webp$/);
  assert.equal(item.full.width, 480);
  assert.equal(item.full.height, 270);
  assert.equal(item.user, 'Some One');
  assert.equal(res.nextOffset, 2);
  assert.equal(res.total, 100);
});

test('results are cached and concurrent identical requests share one call', async () => {
  let clock = 1_000_000;
  const fake = fakeGiphyFetch({ delayMs: 20 });
  const giphy = createGiphyClient({ apiKey: KEY, fetch: fake.fetch, searchTtlMs: 60_000, now: () => clock });

  await Promise.all([giphy.search('dogs'), giphy.search('DOGS'), giphy.search('dogs ')]);
  assert.equal(fake.calls.length, 1, 'in-flight requests are merged (and case-insensitive)');

  await giphy.search('dogs');
  assert.equal(fake.calls.length, 1, 'served from cache');

  await giphy.search('dogs', 24);
  assert.equal(fake.calls.length, 2, 'different page is a different cache entry');

  clock += 61_000;
  await giphy.search('dogs');
  assert.equal(fake.calls.length, 3, 'cache entry expired');

  await giphy.trending();
  await giphy.trending();
  assert.equal(fake.calls.length, 4);
});

test('errors are mapped to friendly codes and not cached', async () => {
  for (const [status, code] of [
    [429, 'giphy_rate_limited'],
    [403, 'giphy_bad_key'],
    [500, 'giphy_error'],
  ]) {
    const fake = fakeGiphyFetch({ status });
    const giphy = createGiphyClient({ apiKey: KEY, fetch: fake.fetch });
    await assert.rejects(giphy.search('x'), (err) => err.code === code && !err.message.includes(KEY));
    await assert.rejects(giphy.search('x'));
    assert.equal(fake.calls.length, 2, 'failures are retried, not cached');
  }

  const giphy = createGiphyClient({
    apiKey: KEY,
    fetch: async () => {
      throw new TypeError(`fetch failed for https://api.giphy.com/?api_key=${KEY}`);
    },
  });
  await assert.rejects(giphy.trending(), (err) => err.code === 'giphy_unreachable' && !err.message.includes(KEY));
});

test('empty queries are rejected without calling GIPHY', async () => {
  const fake = fakeGiphyFetch();
  const giphy = createGiphyClient({ apiKey: KEY, fetch: fake.fetch });
  await assert.rejects(giphy.search('   '), { code: 'bad_query' });
  assert.equal(fake.calls.length, 0);
});

test('offsets are clamped to what GIPHY accepts', async () => {
  const fake = fakeGiphyFetch();
  const giphy = createGiphyClient({ apiKey: KEY, fetch: fake.fetch });
  await giphy.search('x', 999999);
  await giphy.search('y', -5);
  assert.equal(fake.calls[0].searchParams.get('offset'), '4999');
  assert.equal(fake.calls[1].searchParams.get('offset'), '0');
});

test('normalizeGif drops items with non-GIPHY or missing media URLs', () => {
  assert.equal(normalizeGif(null), null);
  assert.equal(normalizeGif({ id: 'x' }), null);
  const evil = makeGif('evil');
  evil.images.original.url = 'https://evil.example.com/x.gif';
  evil.images.original.webp = 'https://evil.example.com/x.webp';
  evil.images.fixed_width_downsampled.url = 'https://evil.example.com/y.gif';
  evil.images.fixed_width_downsampled.webp = undefined;
  assert.equal(normalizeGif(evil), null);
});

test('normalizeGif prefers a smaller rendition when the original is huge', () => {
  const gif = makeGif('big');
  gif.images.original.size = String(40 * 1024 * 1024);
  gif.images.original.webp_size = String(30 * 1024 * 1024);
  gif.images.downsized_large = {
    url: 'https://media1.giphy.com/media/big/giphy-downsized-large.gif',
    width: '400',
    height: '225',
    size: String(7 * 1024 * 1024),
  };
  const item = normalizeGif(gif);
  assert.match(item.full.url, /downsized-large/);
  assert.equal(item.full.width, 480, 'keeps original aspect info');
});

test('normalizeResponse computes the next page offset', () => {
  assert.equal(normalizeResponse({ data: [], pagination: { total_count: 0, count: 0, offset: 0 } }, 0).nextOffset, null);
  assert.equal(
    normalizeResponse({ data: [makeGif('a')], pagination: { total_count: 25, count: 24, offset: 0 } }, 0).nextOffset,
    24,
  );
  assert.equal(
    normalizeResponse({ data: [makeGif('a')], pagination: { total_count: 48, count: 24, offset: 24 } }, 24).nextOffset,
    null,
  );
  assert.equal(
    normalizeResponse({ data: [makeGif('a')], pagination: { total_count: 99999, count: 24, offset: 4990 } }, 4990).nextOffset,
    null,
    'never past GIPHY max offset',
  );
});

test('relay proxies GIF search and trending over the WebSocket', async () => {
  const fake = fakeGiphyFetch();
  const server = await startTestServer({ giphyApiKey: KEY, giphyOptions: { fetch: fake.fetch } });
  const a = await connect(server.port);
  try {
    a.send({ type: 'gif-search', reqId: 'early', query: 'cats' });
    assert.equal((await a.next('error')).code, 'not_joined', 'must be in a room to use the key');
    assert.equal(fake.calls.length, 0);

    const welcome = await a.join('gifroom', 'A');
    assert.equal(welcome.features.giphy, true);

    a.send({ type: 'gif-search', reqId: 's1', query: 'party parrot', offset: 0 });
    const res = await a.next('gif-results');
    assert.equal(res.reqId, 's1');
    assert.equal(res.mode, 'search');
    assert.equal(res.query, 'party parrot');
    assert.equal(res.items.length, 2);
    assert.equal(res.nextOffset, 2);
    assert.ok(!JSON.stringify(res).includes(KEY), 'API key never reaches clients');

    a.send({ type: 'gif-trending', reqId: 't1' });
    const trending = await a.next('gif-results');
    assert.equal(trending.mode, 'trending');
    assert.equal(trending.reqId, 't1');

    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
    assert.equal(health.giphy, true);
    assert.ok(!JSON.stringify(health).includes(KEY));
  } finally {
    a.ws.terminate();
    await server.close();
  }
});

test('relay rate limits GIF searches per person and relays GIPHY errors', async () => {
  const fake = fakeGiphyFetch({ status: 429 });
  const server = await startTestServer({
    giphyApiKey: KEY,
    giphyOptions: { fetch: fake.fetch },
    limits: { searchesPerWindow: 2, searchWindowMs: 60_000 },
  });
  const a = await connect(server.port);
  try {
    await a.join('limits', 'A');
    a.send({ type: 'gif-search', reqId: 1, query: 'a' });
    const first = await a.next('error');
    assert.equal(first.code, 'giphy_rate_limited');
    assert.equal(first.reqId, 1);
    a.send({ type: 'gif-search', reqId: 2, query: 'b' });
    await a.next('error');
    a.send({ type: 'gif-search', reqId: 3, query: 'c' });
    const limited = await a.next('error');
    assert.equal(limited.code, 'rate_limited');
    assert.equal(limited.reqId, 3);
    assert.equal(fake.calls.length, 2);
  } finally {
    a.ws.terminate();
    await server.close();
  }
});
