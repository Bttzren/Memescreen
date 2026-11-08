'use strict';

// Bridge between the control window (no Node access) and the main process.
// Only these named functions are exposed — the page can't touch ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('memedrop', {
  init: () => ipcRenderer.invoke('app:init'),
  // Rooms
  hostRoom: (opts) => ipcRenderer.invoke('room:host', opts),
  restartRoom: () => ipcRenderer.invoke('room:restart'),
  joinRoom: (opts) => ipcRenderer.invoke('room:join', opts),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  // Sending
  sendDrop: (payload) => ipcRenderer.invoke('drop:send', payload),
  previewDrop: (payload) => ipcRenderer.invoke('drop:preview', payload),
  searchGifs: (query, offset) => ipcRenderer.invoke('gif:search', { query, offset }),
  trendingGifs: (offset) => ipcRenderer.invoke('gif:trending', { offset }),
  // Settings
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setMuted: (muted) => ipcRenderer.invoke('mute:set', muted),
  clearScreen: () => ipcRenderer.invoke('overlay:clear'),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
  resetHotkey: () => ipcRenderer.invoke('hotkey:reset'),
  pauseHotkey: (paused) => ipcRenderer.invoke('hotkey:pause', paused),
  saveGiphyKey: (key) => ipcRenderer.invoke('giphy:save', key),
  // Misc
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  inviteFromClipboard: () => ipcRenderer.invoke('clipboard:invite'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onState: (cb) => subscribe('state', cb),
  onNotice: (cb) => subscribe('notice', cb),
  onIncoming: (cb) => subscribe('incoming', cb),
  onInvite: (cb) => subscribe('invite', cb),
});
