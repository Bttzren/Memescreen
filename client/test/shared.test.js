'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/shared/validate');
const { computeLayout } = require('../src/shared/layout');

test('normalizeServerUrl accepts the ways friends will type an address', () => {
  assert.equal(V.normalizeServerUrl('localhost:8787'), 'ws://localhost:8787/');
  assert.equal(V.normalizeServerUrl('  192.168.1.20:8787 '), 'ws://192.168.1.20:8787/');
  assert.equal(V.normalizeServerUrl('http://1.2.3.4:8787'), 'ws://1.2.3.4:8787/');
  assert.equal(V.normalizeServerUrl('https://memes.example.com'), 'wss://memes.example.com/');
  assert.equal(V.normalizeServerUrl('wss://memes.example.com/relay'), 'wss://memes.example.com/relay');
  assert.equal(V.normalizeServerUrl('WS://Example.com:1234'), 'ws://example.com:1234/');
  assert.equal(V.normalizeServerUrl(''), null);
  assert.equal(V.normalizeServerUrl('ftp://example.com'), null);
  assert.equal(V.normalizeServerUrl('ws://'), null);
  assert.equal(V.normalizeServerUrl(undefined), null);
});

test('sniffImageMime identifies supported formats by content only', () => {
  const pad = (arr) => Uint8Array.from([...arr, ...new Array(16).fill(0)]);
  assert.equal(V.sniffImageMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(V.sniffImageMime(pad([0xff, 0xd8, 0xff, 0xe1])), 'image/jpeg');
  assert.equal(V.sniffImageMime(pad([...Buffer.from('GIF89a')])), 'image/gif');
  assert.equal(V.sniffImageMime(pad([...Buffer.from('GIF87a')])), 'image/gif');
  assert.equal(V.sniffImageMime(pad([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')])), 'image/webp');
  assert.equal(V.sniffImageMime(pad([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WAVE')])), null);
  assert.equal(V.sniffImageMime(pad([...Buffer.from('<svg ')])), null);
  assert.equal(V.sniffImageMime(new Uint8Array(3)), null);
});

test('isGiphyUrl only allows https GIPHY hosts', () => {
  assert.ok(V.isGiphyUrl('https://media0.giphy.com/media/x/giphy.gif'));
  assert.ok(V.isGiphyUrl('https://i.giphy.com/x.webp'));
  assert.ok(!V.isGiphyUrl('http://media0.giphy.com/media/x/giphy.gif'));
  assert.ok(!V.isGiphyUrl('https://notgiphy.com/x.gif'));
  assert.ok(!V.isGiphyUrl('https://giphy.com.evil.net/x.gif'));
  assert.ok(!V.isGiphyUrl('file:///C:/Windows/win.ini'));
  assert.ok(!V.isGiphyUrl('data:image/gif;base64,R0lGOD'));
});

test('room codes and nicknames are normalised', () => {
  assert.equal(V.normalizeRoom(' pizza-gang '), 'PIZZA-GANG');
  assert.equal(V.normalizeRoom('has space'), null);
  assert.equal(V.normalizeNickname('  Big   Sam  '), 'Big Sam');
  assert.equal(V.normalizeNickname('a\u0007b'), 'ab');
  assert.equal(V.normalizeNickname(''), null);
});

test('normalizeDropOptions clamps into the allowed ranges', () => {
  assert.deepEqual(V.normalizeDropOptions({ opacity: 0.333, durationMs: 4200.4, position: 'center', effect: 'spin' }), {
    opacity: 0.33,
    durationMs: 4200,
    position: 'center',
    effect: 'spin',
  });
  assert.deepEqual(V.normalizeDropOptions({ opacity: 0, durationMs: 99999, position: 'nope', effect: 'explode' }), {
    opacity: 0.1,
    durationMs: 15000,
    position: 'random',
    effect: 'pop',
  });
  assert.deepEqual(V.normalizeDropOptions({}), { opacity: 1, durationMs: 4000, position: 'random', effect: 'pop' });
});

test('captions, text colors and reactions are validated the same way as the relay', () => {
  assert.deepEqual(V.normalizeCaption({ top: ' hi\nthere ', bottom: '' }), { top: 'hi there', bottom: '' });
  assert.equal(V.normalizeCaption({ top: ' ', bottom: '' }), null);
  assert.equal(V.normalizeCaption('nope'), null);
  assert.equal(V.normalizeTextColor('yellow'), 'yellow');
  assert.equal(V.normalizeTextColor('red; background:url(x)'), 'white');
  assert.ok(V.REACTIONS.includes('😂'));
  assert.equal(V.cleanText('a'.repeat(300), V.MAX_TEXT_LENGTH).length, 140);
});

const VIEW = { viewW: 1920, viewH: 1080 };
const within = (box) =>
  box.left >= 0 && box.top >= 0 && box.left + box.width <= VIEW.viewW && box.top + box.height <= VIEW.viewH;

test('fullscreen layout fills the screen while keeping the whole image', () => {
  const wide = computeLayout({ position: 'fullscreen', imgW: 400, imgH: 100, ...VIEW });
  assert.equal(wide.width, 1920);
  assert.equal(wide.height, 480);
  assert.equal(wide.top, 300);
  const tall = computeLayout({ position: 'fullscreen', imgW: 500, imgH: 1000, ...VIEW });
  assert.equal(tall.height, 1080);
  assert.equal(tall.width, 540);
  assert.equal(tall.left, 690);
});

test('center layout is centred and at most 60% of the screen', () => {
  const box = computeLayout({ position: 'center', imgW: 4000, imgH: 3000, ...VIEW });
  assert.ok(box.width <= 1920 * 0.6 + 1 && box.height <= 1080 * 0.6 + 1);
  assert.equal(box.left, Math.round((1920 - box.width) / 2));
  assert.equal(box.top, Math.round((1080 - box.height) / 2));
  const tiny = computeLayout({ position: 'center', imgW: 32, imgH: 32, ...VIEW });
  assert.equal(tiny.width, 80, 'small images are only upscaled 2.5x');
});

test('random layout always stays on screen', () => {
  for (const r of [0, 0.5, 0.999]) {
    for (const [imgW, imgH] of [
      [100, 100],
      [3000, 200],
      [200, 3000],
      [1920, 1080],
    ]) {
      const box = computeLayout({ position: 'random', imgW, imgH, ...VIEW, random: () => r });
      assert.ok(within(box), `off screen: ${JSON.stringify({ r, imgW, imgH, box })}`);
      assert.ok(Math.abs(box.rotation) <= 6);
    }
  }
});

test('layout survives missing image dimensions', () => {
  const box = computeLayout({ position: 'center', imgW: 0, imgH: undefined, ...VIEW });
  assert.ok(box.width > 0 && box.height > 0);
});
