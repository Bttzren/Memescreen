'use strict';

/**
 * End-to-end smoke test of the real app:
 *   1. starts a relay, launches MemeDrop (dev build or a packaged .exe),
 *   2. joins a room through the UI, sends a meme to a fake friend,
 *   3. has the friend drop a meme back and checks it on the actual screen:
 *      solid where the image is, see-through everywhere else,
 *      blended at 50% opacity, and gone after a real Ctrl+Shift+X keypress.
 *
 * Usage:
 *   npm run test:e2e                         (dev build: electron .)
 *   MEMEDROP_EXE="dist/win-unpacked/MemeDrop.exe" npm run test:e2e
 *
 * Screen-pixel checks need a compositing desktop (Windows, macOS, or Linux
 * with a compositor) and are skipped elsewhere unless MEMEDROP_PIXEL_CHECKS=1.
 * Screenshots are saved to dist/smoke/.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');
const WebSocket = require('ws');

const CLIENT = path.join(__dirname, '..', '..');
const ROOT = path.join(CLIENT, '..');
const OUT = path.join(CLIENT, 'dist', 'smoke');
const SMOKE_PNG = path.join(CLIENT, 'test', 'fixtures', 'smoke.png'); // 400×300, magenta centre
const SMOKE_VIDEO = path.join(ROOT, 'server', 'test', 'fixtures', 'tiny.webm');
const FAKE_TUNNEL = path.join(CLIENT, 'test', 'fixtures', 'fake-cloudflared.js');
const MAGENTA = [255, 0, 255];
const TEAL = [0x20, 0x80, 0xa0]; // backdrop window colour

const PIXEL_CHECKS =
  process.env.MEMEDROP_PIXEL_CHECKS === '1' || process.platform === 'win32' || process.platform === 'darwin';

const { startServer } = require(path.join(ROOT, 'server', 'src', 'server.js'));

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function friend(port, room, nickname) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const next = (type, ms = 10000) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`friend: timed out waiting for ${type}`)), ms);
    });
  };
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', async () => {
      ws.send(JSON.stringify({ type: 'join', room, nickname }));
      const welcome = await next('welcome');
      resolve({ ws, next, id: welcome.id, send: (m) => ws.send(JSON.stringify(m)) });
    });
  });
}

async function getWindow(app, fragment) {
  for (;;) {
    const w = app.windows().find((p) => p.url().includes(fragment));
    if (w) return w;
    await app.waitForEvent('window', { timeout: 30000 });
  }
}

/** Capture the whole primary screen from inside the app and sample pixels at fractional positions. */
async function captureScreen(app, name, points) {
  const res = await app.evaluate(
    async ({ desktopCapturer, screen }, { points }) => {
      const d = screen.getPrimaryDisplay();
      const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
      const img = src.thumbnail;
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      const samples = points.map(([fx, fy]) => {
        const x = Math.min(width - 1, Math.round(fx * (width - 1)));
        const y = Math.min(height - 1, Math.round(fy * (height - 1)));
        const i = (y * width + x) * 4;
        return [bmp[i + 2], bmp[i + 1], bmp[i]];
      });
      return { width, height, samples, png: img.toPNG().toString('base64') };
    },
    { points },
  );
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.png, 'base64'));
  log(`screen ${name}: ${res.width}x${res.height} samples=${JSON.stringify(res.samples)}`);
  return res;
}

function near(actual, expected, tolerance) {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
}

function pressPanicHotkey() {
  if (process.platform === 'win32') {
    const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e); }
"@
[K]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [K]::keybd_event(0x10,0,0,[UIntPtr]::Zero); [K]::keybd_event(0x58,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0x58,0,2,[UIntPtr]::Zero); [K]::keybd_event(0x10,0,2,[UIntPtr]::Zero); [K]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
    return true;
  }
  try {
    execFileSync('xdotool', ['key', 'ctrl+shift+x']);
    return true;
  } catch {
    return false;
  }
}

async function overlayState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay/index.html'));
    return w ? { visible: w.isVisible(), onTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), bounds: w.getBounds() } : null;
  });
}

