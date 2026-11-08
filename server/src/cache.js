'use strict';

/**
 * A tiny in-memory TTL cache with a size cap and in-flight de-duplication.
 * If five friends open the GIF tab at once, GIPHY only gets one request.
 */
class TtlCache {
  constructor({ maxEntries = 500, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map(); // key -> { value, expiresAt }
    this.inflight = new Map(); // key -> Promise
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    // Re-insert so Map order tracks recency of writes; evict the oldest first.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /**
   * Return the cached value for `key`, or run `producer()` once (sharing the
   * promise with concurrent callers) and cache its result for `ttlMs`.
   * Failures are not cached.
   */
  async wrap(key, ttlMs, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Token bucket: allows bursts of up to `limit` actions, refilling at
 * `limit` tokens per `windowMs`.
 */
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  let tokens = limit;
  let last = now();
  const refillPerMs = limit / windowMs;
  return {
    take() {
      const t = now();
      tokens = Math.min(limit, tokens + (t - last) * refillPerMs);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}

module.exports = { TtlCache, createRateLimiter };
