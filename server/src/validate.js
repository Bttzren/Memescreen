'use strict';

/**
 * Input validation helpers. Everything a client sends is untrusted, even from
 * friends, so the relay normalises and clamps every field before forwarding.
 */

const POSITIONS = Object.freeze(['random', 'center', 'fullscreen']);

const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Strip ASCII control characters and Unicode bidi/zero-width tricks.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Room codes are case-insensitive: "Pizza-Gang" and "PIZZA-GANG" are the same room. */
function normalizeRoom(value) {
  if (typeof value !== 'string') return null;
  const room = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(room)) return null;
  return room;
}

function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const nick = value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (nick.length < 1 || nick.length > 24) return null;
  return nick;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // Line breaks and tabs become spaces first, so "hi\nthere" keeps its gap.
  return value.replace(/[\t\n\r]+/g, ' ').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizePosition(value) {
  return POSITIONS.includes(value) ? value : 'random';
}

/**
 * Identify an image by its magic bytes rather than trusting a filename or a
 * client-declared MIME type. Returns the MIME type or null if unsupported.
 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  const head6 = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  // WebP: "RIFF" <size> "WEBP"
  const riff = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  const webp = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return null;
}

const ALLOWED_VIDEO_MIMES = Object.freeze(['video/mp4', 'video/webm']);
const ALLOWED_AUDIO_MIMES = Object.freeze(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4']);
const AUDIO_ONLY_MP4_BRANDS = new Set(['M4A ', 'M4B ', 'F4A ', 'F4B ']);

/** Built-in sound effects (synthesised by the app — no audio files involved). */
const BUILTIN_SOUNDS = Object.freeze([
  'airhorn',
  'boing',
  'ding',
  'drumroll',
  'sad-trombone',
  'whoosh',
  'tada',
  'siren',
  'toot',
  'pop',
]);

/** How a drop arrives on screen. */
const EFFECTS = Object.freeze(['pop', 'slide', 'bounce', 'shake', 'spin', 'zoom', 'none']);
/** Colors for text drops (names, so senders can't inject CSS). */
const TEXT_COLORS = Object.freeze(['white', 'yellow', 'pink', 'cyan', 'lime', 'orange']);
/** Quick reactions friends can send back after a drop. */
const REACTIONS = Object.freeze(['😂', '🔥', '💀', '😭', '❤️', '👍', '😮', '🤡']);
const MAX_CAPTION_LENGTH = 80;
const MAX_TEXT_LENGTH = 140;

function normalizeEffect(value) {
  return EFFECTS.includes(value) ? value : 'pop';
}

function normalizeTextColor(value) {
  return TEXT_COLORS.includes(value) ? value : 'white';
}

/** Meme captions: { top, bottom } with at least one filled in, or null. */
function normalizeCaption(value) {
  if (!value || typeof value !== 'object') return null;
  const top = cleanText(value.top, MAX_CAPTION_LENGTH);
  const bottom = cleanText(value.bottom, MAX_CAPTION_LENGTH);
  return top || bottom ? { top, bottom } : null;
}

/**
 * Identify any supported media by magic bytes: images (see above), MP4/MOV and
 * WebM video, and MP3/WAV/OGG/M4A audio. Returns a MIME type or null.
 */
function sniffMediaMime(buf) {
  const image = sniffImageMime(buf);
  if (image) return image;
  if (!buf || buf.length < 12) return null;
  const ascii = (from, to) => String.fromCharCode(...buf.subarray(from, to));
  // ISO base media (MP4, MOV, M4A): "....ftyp<brand>"
  if (ascii(4, 8) === 'ftyp') {
    return AUDIO_ONLY_MP4_BRANDS.has(ascii(8, 12)) ? 'audio/mp4' : 'video/mp4';
  }
  // Matroska / WebM: EBML header
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  // MP3: ID3 tag, or an MPEG audio frame sync (11 set bits)
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

function mediaKind(mime) {
  if (ALLOWED_IMAGE_MIMES.includes(mime)) return 'image';
  if (ALLOWED_VIDEO_MIMES.includes(mime)) return 'video';
  if (ALLOWED_AUDIO_MIMES.includes(mime)) return 'audio';
  return null;
}

/**
 * GIF drops carry a URL that the *recipient's* client loads, so only allow
 * GIPHY's own HTTPS hosts. This stops a "friend" from making everyone's
 * client fetch an arbitrary URL (e.g. an IP-logging tracker).
 */
function isGiphyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host === 'giphy.com' || host.endsWith('.giphy.com');
}

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Sound' };
const KIND_FORMATS = {
  image: 'Only PNG, JPG, GIF and WebP images are supported.',
  video: 'Only MP4 and WebM videos are supported.',
  audio: 'Only MP3, WAV, OGG and M4A sounds are supported.',
};

