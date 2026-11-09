'use strict';

const { TtlCache } = require('./cache');
const { isGiphyUrl, cleanText } = require('./validate');

/**
 * GIPHY proxy. The API key only ever lives here on the server; clients ask the
 * relay for results over their WebSocket and get back a slimmed-down list of
 * GIPHY media URLs that their app then loads directly from GIPHY's CDN.
 *
 * Results are cached briefly (and concurrent identical requests are merged) to
 * stay well under GIPHY's rate limits — beta keys only get ~100 calls/hour.
 */

const GIPHY_MAX_OFFSET = 4999; // GIPHY rejects offsets above this.
const MAX_FULL_BYTES = 12 * 1024 * 1024; // prefer renditions under ~12 MB for overlays

class GiphyError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GiphyError';
    this.code = code;
    this.status = status;
  }
}

function createGiphyClient({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.giphy.com/v1/gifs',
  rating = 'pg-13',
  lang = 'en',
  pageSize = 24,
  searchTtlMs = 5 * 60 * 1000,
  trendingTtlMs = 10 * 60 * 1000,
  timeoutMs = 8000,
  maxCacheEntries = 500,
  now = Date.now,
} = {}) {
  if (!apiKey) throw new Error('createGiphyClient requires an apiKey');
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available (Node 18+ required)');

  const cache = new TtlCache({ maxEntries: maxCacheEntries, now });
  const stats = { upstreamCalls: 0, cacheHits: 0 };

  async function callGiphy(endpoint, params) {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${endpoint}`);
    const query = new URLSearchParams({
      api_key: apiKey,
      limit: String(pageSize),
      rating,
      ...params,
    });
    url.search = query.toString();

    stats.upstreamCalls += 1;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Never include `url` in errors or logs: it contains the API key.
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new GiphyError(
        'giphy_unreachable',
        timedOut ? 'GIPHY took too long to answer. Try again.' : 'Could not reach GIPHY right now.',
      );
    }

    if (res.status === 429) {
      throw new GiphyError('giphy_rate_limited', 'GIF search is resting (GIPHY rate limit hit). Try again in a few minutes.', 429);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GiphyError('giphy_bad_key', "The server's GIPHY API key was rejected. Ask whoever runs the server to check it.", res.status);
    }
    if (!res.ok) {
      throw new GiphyError('giphy_error', `GIPHY returned an error (${res.status}).`, res.status);
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new GiphyError('giphy_error', 'GIPHY sent back something unreadable.');
    }
    return normalizeResponse(body, Number(params.offset) || 0);
  }

  function lookup(key, ttlMs, producer) {
    if (cache.get(key) !== undefined) stats.cacheHits += 1;
    return cache.wrap(key, ttlMs, producer);
  }

  return {
    stats,
    cache,

    /** Search GIFs. `query` is trimmed/limited; `offset` is clamped. */
    search(query, offset = 0) {
      const q = cleanText(query, 50);
      if (!q) return Promise.reject(new GiphyError('bad_query', 'Type something to search for.'));
      const off = clampOffset(offset);
      const key = `search|${rating}|${lang}|${q.toLowerCase()}|${off}`;
      return lookup(key, searchTtlMs, () => callGiphy('search', { q, offset: String(off), lang }));
    },

    /** What's trending on GIPHY right now. */
    trending(offset = 0) {
      const off = clampOffset(offset);
      const key = `trending|${rating}|${off}`;
      return lookup(key, trendingTtlMs, () => callGiphy('trending', { offset: String(off) }));
    },
  };
}

function clampOffset(offset) {
  const n = Math.floor(Number(offset));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, GIPHY_MAX_OFFSET);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rendition(r, { preferWebp = true } = {}) {
  if (!r) return null;
  const url = (preferWebp && r.webp) || r.url;
  if (!isGiphyUrl(url)) return null;
  return {
    url,
    width: toInt(r.width),
    height: toInt(r.height),
    size: toInt(preferWebp && r.webp ? r.webp_size : r.size),
  };
}

/** Pick a small, animated rendition for the thumbnail grid. */
function pickPreview(images) {
  return (
    rendition(images.fixed_width_downsampled) ||
    rendition(images.fixed_width) ||
    rendition(images.fixed_width_small) ||
    rendition(images.preview_gif, { preferWebp: false }) ||
    rendition(images.downsized, { preferWebp: false })
  );
}

/** Pick the best-quality rendition that isn't enormous for the overlay. */
function pickFull(images) {
  const candidates = [
    rendition(images.original),
    rendition(images.original, { preferWebp: false }),
    rendition(images.downsized_large, { preferWebp: false }),
    rendition(images.downsized_medium, { preferWebp: false }),
    rendition(images.downsized, { preferWebp: false }),
    rendition(images.fixed_width),
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  const fits = candidates.find((c) => c.size === undefined || c.size <= MAX_FULL_BYTES);
  return fits || candidates[candidates.length - 1];
}

function normalizeGif(gif) {
  if (!gif || typeof gif !== 'object' || !gif.images) return null;
  const preview = pickPreview(gif.images);
  const full = pickFull(gif.images);
  if (!preview || !full) return null;
  const original = gif.images.original || {};
  const user = gif.user && (gif.user.display_name || gif.user.username);
  // A still frame lets the app stop animating the grid while you're not looking.
  const still = rendition(gif.images.fixed_width_still, { preferWebp: false });
  return {
    id: String(gif.id || ''),
    title: cleanText(gif.title || '', 100) || 'GIF',
    preview: { url: preview.url, width: preview.width, height: preview.height, ...(still ? { still: still.url } : {}) },
    full: {
      url: full.url,
      width: toInt(original.width) || full.width,
      height: toInt(original.height) || full.height,
    },
    user: user ? cleanText(user, 50) : null,
  };
}

function normalizeResponse(body, requestedOffset) {
  const data = Array.isArray(body && body.data) ? body.data : [];
  const items = data.map(normalizeGif).filter(Boolean);
  const p = (body && body.pagination) || {};
  const count = Number(p.count) || data.length;
  const offset = Number.isFinite(Number(p.offset)) ? Number(p.offset) : requestedOffset;
  const total = Number(p.total_count);
  let nextOffset = offset + count;
  const hasMore =
    count > 0 && nextOffset <= GIPHY_MAX_OFFSET && (!Number.isFinite(total) || nextOffset < total);
  if (!hasMore) nextOffset = null;
  return { items, nextOffset, total: Number.isFinite(total) ? total : null };
}

module.exports = { createGiphyClient, GiphyError, normalizeGif, normalizeResponse };
