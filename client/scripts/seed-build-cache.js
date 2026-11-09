'use strict';

/**
 * Copies the build helpers in vendor/build-tools/ into electron-builder's
 * download cache before `npm run dist`.
 *
 * Why: electron-builder downloads its NSIS installer tools from GitHub
 * releases, and GitHub sometimes answers build servers with 504s for days
 * (normal browsers are fine). electron-builder checks
 * <cache>/<release>/<file> before downloading and verifies the file against
 * its own built-in SHA-256, so a bundled copy is used safely and the build no
 * longer depends on that download.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VENDOR = path.join(__dirname, '..', 'vendor', 'build-tools');

// Same rules as electron-builder's getCacheDirectory().
function cacheDir() {
  const env = (process.env.ELECTRON_BUILDER_CACHE || '').trim();
  if (env && path.parse(env).root) return env;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  if (process.platform === 'win32') {
    const local = (process.env.LOCALAPPDATA || '').trim();
    const user = (process.env.USERNAME || '').trim().toLowerCase();
    if (!local || local.toLowerCase().includes('\\windows\\system32\\') || user === 'system') {
      return path.join(os.tmpdir(), 'electron-builder-cache');
    }
    return path.join(local, 'electron-builder', 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg && path.parse(xdg).root ? path.join(xdg, 'electron-builder') : path.join(os.homedir(), '.cache', 'electron-builder');
}

function main() {
  if (!fs.existsSync(VENDOR)) return;
  const root = cacheDir();
  for (const release of fs.readdirSync(VENDOR)) {
    const srcDir = path.join(VENDOR, release);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    for (const file of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, file);
      const dest = path.join(root, release, file);
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`seeded ${release}/${file}`);
      } catch (err) {
        // Not fatal: electron-builder will just try to download it.
        console.warn(`could not seed ${release}/${file}: ${err.message}`);
      }
    }
  }
}

main();
