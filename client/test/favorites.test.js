'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFavorites, MAX_ITEMS } = require('../src/main/favorites');

const FIX = path.join(__dirname, '..', '..', 'server', 'test', 'fixtures');
const png = new Uint8Array(fs.readFileSync(path.join(FIX, 'tiny.png')));
const mp4 = new Uint8Array(fs.readFileSync(path.join(FIX, 'tiny.mp4')));
const mp3 = new Uint8Array(fs.readFileSync(path.join(FIX, 'tiny.mp3')));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-fav-'));
const gif = (id) => ({
  title: `GIF ${id}`,
  full: { url: `https://media.giphy.com/media/${id}/giphy.gif`, width: 480, height: 270 },
  preview: { url: `https://media.giphy.com/media/${id}/200w.webp`, still: `https://media.giphy.com/media/${id}/200w_s.gif` },
});

test('saves images, videos and GIPHY GIFs and remembers them', () => {
  const dir = tmp();
  const fav = createFavorites(dir);
  assert.deepEqual(fav.list(), []);

  const a = fav.addFile({ bytes: png, name: '  my\nmeme.png ', thumb: png });
  assert.equal(a.ok, true);
  const b = fav.addFile({ bytes: mp4, name: 'clip.mp4' });
  assert.equal(b.ok, true);
  const c = fav.addGif(gif('abc'));
  assert.equal(c.ok, true);

  const list = fav.list();
  assert.deepEqual(list.map((e) => e.type), ['gif', 'file', 'file'], 'newest first');
  assert.equal(list[2].name, 'my meme.png');
  assert.equal(list[2].kind, 'image');
  assert.deepEqual([...list[2].thumb], [...png]);
  assert.equal(list[1].kind, 'video');
  assert.equal(list[1].thumb, null);
  assert.equal(list[0].stillUrl, 'https://media.giphy.com/media/abc/200w_s.gif');
  assert.deepEqual([...fav.read(a.id)], [...png]);
  assert.equal(fav.read(c.id), null, 'GIF favorites are links, not files');

  // A second app start reads the same list back.
  const again = createFavorites(dir);
  assert.deepEqual(again.list().map((e) => e.id), list.map((e) => e.id));
});

test('saving the same thing twice just moves it to the front', () => {
  const fav = createFavorites(tmp());
  const first = fav.addFile({ bytes: png, name: 'a.png' });
  fav.addGif(gif('one'));
  const dup = fav.addFile({ bytes: png, name: 'renamed.png' });
  assert.equal(dup.already, true);
  assert.equal(dup.id, first.id);
  assert.deepEqual(fav.list().map((e) => e.type), ['file', 'gif']);
  assert.equal(fav.addGif(gif('one')).already, true);
  assert.equal(fav.list().length, 2);
});

test('refuses things that are not memes, and odd ids', () => {
  const dir = tmp();
  const fav = createFavorites(dir);
  assert.equal(fav.addFile({ bytes: mp3, name: 'song.mp3' }).ok, false);
  assert.equal(fav.addFile({ bytes: new Uint8Array([1, 2, 3]) }).ok, false);
  assert.equal(fav.addFile({}).ok, false);
  assert.equal(fav.addFile({ bytes: png }, { }).ok, true);
  assert.equal(createFavorites(tmp(), { limits: { maxImageBytes: 10, maxVideoBytes: 10 } }).addFile({ bytes: png }).ok, false);
  assert.equal(fav.addGif({ full: { url: 'https://evil.example/x.gif' }, preview: { url: 'https://media.giphy.com/x' } }).ok, false);
  assert.equal(fav.addGif({ full: { url: 'https://media.giphy.com/x.gif' }, preview: { url: 'javascript:alert(1)' } }).ok, false);
  assert.equal(fav.read('../../etc/passwd'), null);
  assert.equal(fav.remove('../index').ok, false);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')), 'path tricks did not delete the index');
  // An oversized or non-image thumbnail is simply left out.
  const big = createFavorites(tmp());
  const r = big.addFile({ bytes: png, thumb: new Uint8Array(300 * 1024) });
  assert.equal(r.ok, true);
  assert.equal(big.list()[0].thumb, null);
});

test('removing deletes the files, and there is a cap', () => {
  const dir = tmp();
  const fav = createFavorites(dir);
  const a = fav.addFile({ bytes: png, thumb: png });
  assert.ok(fs.existsSync(path.join(dir, `${a.id}.bin`)));
  fav.remove(a.id);
  assert.ok(!fs.existsSync(path.join(dir, `${a.id}.bin`)));
  assert.ok(!fs.existsSync(path.join(dir, `${a.id}.thumb`)));
  assert.deepEqual(fav.list(), []);

  for (let i = 0; i < MAX_ITEMS; i++) assert.equal(fav.addGif(gif(`g${i}`)).ok, true);
  const over = fav.addGif(gif('one-too-many'));
  assert.equal(over.ok, false);
  assert.match(over.error, /up to 40/);
  assert.equal(fav.addGif(gif('g3')).already, true, 'existing ones can still be bumped when full');
});

test('a saved file that vanished from disk is dropped from the list on next start', () => {
  const dir = tmp();
  const fav = createFavorites(dir);
  const a = fav.addFile({ bytes: png });
  fav.addGif(gif('keep'));
  fs.unlinkSync(path.join(dir, `${a.id}.bin`));
  assert.equal(fav.read(a.id), null);
  assert.deepEqual(createFavorites(dir).list().map((e) => e.type), ['gif']);
});
