'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

/**
 * System tray icon: open the window, mute incoming memes, clear the screen,
 * quit. Left-click opens the window (the Windows convention).
 */
function createTray({
  onOpen,
  onToggleMute,
  onToggleSounds,
  onToggleStartup,
  onPickDisplay,
  getDisplays,
  onClear,
  onQuit,
  canStartWithOs,
}) {
  const icons = {
    normal: nativeImage.createFromPath(path.join(ASSETS, 'tray.png')),
    muted: nativeImage.createFromPath(path.join(ASSETS, 'tray-muted.png')),
  };
  const tray = new Tray(icons.normal);
  let current = {
    muted: false,
    soundsEnabled: true,
    status: 'disconnected',
    room: null,
    hosting: false,
    hotkeyOk: true,
    hotkeyLabel: 'Ctrl+Shift+X',
    startWithOs: false,
    displayId: 'main',
  };

  function render() {
    const statusLine =
      current.status === 'connected'
        ? `${current.hosting ? 'Hosting' : 'In'} room ${current.room}`
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
        { label: 'Play sounds', type: 'checkbox', checked: current.soundsEnabled, click: onToggleSounds },
        {
          label: current.hotkeyOk ? `Clear screen now (${current.hotkeyLabel})` : 'Clear screen now',
          click: onClear,
        },
        ...displayMenu(),
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

  // "Show memes on ▸" — only when there's more than one screen.
  function displayMenu() {
    const displays = getDisplays();
    if (displays.length < 2) return [];
    const known = displays.some((d) => d.id === current.displayId);
    return [
      {
        label: 'Show memes on',
        submenu: [
          {
            label: 'Main screen',
            type: 'radio',
            checked: current.displayId === 'main' || !known,
            click: () => onPickDisplay('main'),
          },
          { type: 'separator' },
          ...displays.map((d) => ({
            label: d.label,
            type: 'radio',
            checked: current.displayId === d.id,
            click: () => onPickDisplay(d.id),
          })),
        ],
      },
    ];
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
        tray.displayBalloon({ title, content, iconType: 'custom', icon: nativeImage.createFromPath(path.join(ASSETS, 'icon-256.png')) });
      }
    },
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { createTray };
