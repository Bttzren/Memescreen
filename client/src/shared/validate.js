'use strict';

/**
 * Validation for the main process (and tests). File-type sniffing and the
 * GIPHY URL check come straight from the relay's own code (synced from
 * server/src), so the app and the server always agree.
 */

const relay = require('../relay/validate');

const DEFAULT_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxVideoBytes: 20 * 1024 * 1024,
  maxSoundBytes: 3 * 1024 * 1024,
  maxClipMs: 60_000,
  minDurationMs: 1000,
  maxDurationMs: 15000,
  minOpacity: 0.1,
  maxOpacity: 1,
});

const POSITIONS = relay.POSITIONS;

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

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Clamp the sender's display options into the allowed ranges. A durationMs of
 * 0 means "play the whole clip" and is only kept when `allowFullClip` is set.
 */
function normalizeDropOptions(opts = {}, limits = DEFAULT_LIMITS, { allowFullClip = false } = {}) {
  const fullClip = allowFullClip && Number(opts.durationMs) === 0;
  return {
    opacity: Math.round(clamp(opts.opacity, limits.minOpacity, limits.maxOpacity, 1) * 100) / 100,
    durationMs: fullClip ? 0 : Math.round(clamp(opts.durationMs, limits.minDurationMs, limits.maxDurationMs, 4000)),
    position: POSITIONS.includes(opts.position) ? opts.position : 'random',
    effect: relay.normalizeEffect(opts.effect),
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
  BUILTIN_SOUNDS: relay.BUILTIN_SOUNDS,
  EFFECTS: relay.EFFECTS,
  TEXT_COLORS: relay.TEXT_COLORS,
  REACTIONS: relay.REACTIONS,
  MAX_TEXT_LENGTH: relay.MAX_TEXT_LENGTH,
  MAX_RAIN_LENGTH: relay.MAX_RAIN_LENGTH,
  canRain: relay.canRain,
  cleanText: relay.cleanText,
  normalizeCaption: relay.normalizeCaption,
  normalizeTextColor: relay.normalizeTextColor,
  normalizeEffect: relay.normalizeEffect,
  sniffImageMime: relay.sniffImageMime,
  sniffMediaMime: relay.sniffMediaMime,
  mediaKind: relay.mediaKind,
  isGiphyUrl: relay.isGiphyUrl,
  normalizeRoom: relay.normalizeRoom,
  normalizeNickname: relay.normalizeNickname,
  normalizeServerUrl,
  normalizeDropOptions,
  formatBytes,
};
