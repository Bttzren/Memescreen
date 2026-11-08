'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/validate');
const { fixture } = require('./helpers');

test('imageDimensions reads real headers for every supported format', () => {
  const cases = [
    ['tiny.png', 'image/png', 37, 23],
    ['tiny.jpg', 'image/jpeg', 41, 19],
    ['tiny-progressive.jpg', 'image/jpeg', 41, 19],
    ['tiny.gif', 'image/gif', 13, 7],
    ['tiny-anim.gif', 'image/gif', 12, 9],
    ['tiny-lossy.webp', 'image/webp', 33, 17],
    ['tiny-lossless.webp', 'image/webp', 29, 11],
    ['tiny-alpha.webp', 'image/webp', 31, 15],
  ];
  for (const [file, mime, width, height] of cases) {
    const buf = fixture(file);
    assert.equal(V.sniffImageMime(buf), mime, file);
    assert.deepEqual(V.imageDimensions(buf, mime), { width, height }, file);
  }
});

test('decodeImage refuses decompression bombs and unreadable headers', () => {
  // A valid-looking PNG header that claims 20000×20000 pixels.
  const bomb = Buffer.from(fixture('tiny.png'));
  bomb.writeUInt32BE(20000, 16);
  bomb.writeUInt32BE(20000, 20);
  const res = V.decodeImage(bomb.toString('base64'), 5 * 1024 * 1024);
  assert.match(res.error, /20000×20000 pixels/);

  // 9000×8000 = 72 MP: each side is fine but the total is too much.
  const wide = Buffer.from(fixture('tiny.gif'));
  wide.writeUInt16LE(9000, 6);
  wide.writeUInt16LE(8000, 8);
  assert.match(V.decodeImage(wide.toString('base64'), 5 * 1024 * 1024).error, /too large/);

  // Correct magic bytes but garbage after them.
  const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.match(V.decodeImage(junk.toString('base64'), 1024).error, /size/);

  const ok = V.decodeImage(fixture('tiny.jpg').toString('base64'), 1024 * 1024);
  assert.equal(ok.error, undefined);
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal(ok.width, 41);
});

test('room codes, nicknames and text are normalised', () => {
  assert.equal(V.normalizeRoom(' pizza-gang '), 'PIZZA-GANG');
  assert.equal(V.normalizeRoom('a'.repeat(33)), null);
  assert.equal(V.normalizeRoom('emoji🍕'), null);
  assert.equal(V.normalizeNickname('  Big \n  Sam '), 'Big Sam');
  assert.equal(V.normalizeNickname('‮evil'), 'evil', 'strips bidi overrides');
  assert.equal(V.cleanText('a'.repeat(200), 10), 'aaaaaaaaaa');
  assert.equal(V.cleanText(42, 10), '');
});

test('sniffMediaMime recognises video and audio by content', () => {
  const cases = {
    'tiny.mp4': 'video/mp4',
    'tiny.webm': 'video/webm',
    'tiny.mp3': 'audio/mpeg',
    'tiny-noid3.mp3': 'audio/mpeg',
    'tiny.wav': 'audio/wav',
    'tiny.ogg': 'audio/ogg',
    'tiny.m4a': 'audio/mp4',
    'tiny.png': 'image/png',
  };
  for (const [file, mime] of Object.entries(cases)) {
    assert.equal(V.sniffMediaMime(fixture(file)), mime, file);
  }
  assert.equal(V.sniffMediaMime(Buffer.from('<html><body>hi</body></html>')), null);
});

test('decodeMedia only accepts the expected kind', () => {
  const MB = 1024 * 1024;
  const video = V.decodeMedia(fixture('tiny.mp4').toString('base64'), { kind: 'video', maxBytes: MB });
  assert.equal(video.mime, 'video/mp4');
  assert.equal(video.kind, 'video');

  const audio = V.decodeMedia(fixture('tiny.ogg').toString('base64'), { kind: 'audio', maxBytes: MB });
  assert.equal(audio.mime, 'audio/ogg');

  assert.match(V.decodeMedia(fixture('tiny.mp4').toString('base64'), { kind: 'image', maxBytes: MB }).error, /images/);
  assert.match(V.decodeMedia(fixture('tiny.png').toString('base64'), { kind: 'audio', maxBytes: MB }).error, /MP3/);
  assert.match(V.decodeMedia(fixture('tiny.mp3').toString('base64'), { kind: 'video', maxBytes: MB }).error, /MP4/);
  assert.match(V.decodeMedia(fixture('tiny.mp4').toString('base64'), { kind: 'video', maxBytes: 100 }).error, /Video is too big/);
});

test('built-in sound list is stable and unique', () => {
  assert.ok(V.BUILTIN_SOUNDS.length >= 8);
  assert.equal(new Set(V.BUILTIN_SOUNDS).size, V.BUILTIN_SOUNDS.length);
  assert.ok(V.BUILTIN_SOUNDS.includes('airhorn'));
});
