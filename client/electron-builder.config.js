'use strict';

/**
 * electron-builder settings (used by `npm run dist`).
 *
 * The Electron zip is verified against the checksums that ship inside the
 * `electron` npm package (pinned by package-lock.json). Without these inline
 * checksums electron-builder re-downloads SHASUMS256.txt from GitHub on every
 * build, so a GitHub hiccup (504s) would break builds even with a warm cache.
 */
const electronChecksums = require('electron/checksums.json');

module.exports = {
  appId: 'com.memedrop.app',
  productName: 'MemeDrop',
  copyright: 'MemeDrop',
  directories: {
    output: 'dist',
    buildResources: 'assets',
  },
  files: ['src/**/*', 'assets/**/*', 'package.json'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'MemeDrop',
    runAfterFinish: true,
  },
  publish: null,
  // Clicking a memedrop:// invite link opens MemeDrop.
  protocols: [{ name: 'MemeDrop invite', schemes: ['memedrop'] }],
  electronDownload: {
    checksums: electronChecksums,
  },
};
