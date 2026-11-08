'use strict';

/**
 * Validation shared by the main process (and tests). The server checks all of
 * this too — the client checks first so friends get instant, friendly errors.
 */

const DEFAULT_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  minDurationMs: 1000,
  maxDurationMs: 15000,
  minOpacity: 0.1,
  maxOpacity: 1,
});

const POSITIONS = Object.freeze(['random', 'center', 'fullscreen']);

/** Identify PNG / JPEG / GIF / WebP from magic bytes. Returns a MIME type or null. */
function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  const head6 = ascii(0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Only GIPHY's own HTTPS hosts may be loaded as GIF drops. */
function isGiphyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host === 'giphy.com' || host.endsWith('.giphy.com');
}

/**
 * Turn whatever a friend typed into a WebSocket URL:
 *   "localhost:8787"           -> "ws://localhost:8787/"
 *   "http://1.2.3.4:8787"      -> "ws://1.2.3.4:8787/"
 *   "https://memes.example"    -> "wss://memes.example/"
 *   "wss://memes.example"      -> "wss://memes.example/"
 * Returns null if it can't be made sensible.
 */
function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^https:\/\//i.test(s)) s = `wss://${s.slice(8)}`;
  else if (/^http:\/\//i.test(s)) s = `ws://${s.slice(7)}`;
  else if (!/^wss?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // some other scheme
    s = `ws://${s}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.hostname) return null;
  url.hash = '';
  return url.toString();
}

function normalizeRoom(value) {
  if (typeof value !== 'string') return null;
  const room = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(room) ? room : null;
}

function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const nick = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return nick.length >= 1 && nick.length <= 24 ? nick : null;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp the sender's display options into the allowed ranges. */
function normalizeDropOptions(opts = {}, limits = DEFAULT_LIMITS) {
  return {
    opacity: Math.round(clamp(opts.opacity, limits.minOpacity, limits.maxOpacity, 1) * 100) / 100,
    durationMs: Math.round(clamp(opts.durationMs, limits.minDurationMs, limits.maxDurationMs, 4000)),
    position: POSITIONS.includes(opts.position) ? opts.position : 'random',
  };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

module.exports = {
  DEFAULT_LIMITS,
  POSITIONS,
  sniffImageMime,
  isGiphyUrl,
  normalizeServerUrl,
  normalizeRoom,
  normalizeNickname,
  normalizeDropOptions,
  formatBytes,
};
