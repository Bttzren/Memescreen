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
  screen,
  session,
  clipboard,
  safeStorage,
  net,
} = require('electron');
const { Connection } = require('./connection');
const { OverlayManager } = require('./overlay');
const { createFavorites } = require('./favorites');
const { createTray } = require('./tray');
const { createSettings } = require('./settings');
const { HostManager } = require('./host');
const { Tunnel } = require('./tunnel');
const { startServer } = require('../relay/server');
const V = require('../shared/validate');
const { parseInvite, buildInviteLink, randomRoomName } = require('../shared/invite');
const Hotkey = require('../shared/hotkey');

const THEMES = ['bubblegum', 'ocean', 'lime', 'sunset', 'mono', 'light'];
const PROTOCOL = 'memedrop';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const START_HIDDEN = process.argv.includes('--hidden');
const CAN_START_WITH_OS = process.platform === 'win32' || process.platform === 'darwin';
// Dev/test hooks (not needed by normal users).
const GIPHY_BASE_URL = process.env.MEMEDROP_GIPHY_BASE_URL || '';
const TUNNEL_BIN = process.env.MEMEDROP_TUNNEL_BIN || '';

// Optional: run a second copy on the same PC for testing (separate settings + lock).
if (process.env.MEMEDROP_USER_DATA) app.setPath('userData', path.resolve(process.env.MEMEDROP_USER_DATA));
// Escape hatch for GPUs that render transparent windows black.
if (process.env.MEMEDROP_NO_GPU === '1' || process.argv.includes('--no-gpu')) app.disableHardwareAcceleration();
// Less background work: no media-key hooks or media session (MemeDrop never
// needs them) and no spare renderer process kept warm "just in case".
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService,SpareRendererForSitePerProcess');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function findDeepLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`)) || null;
}

