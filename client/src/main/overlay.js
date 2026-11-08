'use strict';

const path = require('node:path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const MAX_ON_SCREEN = 6;

/**
 * The see-through, click-through, always-on-top window that memes appear in.
 *
 * It covers one display (the main one unless picked in the tray), ignores the mouse (so you can keep working or
 * gaming underneath) and is hidden whenever nothing is showing. The panic
 * hotkey hides the window *first* and then clears it, so even if the renderer
 * were stuck, the memes vanish instantly.
 */
class OverlayManager {
  constructor({ displayId = 'main' } = {}) {
    this.displayId = displayId; // 'main' or a display id (as a string)
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.activeCount = 0;
    this.hideTimer = null;

    ipcMain.on('overlay:count', (event, count) => {
      if (!this.win || event.sender !== this.win.webContents) return;
      this.activeCount = Number(count) || 0;
      clearTimeout(this.hideTimer);
      if (this.activeCount === 0) {
        // Small grace period so back-to-back drops don't flicker the window.
        this.hideTimer = setTimeout(() => {
          if (this.activeCount === 0 && this.win && !this.win.isDestroyed()) this.win.hide();
        }, 250);
      }
    });

    const refit = () => this.fitToDisplay();
    screen.on('display-metrics-changed', refit);
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
  }

  create() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { bounds } = this.targetDisplay();
    this.ready = false;
    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'MemeDrop overlay',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true);
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setMenu(null);

    this.win.webContents.on('did-finish-load', () => {
      this.ready = true;
      const queued = this.queue.splice(0);
      for (const drop of queued) this.deliver(drop);
    });
    this.win.webContents.on('render-process-gone', () => {
      // Recreate next time something needs showing.
      this.ready = false;
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
      this.win = null;
    });
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
    return this.win;
  }

  /** The display memes appear on; falls back to the main one if it was unplugged. */
  targetDisplay() {
    if (this.displayId !== 'main') {
      const match = screen.getAllDisplays().find((d) => String(d.id) === this.displayId);
      if (match) return match;
    }
    return screen.getPrimaryDisplay();
  }

  setDisplay(displayId) {
    this.displayId = displayId || 'main';
    this.fitToDisplay();
  }

  fitToDisplay() {
    if (!this.win || this.win.isDestroyed()) return;
    const { bounds } = this.targetDisplay();
    const current = this.win.getBounds();
    if (
      current.x === bounds.x && current.y === bounds.y &&
      current.width === bounds.width && current.height === bounds.height
    ) {
      return;
    }
    // Twice on purpose: moving between monitors with different scaling can
    // apply the old scale factor on the first call (Windows).
    this.win.setBounds(bounds);
    this.win.setBounds(bounds);
  }

  /**
   * Show a drop. `drop` = { id, src, kind, opacity, durationMs, position,
   * from, title, width, height, preview }.
   */
  show(drop) {
    this.create();
    if (!this.ready) {
      this.queue.push(drop);
      if (this.queue.length > MAX_ON_SCREEN) this.queue.shift();
      return;
    }
    this.deliver(drop);
  }

  deliver(drop) {
    if (!this.win || this.win.isDestroyed()) return;
    clearTimeout(this.hideTimer);
    this.fitToDisplay();
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.webContents.send('overlay:show', { ...drop, maxOnScreen: MAX_ON_SCREEN });
  }

  /** Panic button: everything off the screen, right now. */
  clearAll() {
    this.queue = [];
    this.activeCount = 0;
    clearTimeout(this.hideTimer);
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    this.win.webContents.send('overlay:clear');
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { OverlayManager };