/**
 * Decode base64 media and validate it against the expected kind
 * ('image' | 'video' | 'audio'). Returns { mime, kind, base64, bytes, width?, height? }
 * or { error } with a user-friendly message.
 */
function decodeMedia(base64, { kind, maxBytes }) {
  const label = KIND_LABEL[kind] || 'File';
  if (typeof base64 !== 'string' || base64.length === 0) {
    return { error: `No ${label.toLowerCase()} data was sent.` };
  }
  // Cheap pre-check before allocating: base64 is ~4/3 the size of the bytes.
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    return { error: `${label} is too big (max ${formatBytes(maxBytes)}).` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { error: `${label} data is not valid base64.` };
  }
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return { error: `${label} is empty.` };
  if (buf.length > maxBytes) return { error: `${label} is too big (max ${formatBytes(maxBytes)}).` };
  const mime = sniffMediaMime(buf);
  if (!mime || mediaKind(mime) !== kind) return { error: KIND_FORMATS[kind] || 'Unsupported file.' };
  if (kind !== 'image') return { mime, kind, base64: buf.toString('base64'), bytes: buf.length };
  return checkImage(buf, mime);
}

/** Decode base64 image data (PNG/JPEG/GIF/WebP) and validate it. */
function decodeImage(base64, maxBytes) {
  return decodeMedia(base64, { kind: 'image', maxBytes });
}

function checkImage(buf, mime) {
  // A tiny file can still decode to billions of pixels ("decompression bomb")
  // and freeze everyone's screen, so check the declared dimensions too.
  const dims = imageDimensions(buf, mime);
  if (!dims) return { error: "Couldn't read that image's size — is the file damaged?" };
  if (dims.width > MAX_IMAGE_SIDE || dims.height > MAX_IMAGE_SIDE || dims.width * dims.height > MAX_IMAGE_PIXELS) {
    return { error: `That image is ${dims.width}×${dims.height} pixels, which is too large to show.` };
  }
  return { mime, kind: 'image', base64: buf.toString('base64'), bytes: buf.length, width: dims.width, height: dims.height };
}

const MAX_IMAGE_SIDE = 16384;
const MAX_IMAGE_PIXELS = 64 * 1000 * 1000; // fits 48 MP phone photos

/** Read width/height from the image header without decoding it. Returns null if unparseable. */
function imageDimensions(buf, mime) {
  try {
    if (mime === 'image/png') {
      if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return dims(buf.readUInt32BE(16), buf.readUInt32BE(20));
    }
    if (mime === 'image/gif') {
      return dims(buf.readUInt16LE(6), buf.readUInt16LE(8));
    }
    if (mime === 'image/webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return dims(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
      }
      if (chunk === 'VP8L') {
        if (buf[20] !== 0x2f) return null;
        const bits = buf.readUInt32LE(21);
        return dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === 'VP8 ') {
        // Frame tag (3 bytes) + start code 9d 01 2a, then 14-bit width/height.
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
        return dims(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        let marker = buf[i + 1];
        while (marker === 0xff && i + 2 < buf.length) {
          i += 1; // fill bytes
          marker = buf[i + 1];
        }
        i += 2;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
        if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before a frame header
        const len = buf.readUInt16BE(i);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return dims(buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3));
        i += len;
      }
      return null;
    }
  } catch {
    return null; // header shorter than it claims
  }
  return null;
}

function dims(width, height) {
  return width > 0 && height > 0 ? { width, height } : null;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

module.exports = {
  POSITIONS,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  ALLOWED_AUDIO_MIMES,
  BUILTIN_SOUNDS,
  EFFECTS,
  TEXT_COLORS,
  REACTIONS,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
  normalizeEffect,
  normalizeTextColor,
  normalizeCaption,
  sniffMediaMime,
  mediaKind,
  decodeMedia,
  normalizeRoom,
  normalizeNickname,
  cleanText,
  clampNumber,
  normalizePosition,
  sniffImageMime,
  isGiphyUrl,
  decodeImage,
  imageDimensions,
  formatBytes,
};