function run() {
  let controlWin = null;
  let tray = null;
  let overlay = null;
  let settings = null;
  let host = null;
  let quitting = false;
  let ready = false;
  let role = null; // 'host' | 'join' | null
  let hotkey = { accelerator: Hotkey.DEFAULT_HOTKEY, ok: false };
  let trayHintShown = false;
  let favorites = null;
  let hotkeyPaused = false; // true while Settings is recording a new panic key
  // What friends sent recently (the 📥 inbox). Lives here so it survives the
  // window being closed (which frees the window's memory).
  const recentIncoming = [];
  let unreadIncoming = 0;
  let pendingInvite = findDeepLink(process.argv);
  const connection = new Connection();

  if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.app');

  // Clicking a memedrop:// invite opens (or focuses) MemeDrop and joins.
  if (!process.env.MEMEDROP_USER_DATA && (app.isPackaged || process.platform === 'win32')) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  }

  app.on('second-instance', (_event, argv) => {
    showControlWindow();
    const link = findDeepLink(argv);
    if (link) handleInvite(link);
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleInvite(url);
  });

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
    settings = createSettings(app.getPath('userData'), secureStorage());
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    favorites = createFavorites(path.join(app.getPath('userData'), 'favorites'));
    overlay = new OverlayManager({ displayId: settings.get().displayId });
    overlay.create(); // warm it up so the first meme appears instantly

    const tunnel = new Tunnel({
      dir: path.join(app.getPath('userData'), 'bin'),
      fetch: (url, opts) => net.fetch(url, opts),
      binary: TUNNEL_BIN || undefined,
    });
    host = new HostManager({
      tunnel,
      startServer: (opts) =>
        startServer({ ...opts, giphyOptions: GIPHY_BASE_URL ? { baseUrl: GIPHY_BASE_URL } : {}, log: hostLog }),
      log: (msg) => console.log(`[host] ${msg}`),
    });
    host.on('state', () => {
      tray.update({ hosting: role === 'host' && host.state.status === 'on' });
      sendState();
    });

    tray = createTray({
      onOpen: () => showControlWindow(),
      onToggleMute: () => setMuted(!settings.get().muted),
      onToggleSounds: () => updateSettings({ soundsEnabled: !settings.get().soundsEnabled }),
      onToggleStartup: () => setStartWithOs(!getStartWithOs()),
      onPickDisplay: (displayId) => pickDisplay(displayId),
      getDisplays: listDisplays,
      canStartWithOs: CAN_START_WITH_OS,
      onClear: () => overlay.clearAll(),
      onQuit: () => quit(),
    });

    const saved = settings.get().panicHotkey;
    hotkey = { accelerator: Hotkey.isPlausibleAccelerator(saved) ? saved : Hotkey.DEFAULT_HOTKEY, ok: false };
    hotkey.ok = registerPanic(hotkey.accelerator);
    if (!hotkey.ok) console.warn(`Could not register ${hotkeyLabel()} (another app may be using it).`);

    tray.update({
      muted: settings.get().muted,
      soundsEnabled: settings.get().soundsEnabled,
      hotkeyOk: hotkey.ok,
      hotkeyLabel: hotkeyLabel(),
      startWithOs: getStartWithOs(),
      displayId: settings.get().displayId,
    });
    // Keep the "Show memes on" list current when monitors come and go.
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, () => {
        tray.update({});
        sendState();
      });
    }
    // Started with Windows: stay in the tray without loading the window at all.
    if (!START_HIDDEN) createControlWindow();
    registerIpc();

    connection.on('state', (state) => {
      tray.update({ status: state.status, room: state.room });
      sendState();
    });
    connection.on('drop', handleIncomingDrop);
    connection.on('reaction', handleReaction);
    connection.on('server-error', (msg) => sendToControl('notice', { kind: 'error', text: msg.message }));

    powerMonitor.on('resume', () => connection.reconnectNow());

    ready = true;
    const s = settings.get();
    if (pendingInvite) {
      const link = pendingInvite;
      pendingInvite = null;
      handleInvite(link);
    } else if (s.role === 'join' && s.autoConnect) {
      const url = V.normalizeServerUrl(s.serverUrl);
      const room = V.normalizeRoom(s.room);
      const nickname = V.normalizeNickname(s.nickname);
      if (url && room && nickname) joinRoom({ serverUrl: url, room, nickname, link: s.inviteLink });
    }
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    connection.disconnect({ silent: true });
    if (host) host.teardown(); // also stops the tunnel helper process
    if (settings) settings.flush();
  });

  // Keep running in the tray when the window is closed.
  app.on('window-all-closed', () => {});

  function quit() {
    quitting = true;
    app.quit();
  }

  function hostLog(level, message) {
    if (level === 'debug') return;
    console.log(`[room] ${message}`);
  }

  function secureStorage() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
    } catch {
      return null;
    }
    return {
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    };
  }

  // ------------------------------------------------------------------ windows

  function createControlWindow() {
    controlWin = new BrowserWindow({
      width: 480,
      height: 820,
      minWidth: 420,
      minHeight: 660,
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
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    controlOutbox = [];
    controlWin.webContents.on('did-finish-load', () => {
      const queued = controlOutbox.splice(0);
      for (const [channel, payload] of queued) sendToControl(channel, payload);
      sendState();
    });
    controlWin.loadFile(path.join(__dirname, '..', 'renderer', 'control', 'index.html'));
    controlWin.once('ready-to-show', () => {
      if (controlWin) controlWin.show();
    });
    controlWin.on('close', () => {
      if (quitting) return;
      // The window really closes (freeing ~100 MB); MemeDrop keeps running in
      // the tray and opens a fresh window when needed.
      if (!trayHintShown) {
        trayHintShown = true;
        tray.notify('MemeDrop is still running', 'Memes will keep showing up. Right-click the tray icon to mute or quit.');
      }
    });
    controlWin.on('closed', () => {
      controlWin = null;
      resumeHotkey(); // in case the window was closed while picking a new panic key
    });
  }

  function showControlWindow() {
    if (!controlWin) {
      createControlWindow(); // shows itself once loaded
      return;
    }
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.show();
    controlWin.focus();
  }

  // Messages for a window that is still loading wait until it's ready
  // (e.g. an invite link that opened a fresh window).
  let controlOutbox = [];

  function sendToControl(channel, payload) {
    if (!controlWin || controlWin.isDestroyed()) return;
    if (controlWin.webContents.isLoading()) {
      if (channel !== 'state') controlOutbox.push([channel, payload]);
      return;
    }
    controlWin.webContents.send(channel, payload);
  }

  // -------------------------------------------------------------------- state

  function hotkeyLabel(accel = hotkey.accelerator) {
    return Hotkey.acceleratorLabel(accel, process.platform);
  }

  /** The link anyone in the room can share to invite more friends. */
  function currentInviteLink() {
    if (role === 'host') return host.state.inviteLink;
    const { url, room } = connection.state;
    if (!url || !room) return null;
    const saved = settings.get().inviteLink;
    if (saved) {
      const parsed = parseInvite(saved);
      if (parsed && parsed.room === room && parsed.serverUrl === url) return saved;
    }
    const httpBase = url.replace(/^ws/i, 'http').replace(/\/+$/, '');
    return buildInviteLink(httpBase, room);
  }

  function publicSettings() {
    const s = settings.get();
    const { giphyKey, ...rest } = s;
    return { ...rest, hasGiphyKey: Boolean(giphyKey) };
  }

  function uiState() {
    const s = settings.get();
    return {
      ...connection.state,
      role,
      host: host ? host.state : null,
      inviteLink: currentInviteLink(),
      muted: s.muted,
      soundsEnabled: s.soundsEnabled,
      soundVolume: s.soundVolume,
      mutedFriends: mutedFriends(),
      displays: listDisplays(),
      displayId: s.displayId,
      canStartWithOs: CAN_START_WITH_OS,
      startWithOs: getStartWithOs(),
      theme: s.theme,
      hasGiphyKey: Boolean(s.giphyKey),
      hotkey: { accelerator: hotkey.accelerator, label: hotkeyLabel(), ok: hotkey.ok },
    };
  }

  function sendState() {
    if (ready) sendToControl('state', uiState());
  }

  function setMuted(muted) {
    settings.update({ muted: Boolean(muted) });
    if (muted) overlay.clearAll();
    tray.update({ muted: Boolean(muted) });
    sendState();
  }

  function updateSettings(patch = {}) {
    const clean = {};
    if (THEMES.includes(patch.theme)) clean.theme = patch.theme;
    if ('soundsEnabled' in patch) clean.soundsEnabled = Boolean(patch.soundsEnabled);
    if ('soundVolume' in patch) clean.soundVolume = clamp01(patch.soundVolume, settings.get().soundVolume);
    if ('videoSound' in patch) clean.videoSound = Boolean(patch.videoSound);
    const opts = V.normalizeDropOptions(patch, connection.state.limits);
    if ('opacity' in patch) clean.opacity = opts.opacity;
    if ('durationMs' in patch) clean.durationMs = opts.durationMs;
    if ('position' in patch) clean.position = opts.position;
    if ('effect' in patch) clean.effect = opts.effect;
    if ('textColor' in patch) clean.textColor = V.normalizeTextColor(patch.textColor);
    settings.update(clean);
    if ('soundsEnabled' in clean) tray.update({ soundsEnabled: clean.soundsEnabled });
    sendState();
    return publicSettings();
  }

  // ------------------------------------------------------------ rooms/invites

  function handleInvite(link) {
    const invite = parseInvite(link);
    if (!invite) {
      if (ready) sendToControl('notice', { kind: 'error', text: "That invite link doesn't look right." });
      return;
    }
    if (!ready) {
      pendingInvite = link;
      return;
    }
    showControlWindow();
    const nickname = V.normalizeNickname(settings.get().nickname);
    const busy = role === 'host' || connection.state.status !== 'disconnected';
    if (nickname && !busy) {
      joinRoom({ nickname, serverUrl: invite.serverUrl, room: invite.room, link: invite.link || link });
    } else {
      // Let them pick a nickname (or confirm leaving their current room) first.
      sendToControl('invite', { link: invite.link || link, room: invite.room });
    }
  }

  async function joinRoom({ nickname, serverUrl, room, link }) {
    if (host.state.status !== 'off') await host.stop();
    role = 'join';
    settings.update({ nickname, role: 'join', serverUrl, room, inviteLink: link || '', autoConnect: true });
    connection.connect({ url: serverUrl, room, nickname });
  }

  async function leaveRoom() {
    role = null;
    settings.update({ autoConnect: false });
    connection.disconnect();
    if (host.state.status !== 'off') await host.stop();
    sendState();
  }

  async function startHosting({ nickname, room, mode }) {
    connection.disconnect({ silent: true });
    role = 'host';
    settings.update({ nickname, hostRoom: room, hostMode: mode, role: 'host', autoConnect: false });
    sendState();
    try {
      const { localUrl, inviteLink } = await host.start({ room, mode, giphyKey: settings.get().giphyKey });
      settings.update({ inviteLink });
      connection.connect({ url: localUrl, room, nickname });
      return { ok: true, inviteLink };
    } catch (err) {
      if (err.message === 'cancelled') return { ok: false, cancelled: true };
      return { ok: false, error: err.message };
    }
  }

  // ------------------------------------------------------------------ hotkey

  function panic() {
    overlay.clearAll();
  }

  function registerPanic(accel) {
    if (!Hotkey.isPlausibleAccelerator(accel)) return false;
    try {
      return globalShortcut.register(accel, panic);
    } catch {
      return false;
    }
  }

  function changeHotkey(accel) {
    if (!Hotkey.isPlausibleAccelerator(accel)) return { ok: false, error: "That shortcut can't be used. Try something like Ctrl+Shift+X." };
    hotkeyPaused = false; // whatever happens below, the key ends up registered (or reported as taken)
    if (accel === hotkey.accelerator && hotkey.ok) return { ok: true };
    const old = hotkey.accelerator;
    if (hotkey.ok) globalShortcut.unregister(old);
    if (registerPanic(accel)) {
      hotkey = { accelerator: accel, ok: true };
      settings.update({ panicHotkey: accel });
      tray.update({ hotkeyOk: true, hotkeyLabel: hotkeyLabel() });
      sendState();
      return { ok: true };
    }
    hotkey.ok = registerPanic(old);
    sendState();
    return { ok: false, error: `${hotkeyLabel(accel)} is already used by Windows or another app. Try a different one.` };
  }

  // ------------------------------------------------------------------- drops

  function mutedFriends() {
    const list = settings.get().mutedFriends;
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
  }

  function isFriendMuted(nickname) {
    return mutedFriends().includes(String(nickname).toLowerCase());
  }

  function setFriendMuted(nickname, muted) {
    const name = V.normalizeNickname(nickname);
    if (!name) return { ok: false };
    const key = name.toLowerCase();
    const rest = mutedFriends().filter((n) => n !== key);
    settings.update({ mutedFriends: muted ? [...rest, key].slice(-100) : rest });
    sendState();
    return { ok: true };
  }

  function senderOf(msg) {
    const from = msg.from || {};
    return {
      name: typeof from.nickname === 'string' ? from.nickname : 'Someone',
      id: typeof from.id === 'string' ? from.id : null,
    };
  }

  function handleIncomingDrop(msg) {
    const sender = senderOf(msg);
    if (isFriendMuted(sender.name)) return; // you asked not to see this person's drops
    const s = settings.get();
    const notice = {
      key: crypto.randomBytes(6).toString('hex'),
      from: sender.name,
      fromId: sender.id,
      dropId: typeof msg.dropId === 'string' ? msg.dropId : null,
      kind: msg.kind,
      text: msg.kind === 'text' ? V.cleanText(msg.text, V.MAX_TEXT_LENGTH) : '',
      muted: s.muted,
      at: Date.now(),
      reacted: null,
    };
    recentIncoming.unshift(notice);
    recentIncoming.length = Math.min(recentIncoming.length, 20);
    unreadIncoming += 1;
    if (s.muted) {
      sendToControl('incoming', notice);
      return;
    }
    const drop = toOverlayDrop(msg, connection.state.limits);
    if (!drop) return;
    overlay.show({ ...drop, from: sender.name, volume: s.soundsEnabled ? s.soundVolume : 0 });
    sendToControl('incoming', notice);
  }

  function handleReaction(msg) {
    if (!V.REACTIONS.includes(msg.emoji)) return;
    const sender = senderOf(msg);
    if (isFriendMuted(sender.name)) return;
    if (!settings.get().muted) {
      overlay.show({ id: `r-${crypto.randomBytes(4).toString('hex')}`, kind: 'reaction', emoji: msg.emoji, from: sender.name });
    }
    sendToControl('reaction', { from: sender.name, emoji: msg.emoji });
  }

  async function checkGiphyKey(key) {
    const base = GIPHY_BASE_URL || 'https://api.giphy.com/v1/gifs';
    try {
      const res = await net.fetch(`${base}/trending?api_key=${encodeURIComponent(key)}&limit=1`, {
        signal: AbortSignal.timeout(7000),
      });
      if (res.status === 401 || res.status === 403) return 'invalid';
      if (res.ok || res.status === 429) return 'valid';
      return 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  // --------------------------------------------------------------------- IPC

  function registerIpc() {
    ipcMain.handle('app:init', () => ({
      settings: publicSettings(),
      state: uiState(),
      version: app.getVersion(),
      platform: process.platform,
      suggestedRoom: settings.get().hostRoom || randomRoomName(),
      themes: THEMES,
      inbox: recentIncoming,
      unread: unreadIncoming,
    }));

    ipcMain.handle('inbox:seen', () => {
      unreadIncoming = 0;
      return { ok: true };
    });

    ipcMain.handle('room:host', (_e, input = {}) => {
      const nickname = V.normalizeNickname(input.nickname);
      if (!nickname) return { ok: false, error: 'Pick a nickname (1–24 characters).' };
      const room = V.normalizeRoom(input.room);
      if (!room) return { ok: false, error: 'Room names are 1–32 letters, numbers, dashes or underscores.' };
      const mode = input.mode === 'lan' ? 'lan' : 'internet';
      return startHosting({ nickname, room, mode });
    });

    ipcMain.handle('room:restart', () => {
      const s = settings.get();
      return startHosting({ nickname: s.nickname, room: s.hostRoom, mode: s.hostMode });
    });

    ipcMain.handle('room:join', async (_e, input = {}) => {
      const nickname = V.normalizeNickname(input.nickname);
      if (!nickname) return { ok: false, error: 'Pick a nickname (1–24 characters).' };
      let target;
      if (input.invite) {
        target = parseInvite(input.invite);
        if (!target) return { ok: false, error: 'Paste the whole invite link your friend sent (it ends in /join/ROOM-NAME).' };
      } else {
        const serverUrl = V.normalizeServerUrl(input.serverUrl);
        if (!serverUrl) return { ok: false, error: 'That server address looks wrong. Try something like ws://192.168.1.20:8787' };
        const room = V.normalizeRoom(input.room);
        if (!room) return { ok: false, error: 'Room codes are 1–32 letters, numbers, dashes or underscores.' };
        target = { serverUrl, room, link: null };
      }
      await joinRoom({ nickname, serverUrl: target.serverUrl, room: target.room, link: target.link });
      return { ok: true };
    });

    ipcMain.handle('room:leave', async () => {
      await leaveRoom();
      return { ok: true };
    });

    ipcMain.handle('drop:send', async (_e, payload) => {
      try {
        const drop = buildOutgoingDrop(payload, connection.state.limits);
        const to = normalizeTarget(payload && payload.to);
        const reply = await connection.request({ type: 'drop', to, ...drop });
        return { ok: true, delivered: reply.delivered };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('drop:preview', (_e, payload) => {
      try {
        const out = buildOutgoingDrop(payload, connection.state.limits);
        const drop = toOverlayDrop({ ...out, dropId: `preview-${crypto.randomBytes(4).toString('hex')}` }, connection.state.limits);
        if (!drop) return { ok: false, error: 'Could not preview that.' };
        const s = settings.get();
        overlay.show({ ...drop, from: 'Preview (only you can see this)', preview: true, volume: s.soundsEnabled ? s.soundVolume : 0 });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('drop:react', (_e, { to, emoji, dropId } = {}) => {
      if (!V.REACTIONS.includes(emoji) || typeof to !== 'string') return { ok: false, error: 'Unknown reaction.' };
      const sent = connection.send({ type: 'react', to, emoji, dropId: typeof dropId === 'string' ? dropId : undefined });
      if (!sent) return { ok: false, error: "You're not connected right now." };
      const entry = recentIncoming.find((n) => n.dropId && n.dropId === dropId);
      if (entry) entry.reacted = emoji;
      return { ok: true };
    });

    ipcMain.handle('friend:mute', (_e, { nickname, muted } = {}) => setFriendMuted(nickname, Boolean(muted)));

    ipcMain.handle('gif:search', async (_e, { query, offset } = {}) => gifRequest({ type: 'gif-search', query, offset }));
    ipcMain.handle('gif:trending', async (_e, { offset } = {}) => gifRequest({ type: 'gif-trending', offset }));

    ipcMain.handle('settings:update', (_e, patch) => updateSettings(patch || {}));

    ipcMain.handle('mute:set', (_e, muted) => {
      setMuted(Boolean(muted));
      return { ok: true };
    });

    ipcMain.handle('overlay:clear', () => {
      overlay.clearAll();
      return { ok: true };
    });

    ipcMain.handle('hotkey:set', (_e, accel) => changeHotkey(String(accel || '')));
    ipcMain.handle('hotkey:reset', () => changeHotkey(Hotkey.DEFAULT_HOTKEY));
    // While the settings screen is recording a new shortcut, the old one must
    // not fire (otherwise pressing it again would never reach the recorder).
    ipcMain.handle('hotkey:pause', (_e, paused) => {
      if (paused && hotkey.ok) {
        globalShortcut.unregister(hotkey.accelerator);
        hotkey.ok = false;
        hotkeyPaused = true;
      } else if (!paused) {
        resumeHotkey();
      }
      return { ok: true };
    });

    ipcMain.handle('display:set', (_e, displayId) => {
      const id = String(displayId || 'main');
      pickDisplay(id === 'main' || listDisplays().some((d) => d.id === id) ? id : 'main');
      return { ok: true };
    });

    ipcMain.handle('startup:set', (_e, enabled) => {
      setStartWithOs(Boolean(enabled));
      sendState();
      return { ok: true };
    });

    ipcMain.handle('fav:list', () => favorites.list());
    ipcMain.handle('fav:add-file', (_e, input) => guard(() => favorites.addFile(input || {})));
    ipcMain.handle('fav:add-gif', (_e, gif) => guard(() => favorites.addGif(gif || {})));
    ipcMain.handle('fav:remove', (_e, id) => guard(() => favorites.remove(id)));
    ipcMain.handle('fav:read', (_e, id) => favorites.read(id));

    ipcMain.handle('giphy:save', async (_e, rawKey) => {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (key && !/^[A-Za-z0-9]{16,64}$/.test(key)) {
        return { ok: false, error: "That doesn't look like a GIPHY API key. It's a long mix of letters and numbers." };
      }
      let warning = null;
      if (key) {
        const check = await checkGiphyKey(key);
        if (check === 'invalid') return { ok: false, error: 'GIPHY says that key is not valid. Check you copied all of it.' };
        if (check === 'unreachable') warning = "Saved. (GIPHY couldn't be reached to double-check the key.)";
      }
      settings.update({ giphyKey: key });
      settings.flush();
      host.setGiphyKey(key);
      sendState();
      return { ok: true, warning };
    });

    // (await: newer Electron versions make the clipboard API async)
    ipcMain.handle('clipboard:write', async (_e, text) => {
      if (typeof text === 'string' && text.length <= 2000) await clipboard.writeText(text);
      return { ok: true };
    });

    ipcMain.handle('clipboard:invite', async () => {
      const text = String((await clipboard.readText()) || '').slice(0, 2000);
      const invite = parseInvite(text);
      return invite ? { link: invite.link || text.trim(), room: invite.room } : null;
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
  function resumeHotkey() {
    if (!hotkeyPaused) return;
    hotkeyPaused = false;
    if (!hotkey.ok) hotkey.ok = registerPanic(hotkey.accelerator);
    sendState();
  }

  function pickDisplay(displayId) {
    settings.update({ displayId });
    overlay.setDisplay(displayId);
    tray.update({ displayId });
    sendState();
  }

  /** Disk trouble (full, read-only…) becomes a friendly message, not a crash. */
  function guard(fn) {
    try {
      return fn();
    } catch (err) {
      console.warn(`favorites: ${err.message}`);
      return { ok: false, error: "Couldn't save that. Is your disk full?" };
    }
  }

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

// ---------------------------------------------------------------- helpers

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** 'all', one friend's id, or a list of ids. */
function normalizeTarget(to) {
  if (to === 'all' || to === undefined) return 'all';
  if (typeof to === 'string') return to;
  if (Array.isArray(to)) {
    const ids = [...new Set(to.filter((id) => typeof id === 'string' && id.length <= 64))];
    return ids.length ? ids : 'all';
  }
  return 'all';
}

/** Screens for the tray's "Show memes on" menu, left to right. */
function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen
    .getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => ({
      id: String(d.id),
      label: `Screen ${i + 1} (${d.size.width}×${d.size.height})${d.id === primaryId ? ' · main' : ''}`,
    }));
}

function asBytes(value) {
  return value instanceof Uint8Array && value.length > 0 ? value : null;
}

function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

const KIND_FORMATS = {
  image: 'Only PNG, JPG, GIF and WebP images are supported.',
  video: 'Only MP4 and WebM videos are supported.',
  audio: 'Only MP3, WAV, OGG and M4A sounds are supported.',
};

function buildSound(sound, limits) {
  if (!sound) return null;
  if (sound.type === 'builtin') {
    if (!V.BUILTIN_SOUNDS.includes(sound.id)) throw new Error('Unknown sound.');
    return { type: 'builtin', id: sound.id };
  }
  if (sound.type === 'file') {
    const bytes = asBytes(sound.bytes);
    if (!bytes) throw new Error('Pick a sound file first.');
    if (bytes.length > limits.maxSoundBytes) {
      throw new Error(`That sound is ${V.formatBytes(bytes.length)}. The limit is ${V.formatBytes(limits.maxSoundBytes)}.`);
    }
    if (V.mediaKind(V.sniffMediaMime(bytes)) !== 'audio') throw new Error(KIND_FORMATS.audio);
    return { type: 'file', data: toBase64(bytes), name: typeof sound.name === 'string' ? sound.name.slice(0, 60) : '' };
  }
  throw new Error('Unknown sound.');
}

/** Validate what the control window wants to send and shape it for the wire. */
function buildOutgoingDrop(payload, limits) {
  if (!payload || typeof payload !== 'object') throw new Error('Nothing to send.');
  const kind = payload.kind;
  const opts = V.normalizeDropOptions(payload, limits, { allowFullClip: kind === 'video' || kind === 'sound' });
  const sound = buildSound(payload.sound, limits);

  const caption = V.normalizeCaption(payload.caption);

  if (kind === 'text') {
    const text = V.cleanText(payload.text, V.MAX_TEXT_LENGTH);
    if (!text) throw new Error('Type a message to drop.');
    const out = { kind: 'text', text, color: V.normalizeTextColor(payload.color), ...opts, sound };
    if (payload.rain === true && V.canRain(text)) out.rain = true;
    return out;
  }

  if (kind === 'image' || kind === 'video') {
    const bytes = asBytes(payload.bytes);
    if (!bytes) throw new Error('Pick a file first.');
    const max = kind === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;
    if (bytes.length > max) {
      throw new Error(`That ${kind} is ${V.formatBytes(bytes.length)}. The limit is ${V.formatBytes(max)}.`);
    }
    const mime = V.sniffMediaMime(bytes);
    if (V.mediaKind(mime) !== kind) throw new Error(KIND_FORMATS[kind]);
    const out = { kind, mime, data: toBase64(bytes), ...opts, sound };
    if (kind === 'video') out.videoSound = payload.videoSound !== false;
    if (caption) out.caption = caption;
    return out;
  }

  if (kind === 'gif') {
    if (!V.isGiphyUrl(payload.url)) throw new Error('Only GIPHY GIFs can be sent from the GIF tab.');
    return {
      kind: 'gif',
      url: payload.url,
      width: Number(payload.width) || undefined,
      height: Number(payload.height) || undefined,
      title: typeof payload.title === 'string' ? payload.title.slice(0, 100) : '',
      ...opts,
      sound,
      ...(caption ? { caption } : {}),
    };
  }

  if (kind === 'sound') {
    if (!sound) throw new Error('Pick a sound first.');
    return { kind: 'sound', durationMs: 0, sound };
  }

  throw new Error('Pick an image, video, GIF, sound or message first.');
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeMediaField(data, expectedKind) {
  if (typeof data !== 'string' || !BASE64.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  const mime = V.sniffMediaMime(bytes);
  if (V.mediaKind(mime) !== expectedKind) return null;
  return { bytes, mime };
}

/** Turn a drop from the wire into something safe for the overlay to render. */
function toOverlayDrop(msg, limits) {
  const kind = msg.kind;
  const opts = V.normalizeDropOptions(msg, limits, { allowFullClip: kind === 'video' || kind === 'sound' });
  const drop = {
    id: String(msg.dropId || crypto.randomBytes(4).toString('hex')),
    kind,
    width: Number(msg.width) || undefined,
    height: Number(msg.height) || undefined,
    title: typeof msg.title === 'string' ? msg.title.slice(0, 100) : '',
    maxClipMs: limits.maxClipMs || 60000,
    ...opts,
    caption: V.normalizeCaption(msg.caption),
    sound: null,
  };

  if (kind === 'image' || kind === 'video') {
    const media = decodeMediaField(msg.data, kind);
    if (!media) return null;
    drop.bytes = media.bytes;
    drop.mime = media.mime;
    if (kind === 'video') drop.videoSound = msg.videoSound !== false;
  } else if (kind === 'gif') {
    if (!V.isGiphyUrl(msg.url)) return null; // never load arbitrary URLs from strangers
    drop.src = msg.url;
  } else if (kind === 'text') {
    drop.text = V.cleanText(msg.text, V.MAX_TEXT_LENGTH);
    if (!drop.text) return null;
    drop.color = V.normalizeTextColor(msg.color);
    drop.rain = msg.rain === true && V.canRain(drop.text);
    drop.caption = null;
  } else if (kind !== 'sound') {
    return null;
  }

  const s = msg.sound;
  if (s && s.type === 'builtin' && V.BUILTIN_SOUNDS.includes(s.id)) {
    drop.sound = { type: 'builtin', id: s.id };
  } else if (s && s.type === 'file') {
    const audio = decodeMediaField(s.data, 'audio');
    if (audio) drop.sound = { type: 'file', mime: audio.mime, bytes: audio.bytes, name: typeof s.name === 'string' ? s.name.slice(0, 60) : '' };
  }
  if (kind === 'sound' && !drop.sound) return null;
  return drop;
}

function openExternalSafely(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === 'giphy.com' || host.endsWith('.giphy.com'))) {
      shell.openExternal(u.toString());
    }
  } catch {
    /* ignore */
  }
}
