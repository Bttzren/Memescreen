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
  return value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
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

/**
 * Decode base64 image data and validate it. Returns { mime, base64, bytes } or
 * { error } with a user-friendly message.
 */
function decodeImage(base64, maxBytes) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return { error: 'No image data was sent.' };
  }
  // Cheap pre-check before allocating: base64 is ~4/3 the size of the bytes.
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    return { error: `Image is too big (max ${formatBytes(maxBytes)}).` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { error: 'Image data is not valid base64.' };
  }
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return { error: 'Image is empty.' };
  if (buf.length > maxBytes) return { error: `Image is too big (max ${formatBytes(maxBytes)}).` };
  const mime = sniffImageMime(buf);
  if (!mime) return { error: 'Only PNG, JPG, GIF and WebP images are supported.' };
  return { mime, base64: buf.toString('base64'), bytes: buf.length };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

module.exports = {
  POSITIONS,
  ALLOWED_IMAGE_MIMES,
  normalizeRoom,
  normalizeNickname,
  cleanText,
  clampNumber,
  normalizePosition,
  sniffImageMime,
  isGiphyUrl,
  decodeImage,
  formatBytes,
};
