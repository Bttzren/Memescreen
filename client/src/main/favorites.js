'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const V = require('../shared/validate');

const MAX_ITEMS = 40;
const MAX_THUMB_BYTES = 200 * 1024;
const ID = /^[a-z0-9]{8,32}$/;

/**
 * "⭐ Saved" memes: files and GIPHY GIFs the user wants to drop again.
 *
 * Everything stays on this PC, in <userData>/favorites:
 *   index.json   the list (newest first)
 *   <id>.bin     a saved image or video, exactly as it was uploaded
 *   <id>.thumb   a small picture of it for the grid
 * GIPHY GIFs are saved as links only (GIPHY hosts the file).
 */
function createFavorites(dir, { limits = V.DEFAULT_LIMITS } = {}) {
  const indexFile = path.join(dir, 'index.json');
  let items = [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (Array.isArray(raw)) items = raw.filter(isValidEntry).slice(0, MAX_ITEMS);
  } catch {
    /* nothing saved yet */
  }

  function isValidEntry(e) {
    if (!e || typeof e !== 'object' || !ID.test(e.id)) return false;
    if (e.type === 'gif') return V.isGiphyUrl(e.url) && V.isGiphyUrl(e.previewUrl);
    return e.type === 'file' && (e.kind === 'image' || e.kind === 'video') && fs.existsSync(path.join(dir, `${e.id}.bin`));
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
    fs.renameSync(tmp, indexFile);
  }

  function readThumb(id) {
    try {
      return new Uint8Array(fs.readFileSync(path.join(dir, `${id}.thumb`)));
    } catch {
      return null;
    }
  }

  /** Everything saved, newest first. File entries carry their thumbnail bytes. */
  function list() {
    return items.map((e) => (e.type === 'file' ? { ...e, thumb: readThumb(e.id) } : { ...e }));
  }

  function full() {
    return items.length >= MAX_ITEMS ? { ok: false, error: `You can save up to ${MAX_ITEMS} favorites. Remove one to make room.` } : null;
  }

  function bump(id) {
    const i = items.findIndex((e) => e.id === id);
    if (i < 0) return false;
    items.unshift(items.splice(i, 1)[0]);
    save();
    return true;
  }

  function addFile({ bytes, name, thumb } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, error: 'Pick a file first.' };
    const mime = V.sniffMediaMime(bytes);
    const kind = V.mediaKind(mime);
    if (kind !== 'image' && kind !== 'video') return { ok: false, error: 'Only images and videos can be saved.' };
    const max = kind === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;
    if (bytes.length > max) return { ok: false, error: `That ${kind} is too big to save (${V.formatBytes(max)} max).` };

    const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    if (bump(id)) return { ok: true, id, already: true };
    const blocked = full();
    if (blocked) return blocked;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.bin`), bytes);
    if (thumb instanceof Uint8Array && thumb.length > 0 && thumb.length <= MAX_THUMB_BYTES && V.sniffImageMime(thumb)) {
      fs.writeFileSync(path.join(dir, `${id}.thumb`), thumb);
    }
    items.unshift({
      id,
      type: 'file',
      kind,
      mime,
      name: V.cleanText(typeof name === 'string' ? name : '', 80) || (kind === 'video' ? 'Video' : 'Image'),
      size: bytes.length,
      addedAt: Date.now(),
    });
    save();
    return { ok: true, id };
  }

  function addGif(gif = {}) {
    const fullUrl = gif.full && gif.full.url;
    const preview = gif.preview || {};
    if (!V.isGiphyUrl(fullUrl) || !V.isGiphyUrl(preview.url)) return { ok: false, error: 'Only GIPHY GIFs can be saved.' };
    const id = `g${crypto.createHash('sha256').update(fullUrl).digest('hex').slice(0, 15)}`;
    if (bump(id)) return { ok: true, id, already: true };
    const blocked = full();
    if (blocked) return blocked;
    items.unshift({
      id,
      type: 'gif',
      url: fullUrl,
      width: Number(gif.full.width) || undefined,
      height: Number(gif.full.height) || undefined,
      previewUrl: preview.url,
      stillUrl: V.isGiphyUrl(preview.still) ? preview.still : undefined,
      title: V.cleanText(typeof gif.title === 'string' ? gif.title : '', 100) || 'GIF',
      addedAt: Date.now(),
    });
    save();
    return { ok: true, id };
  }

  function remove(id) {
    if (typeof id !== 'string' || !ID.test(id)) return { ok: false };
    const before = items.length;
    items = items.filter((e) => e.id !== id);
    for (const ext of ['bin', 'thumb']) {
      try {
        fs.unlinkSync(path.join(dir, `${id}.${ext}`));
      } catch {
        /* GIF favorites have no files */
      }
    }
    if (items.length !== before) save();
    return { ok: true };
  }

  /** The saved file's bytes, or null if it's gone. */
  function read(id) {
    if (typeof id !== 'string' || !ID.test(id) || !items.some((e) => e.id === id && e.type === 'file')) return null;
    try {
      return new Uint8Array(fs.readFileSync(path.join(dir, `${id}.bin`)));
    } catch {
      return null;
    }
  }

  return { list, addFile, addGif, remove, read };
}

module.exports = { createFavorites, MAX_ITEMS };