async function waitFor(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memedrop-smoke-'));

  const exe = process.env.MEMEDROP_EXE ? path.resolve(CLIENT, process.env.MEMEDROP_EXE) : null;
  const args = exe ? [] : [CLIENT];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  log(`launching ${exe || 'electron .'}`);
  const app = await electron.launch({
    executablePath: exe || require('electron'),
    args,
    cwd: CLIENT,
    env: { ...process.env, MEMEDROP_USER_DATA: userData, MEMEDROP_TUNNEL_BIN: FAKE_TUNNEL },
    timeout: 60000,
  });
  app.process().stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s && !/dbus|bus\.cc|Debugger|nodejs\.org|gpu|viz|libva/i.test(s)) console.log(`[app] ${s}`);
  });

  let bob;
  try {
    const control = await getWindow(app, 'control/index.html');
    await control.waitForSelector('#welcome-view:not([hidden])');
    log('welcome screen up');

    // Join a separately running relay via "Join a room" → server address.
    await control.click('#go-join');
    await control.evaluate(() => {
      document.getElementById('join-advanced').open = true;
    });
    await control.fill('#join-nickname', 'Alice');
    await control.fill('#server-url', `ws://127.0.0.1:${server.port}`);
    await control.fill('#room', 'smoke');
    await control.click('#join-btn');
    await control.waitForFunction(() => document.getElementById('status-dot').dataset.status === 'connected');
    log('joined room SMOKE');

    bob = await friend(server.port, 'SMOKE', 'Bob');
    await control.waitForSelector('.chip:has-text("Bob")');

    // Alice → Bob through the UI.
    await control.setInputFiles('#file-input', SMOKE_PNG);
    await control.waitForSelector('#dz-preview:not([hidden])');
    await control.click('#send-btn');
    const got = await bob.next('drop');
    assert.equal(got.mime, 'image/png');
    assert.equal(got.from.nickname, 'Alice');
    log('Alice → Bob: delivered');

    const hotkeyRegistered = await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered('CommandOrControl+Shift+X'),
    );
    assert.equal(hotkeyRegistered, true, 'Ctrl+Shift+X is registered');
    log('panic hotkey registered');

    // Hide the control window and put a solid teal "desktop" behind the
    // overlay, so the checks don't depend on the wallpaper.
    await control.click('#upload-clear');
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('control')) w.hide();
      const { bounds } = screen.getPrimaryDisplay();
      const backdrop = new BrowserWindow({
        ...bounds,
        frame: false,
        show: false,
        backgroundColor: '#2080a0',
      });
      await backdrop.loadURL('data:text/html,<body style="margin:0;background:%232080a0"></body>');
      backdrop.showInactive();
    });
    await new Promise((r) => setTimeout(r, 1000));

    const POINTS = [
      [0.5, 0.5], // centre: inside a centred drop
      [0.02, 0.02], // top-left corner: outside it
      [0.97, 0.5], // right edge: outside it
    ];
    const before = PIXEL_CHECKS ? await captureScreen(app, '1-before', POINTS) : null;
    if (before) {
      for (const px of before.samples) assert.ok(near(px, TEAL, 12), `backdrop should be teal, got ${px}`);
    }

    // Bob → Alice: fully opaque, centred.
    const overlay = await getWindow(app, 'overlay/index.html');
    const data = fs.readFileSync(SMOKE_PNG).toString('base64');
    bob.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 1, durationMs: 15000, position: 'center' });
    await overlay.waitForSelector('.drop.in', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 700)); // let the pop-in animation finish
    const st = await overlayState(app);
    log(`overlay window: ${JSON.stringify(st)}`);
    assert.equal(st.visible, true);
    assert.equal(st.onTop, true);

    if (PIXEL_CHECKS) {
      const shown = await captureScreen(app, '2-drop-opaque', POINTS);
      assert.ok(near(shown.samples[0], MAGENTA, 12), `centre should be the meme (magenta), got ${shown.samples[0]}`);
      assert.ok(near(shown.samples[1], before.samples[1], 6), 'corner should be unchanged (overlay is see-through)');
      assert.ok(near(shown.samples[2], before.samples[2], 6), 'edge should be unchanged (overlay is see-through)');
      log('PASS: meme is drawn, the rest of the screen shows through');
    }

    // Real keypress → global shortcut → everything gone.
    if (pressPanicHotkey()) {
      await waitFor(async () => (await overlayState(app)).visible === false, 'overlay hidden after Ctrl+Shift+X', 3000);
      assert.equal(await overlay.$$eval('.drop', (d) => d.length), 0);
      log('PASS: Ctrl+Shift+X cleared the screen');
      if (PIXEL_CHECKS) {
        await new Promise((r) => setTimeout(r, 400));
        const cleared = await captureScreen(app, '3-after-panic', POINTS);
        assert.ok(near(cleared.samples[0], before.samples[0], 6), 'centre is back to normal after panic');
      }
    } else {
      log('SKIP: no way to press keys on this system; clearing with the button instead');
      await control.evaluate(() => window.memedrop.clearScreen());
      await waitFor(async () => (await overlayState(app)).visible === false, 'overlay hidden after clear', 3000);
    }

    // 50% opacity: the meme should be blended with what's underneath.
    bob.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 0.5, durationMs: 15000, position: 'center' });
    await overlay.waitForSelector('.drop.in', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 700));
    if (PIXEL_CHECKS) {
      const half = await captureScreen(app, '4-drop-50pct', POINTS);
      const expected = MAGENTA.map((m, i) => Math.round(m * 0.5 + before.samples[0][i] * 0.5));
      assert.ok(near(half.samples[0], expected, 20), `50% blend expected ≈${expected}, got ${half.samples[0]}`);
      log('PASS: 50% opacity blends with the screen underneath');
    }

    // The window's trash button clears too.
    await control.evaluate(() => window.memedrop.clearScreen());
    await waitFor(async () => (await overlayState(app)).visible === false, 'overlay hidden after clear button', 3000);
    log('PASS: clear button cleared the screen');

    // Expiry: a short drop disappears and the overlay hides itself.
    bob.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 1, durationMs: 1000, position: 'random' });
    await overlay.waitForSelector('.drop.in', { timeout: 10000 });
    await waitFor(async () => (await overlayState(app)).visible === false, 'overlay hides after the drop expires', 6000);
    log('PASS: drop expired and the overlay hid itself');

    // Sound-only drop: shows a small pill and goes away when the sound ends.
    bob.send({ type: 'drop', to: 'all', kind: 'sound', sound: { type: 'builtin', id: 'pop' } });
    await overlay.waitForSelector('.drop--sound.in', { timeout: 10000 });
    await waitFor(async () => (await overlayState(app)).visible === false, 'sound pill goes away', 8000);
    log('PASS: sound-only drop');

    // Video drop plays.
    bob.send({ type: 'drop', to: 'all', kind: 'video', data: fs.readFileSync(SMOKE_VIDEO).toString('base64'), durationMs: 3000, position: 'center' });
    await overlay.waitForSelector('.drop.in video', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));
    const video = await overlay.evaluate(() => {
      const v = document.querySelector('.drop video');
      return { playing: !v.paused && v.currentTime > 0, width: v.videoWidth };
    });
    log(`video: ${JSON.stringify(video)}`);
    assert.equal(video.playing, true, 'video plays');
    await control.evaluate(() => window.memedrop.clearScreen());
    log('PASS: video drop plays');

    // Host a room inside the app ("Friends anywhere", with a stand-in tunnel helper).
    await control.evaluate(() => window.memedrop.leaveRoom());
    await control.waitForSelector('#welcome-view:not([hidden])');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('control')) w.show();
    });
    await control.click('#go-host');
    await control.fill('#host-nickname', 'Alice');
    await control.fill('#host-room', 'SMOKE-HOST');
    await control.check('input[name="host-mode"][value="internet"]');
    await control.click('#host-start');
    await control.waitForFunction(() => document.getElementById('status-dot').dataset.status === 'connected', null, { timeout: 30000 });
    let invite = '';
    await waitFor(async () => {
      invite = await app.evaluate(async ({ clipboard }) => clipboard.readText());
      return invite.includes('/join/');
    }, 'invite link copied to the clipboard', 5000);
    log(`hosting; invite link: ${invite}`);
    assert.equal(invite, 'https://silly-test-words-here.trycloudflare.com/join/SMOKE-HOST');
    const guest = await friend(8787, 'SMOKE-HOST', 'Guest');
    await control.waitForSelector('.chip:has-text("Guest")');
    guest.send({ type: 'drop', to: 'all', kind: 'image', data, opacity: 1, durationMs: 3000, position: 'random' });
    await overlay.waitForSelector('.drop.in', { timeout: 10000 });
    assert.equal(await overlay.$eval('.drop .tag', (t) => t.textContent), 'Guest');
    guest.ws.terminate();
    log('PASS: hosting inside the app works');

    log('ALL GOOD');
  } finally {
    if (bob) bob.ws.terminate();
    await app.close().catch(() => {});
    await server.close();
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
