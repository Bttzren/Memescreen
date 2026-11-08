'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, drop) => cb(drop)),
  onClear: (cb) => ipcRenderer.on('overlay:clear', () => cb()),
  reportCount: (count) => ipcRenderer.send('overlay:count', count),
});
