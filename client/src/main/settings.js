'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  // Connection
  serverUrl: 'ws://localhost:8787', // "Advanced" join only
  room: '',
  nickname: '',
  role: '', // 'host' | 'join' — what to resume on next launch
  inviteLink: '', // last invite link used/created
  autoConnect: false,
  hostMode: 'internet', // 'internet' | 'lan'
  hostRoom: '',
  // Sending
  opacity: 1,
  durationMs: 4000,
  position: 'random',
  videoSound: true,
  // Receiving
  muted: false,
  soundsEnabled: true,
  soundVolume: 0.8,
  displayId: 'main', // which screen memes appear on
  // App
  theme: 'bubblegum',
  panicHotkey: 'CommandOrControl+Shift+X',
  giphyKey: '', // stored encrypted when the OS supports it
});

const SECRET_KEYS = new Set(['giphyKey']);

/**
 * Tiny JSON settings store in the app's userData folder
 * (%APPDATA%\MemeDrop\settings.json on Windows).
 *
 * `secure` = { encrypt(string) → string, decrypt(string) → string } protects
 * secrets (the GIPHY key) at rest; without it they're stored as-is.
 */
function createSettings(dir, secure = null) {
  const file = path.join(dir, 'settings.json');
  let data = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in raw) || typeof raw[key] !== typeof DEFAULTS[key]) continue;
        data[key] = SECRET_KEYS.has(key) ? reveal(raw[key]) : raw[key];
      }
    }
  } catch {
    /* first run or unreadable — use defaults */
  }

  function reveal(value) {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
    try {
      return secure ? secure.decrypt(value.slice(4)) : '';
    } catch {
      return ''; // e.g. settings copied from another PC
    }
  }

  function hide(value) {
    if (!value || !secure) return value;
    try {
      return `enc:${secure.encrypt(value)}`;
    } catch {
      return value;
    }
  }

  let saveTimer = null;
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const out = { ...data };
      for (const key of SECRET_KEYS) out[key] = hide(out[key]);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('Could not save settings:', err.message);
    }
  }

  return {
    get: () => ({ ...data }),
    update(patch) {
      for (const [key, value] of Object.entries(patch || {})) {
        if (key in DEFAULTS && typeof value === typeof DEFAULTS[key]) data[key] = value;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 300);
      return { ...data };
    },
    flush,
  };
}

module.exports = { createSettings, DEFAULTS };
