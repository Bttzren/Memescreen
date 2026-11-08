'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  shell,
  Menu,
  powerMonitor,
  session,
} = require('electron');
const { Connection } = require('./connection');
const { OverlayManager } = require('./overlay');
const { createTray } = require('./tray');
const { createSettings } = require('./settings');
const V = require('../shared/validate');

const PANIC_HOTKEY = 'CommandOrControl+Shift+X';
const HOTKEY_LABEL = process.platform === 'darwin' ? 'Cmd+Shift+X' : 'Ctrl+Shift+X';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const START_HIDDEN = process.argv.includes('--hidden');
const CAN_START_WITH_OS = process.platform === 'win32' || process.platform === 'darwin';

// Optional: run a second copy on the same PC for testing (separate settings + lock).
if (process.env.MEMEDROP_USER_DATA) app.setPath('userData', path.resolve(process.env.MEMEDROP_USER_DATA));
// Escape hatch for GPUs that render transparent windows black.
if (process.env.MEMEDROP_NO_GPU === '1' || process.argv.includes('--no-gpu')) app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  let controlWin = null;
  let tray = null;
  let overlay = null;
  let settings = null;
  let quitting = false;
  let hotkeyOk = false;
  let trayHintShown = false;
  const connection = new Connection();

  if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.app');

  app.on('second-instance', () => showControlWindow());

  app.on('web-contents-created', (_event, contents) => {
    // No popups, no navigating away from our own pages.
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    settings = createSettings(app.getPath('userData'));
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    overlay = new OverlayManager();
    overlay.create(); // warm it up so the first meme appears instantly

    tray = createTray({
      hotkeyLabel: HOTKEY_LABEL,
      onOpen: () => showControlWindow(),
      onToggleMute: () => setMuted(!settings.get().muted),
      onToggleStartup: () => setStartWithOs(!getStartWithOs()),
      canStartWithOs: CAN_START_WITH_OS,
      onClear: () => overlay.clearAll(),
      onQuit: () => quit(),
    });

    hotkeyOk = globalShortcut.register(PANIC_HOTKEY, () => overlay.clearAll());
    if (!hotkeyOk) console.warn(`Could not register ${HOTKEY_LABEL} (another app may be using it).`);

    tray.update({ muted: settings.get().muted, hotkeyOk, startWithOs: getStartWithOs() });
    createControlWindow();
    registerIpc();

    connection.on('state', (state) => {
      tray.update({ status: state.status, room: state.room });
      sendToControl('state', uiState());
    });
    connection.on('drop', handleIncomingDrop);
    connection.on('server-error', (msg) => sendToControl('notice', { kind: 'error', text: msg.message }));

    powerMonitor.on('resume', () => connection.reconnectNow && connection.reconnectNow());

    const s = settings.get();
    if (s.autoConnect && V.normalizeRoom(s.room) && V.normalizeNickname(s.nickname)) {
      const url = V.normalizeServerUrl(s.serverUrl);
      if (url) connection.connect({ url, room: V.normalizeRoom(s.room), nickname: V.normalizeNickname(s.nickname) });
    }
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    connection.disconnect({ silent: true });
    if (settings) settings.flush();
  });

  // Keep running in the tray when the window is closed.
  app.on('window-all-closed', () => {});

  function quit() {
    quitting = true;
    app.quit();
  }

  function createControlWindow() {
    controlWin = new BrowserWindow({
      width: 460,
      height: 780,
      minWidth: 400,
      minHeight: 620,
      show: false,
      title: 'MemeDrop',
      icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      backgroundColor: '#15121f',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'control-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    controlWin.loadFile(path.join(__dirname, '..', 'renderer', 'control', 'index.html'));
    controlWin.once('ready-to-show', () => {
      if (!START_HIDDEN) controlWin.show();
    });
    controlWin.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      controlWin.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        tray.notify('MemeDrop is still running', 'Memes will keep showing up. Right-click the tray icon to mute or quit.');
      }
    });
    controlWin.on('closed', () => {
      controlWin = null;
    });
  }

  function showControlWindow() {
    if (!controlWin) createControlWindow();
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.show();
    controlWin.focus();
  }

  function sendToControl(channel, payload) {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, payload);
  }

  function uiState() {
    return {
      ...connection.state,
      muted: settings.get().muted,
      hotkey: { label: HOTKEY_LABEL, ok: hotkeyOk },
    };
  }

  function setMuted(muted) {
    settings.update({ muted: Boolean(muted) });
    if (muted) overlay.clearAll();
    tray.update({ muted: Boolean(muted) });
    sendToControl('state', uiState());
  }

  function handleIncomingDrop(msg) {
    const from = msg.from && typeof msg.from.nickname === 'string' ? msg.from.nickname : 'Someone';
    if (settings.get().muted) {
      sendToControl('incoming', { from, kind: msg.kind, muted: true, at: Date.now() });
      return;
    }
    const drop = toOverlayDrop(msg, connection.state.limits);
    if (!drop) return;
    overlay.show({ ...drop, from });
    sendToControl('incoming', { from, kind: msg.kind, muted: false, at: Date.now() });
  }

  function registerIpc() {
    ipcMain.handle('app:init', () => ({
      settings: settings.get(),
      state: uiState(),
      version: app.getVersion(),
    }));

    ipcMain.handle('conn:connect', (_e, input) => {
      const url = V.normalizeServerUrl(input && input.serverUrl);
      if (!url) return { ok: false, error: 'That server address looks wrong. Try something like ws://192.168.1.20:8787' };
      const room = V.normalizeRoom(input.room);
      if (!room) return { ok: false, error: 'Room codes are 1–32 letters, numbers, dashes or underscores.' };
      const nickname = V.normalizeNickname(input.nickname);
      if (!nickname) return { ok: false, error: 'Pick a nickname (1–24 characters).' };
      settings.update({ serverUrl: String(input.serverUrl).trim(), room, nickname, autoConnect: true });
      connection.connect({ url, room, nickname });
      return { ok: true };
    });

    ipcMain.handle('conn:disconnect', () => {
      settings.update({ autoConnect: false });
      connection.disconnect();
      return { ok: true };
    });

    ipcMain.handle('drop:send', async (_e, payload) => {
      try {
        const limits = connection.state.limits;
        const drop = buildOutgoingDrop(payload, limits);
        const to = payload && typeof payload.to === 'string' ? payload.to : 'all';
        const reply = await connection.request({ type: 'drop', to, ...drop });
        return { ok: true, delivered: reply.delivered };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('drop:preview', (_e, payload) => {
      try {
        const out = buildOutgoingDrop(payload, connection.state.limits);
        const drop = toOverlayDrop(
          { ...out, data: out.data, dropId: `preview-${crypto.randomBytes(4).toString('hex')}` },
          connection.state.limits,
        );
        if (!drop) return { ok: false, error: 'Could not preview that.' };
        overlay.show({ ...drop, from: 'Preview (only you can see this)', preview: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('gif:search', async (_e, { query, offset } = {}) => gifRequest({ type: 'gif-search', query, offset }));
    ipcMain.handle('gif:trending', async (_e, { offset } = {}) => gifRequest({ type: 'gif-trending', offset }));

    ipcMain.handle('prefs:update', (_e, patch = {}) => {
      const clean = V.normalizeDropOptions(patch, connection.state.limits);
      const allowed = {};
      if ('opacity' in patch) allowed.opacity = clean.opacity;
      if ('durationMs' in patch) allowed.durationMs = clean.durationMs;
      if ('position' in patch) allowed.position = clean.position;
      return settings.update(allowed);
    });

    ipcMain.handle('mute:set', (_e, muted) => {
      setMuted(Boolean(muted));
      return { ok: true };
    });

    ipcMain.handle('overlay:clear', () => {
      overlay.clearAll();
      return { ok: true };
    });

    ipcMain.handle('open-external', (_e, url) => {
      openExternalSafely(url);
      return { ok: true };
    });
  }

  async function gifRequest(message) {
    try {
      const res = await connection.request(message, { idField: 'reqId' });
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // "Start with Windows" launches hidden in the tray (--hidden).
  function getStartWithOs() {
    if (!CAN_START_WITH_OS) return false;
    try {
      return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
    } catch {
      return false;
    }
  }

  function setStartWithOs(enabled) {
    if (!CAN_START_WITH_OS) return;
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    tray.update({ startWithOs: getStartWithOs() });
  }
}

/** Validate what the control window wants to send and shape it for the wire. */
function buildOutgoingDrop(payload, limits) {
  if (!payload || typeof payload !== 'object') throw new Error('Nothing to send.');
  const opts = V.normalizeDropOptions(payload, limits);

  if (payload.kind === 'image') {
    const bytes = payload.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Pick an image first.');
    if (bytes.length > limits.maxImageBytes) {
      throw new Error(`That image is ${V.formatBytes(bytes.length)} — the limit is ${V.formatBytes(limits.maxImageBytes)}.`);
    }
    const mime = V.sniffImageMime(bytes);
    if (!mime) throw new Error('Only PNG, JPG, GIF and WebP images are supported.');
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    return { kind: 'image', mime, data, ...opts };
  }

  if (payload.kind === 'gif') {
    if (!V.isGiphyUrl(payload.url)) throw new Error('Only GIPHY GIFs can be sent from the GIF tab.');
    return {
      kind: 'gif',
      url: payload.url,
      width: Number(payload.width) || undefined,
      height: Number(payload.height) || undefined,
      title: typeof payload.title === 'string' ? payload.title.slice(0, 100) : '',
      ...opts,
    };
  }

  throw new Error('Pick an image or a GIF first.');
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Turn a drop from the wire into something safe for the overlay to render. */
function toOverlayDrop(msg, limits) {
  const opts = V.normalizeDropOptions(msg, limits);
  let src;
  if (msg.kind === 'image') {
    if (!IMAGE_MIMES.has(msg.mime) || typeof msg.data !== 'string' || !BASE64.test(msg.data)) return null;
    src = `data:${msg.mime};base64,${msg.data}`;
  } else if (msg.kind === 'gif') {
    if (!V.isGiphyUrl(msg.url)) return null; // never load arbitrary URLs from strangers
    src = msg.url;
  } else {
    return null;
  }
  return {
    id: String(msg.dropId || crypto.randomBytes(4).toString('hex')),
    kind: msg.kind,
    src,
    width: Number(msg.width) || undefined,
    height: Number(msg.height) || undefined,
    title: typeof msg.title === 'string' ? msg.title.slice(0, 100) : '',
    ...opts,
  };
}

function openExternalSafely(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === 'giphy.com' || host.endsWith('.giphy.com') || host === 'developers.giphy.com')) {
      shell.openExternal(u.toString());
    }
  } catch {
    /* ignore */
  }
}
