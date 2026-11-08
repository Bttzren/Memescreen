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
  connect: (opts) => ipcRenderer.invoke('conn:connect', opts),
  disconnect: () => ipcRenderer.invoke('conn:disconnect'),
  sendDrop: (payload) => ipcRenderer.invoke('drop:send', payload),
  previewDrop: (payload) => ipcRenderer.invoke('drop:preview', payload),
  searchGifs: (query, offset) => ipcRenderer.invoke('gif:search', { query, offset }),
  trendingGifs: (offset) => ipcRenderer.invoke('gif:trending', { offset }),
  updatePrefs: (patch) => ipcRenderer.invoke('prefs:update', patch),
  setMuted: (muted) => ipcRenderer.invoke('mute:set', muted),
  clearScreen: () => ipcRenderer.invoke('overlay:clear'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onState: (cb) => subscribe('state', cb),
  onNotice: (cb) => subscribe('notice', cb),
  onIncoming: (cb) => subscribe('incoming', cb),
});
