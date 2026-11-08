'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

/**
 * System tray icon: open the window, mute incoming memes, clear the screen,
 * quit. Left-click opens the window (the Windows convention).
 */
function createTray({ onOpen, onToggleMute, onToggleStartup, onClear, onQuit, hotkeyLabel, canStartWithOs }) {
  const icons = {
    normal: nativeImage.createFromPath(path.join(ASSETS, 'tray.png')),
    muted: nativeImage.createFromPath(path.join(ASSETS, 'tray-muted.png')),
  };
  const tray = new Tray(icons.normal);
  let current = { muted: false, status: 'disconnected', room: null, hotkeyOk: true, startWithOs: false };

  function render() {
    const statusLine =
      current.status === 'connected'
        ? `Connected to room ${current.room}`
        : current.status === 'connecting' || current.status === 'reconnecting'
          ? 'Connecting…'
          : 'Not connected';

    tray.setImage(current.muted ? icons.muted : icons.normal);
    tray.setToolTip(`MemeDrop — ${statusLine}${current.muted ? ' (muted)' : ''}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open MemeDrop', click: onOpen },
        { label: statusLine, enabled: false },
        { type: 'separator' },
        { label: 'Mute incoming memes', type: 'checkbox', checked: current.muted, click: onToggleMute },
        {
          label: current.hotkeyOk ? `Clear screen now (${hotkeyLabel})` : 'Clear screen now',
          click: onClear,
        },
        { type: 'separator' },
        ...(canStartWithOs
          ? [
              {
                label: process.platform === 'darwin' ? 'Start at login' : 'Start with Windows',
                type: 'checkbox',
                checked: current.startWithOs,
                click: onToggleStartup,
              },
            ]
          : []),
        { label: 'Quit MemeDrop', click: onQuit },
      ]),
    );
  }

  tray.on('click', onOpen);
  tray.on('double-click', onOpen);
  render();

  return {
    tray,
    update(patch) {
      current = { ...current, ...patch };
      render();
    },
    notify(title, content) {
      // Windows balloon; harmless no-op elsewhere.
      if (typeof tray.displayBalloon === 'function' && process.platform === 'win32') {
        tray.displayBalloon({ title, content, iconType: 'none', icon: nativeImage.createFromPath(path.join(ASSETS, 'icon-256.png')) });
      }
    },
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { createTray };
