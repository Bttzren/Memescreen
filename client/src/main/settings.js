'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  serverUrl: 'ws://localhost:8787',
  room: '',
  nickname: '',
  opacity: 1,
  durationMs: 4000,
  position: 'random',
  muted: false,
  autoConnect: false,
  displayId: 'main', // which screen memes appear on
});

/**
 * Tiny JSON settings store in the app's userData folder
 * (%APPDATA%\MemeDrop\settings.json on Windows).
 */
function createSettings(dir) {
  const file = path.join(dir, 'settings.json');
  let data = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (key in raw && typeof raw[key] === typeof DEFAULTS[key]) data[key] = raw[key];
      }
    }
  } catch {
    /* first run or unreadable — use defaults */
  }

  let saveTimer = null;
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
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
