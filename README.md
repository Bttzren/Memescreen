# MemeDrop

Send memes and GIFs straight onto your friends' screens.

Everyone installs the app and joins the same **room code**. Pick a friend (or everyone), drop in an image or search for a GIF, and it pops up on their screen for a few seconds over whatever they're doing, then disappears. The sender chooses how see-through it is, how long it stays, and where it lands.

<p align="center">
  <img src="docs/app.png" alt="The MemeDrop window: join screen and the send screen with an image ready to drop" width="640">
</p>
<p align="center">
  <img src="docs/overlay.png" alt="A meme dropped on someone's screen at 85% opacity, with the sender's name in the corner" width="640">
  <br><sub>What your friend sees: the meme floats over their apps and their mouse clicks pass straight through it.</sub>
</p>

```
 ┌──────────────┐        ┌───────────────────────┐        ┌──────────────┐
 │ You          │  ws    │  Relay server (Node)  │  ws    │ Friend       │
 │ (Electron)   │ ─────► │  rooms · limits ·     │ ─────► │ meme pops up │
 │              │ ◄───── │  GIPHY search proxy   │ ◄───── │ on screen    │
 └──────────────┘        └───────────────────────┘        └──────────────┘
```

- **`server/`**: a tiny Node.js WebSocket relay. It keeps track of who's in which room, passes drops along, enforces the limits, and proxies GIPHY search so only the server needs an API key.
- **`client/`**: the Windows desktop app (Electron). It has a small window for connecting and sending, a tray icon, and a transparent, click-through overlay where memes appear.

There are no accounts. Anyone who knows the server address and your room code can join, so pick a room code that's hard to guess.

---

## 1. Run the server

You need **Node.js 20.12 or newer** ([download](https://nodejs.org/), the LTS version is fine).

```bash
cd server
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

You'll see something like:

```
  MemeDrop relay is running!

  Local:    ws://localhost:8787
  Network:  ws://192.168.1.20:8787

  GIF search: off — set GIPHY_API_KEY in server/.env to turn it on
```

Give your friends the address that works for them:

| Where are your friends? | What to do |
| --- | --- |
| **Same Wi-Fi / LAN** | Use the `Network:` address, e.g. `ws://192.168.1.20:8787`. Allow Node through Windows Firewall when it asks. |
| **Anywhere, easiest** | Install [Tailscale](https://tailscale.com/) on everyone's PC and use your Tailscale IP: `ws://100.x.y.z:8787`. |
| **Anywhere, quick tunnel** | Run `cloudflared tunnel --url http://localhost:8787` ([cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)). It prints an `https://….trycloudflare.com` address; friends type it in as **`wss://….trycloudflare.com`**. The address changes every time you restart the tunnel. |
| **Anywhere, always on** | Host `server/` on any Node host that supports WebSockets (Render, Railway, Fly.io, a small VPS…). Set the root directory to `server`, the start command to `npm start`, and add `GIPHY_API_KEY` in the host's environment settings. Friends use `wss://your-app.example.com`. Free tiers often go to sleep when idle, so the first connection can take a few seconds. |
| **Port forwarding** | Forward TCP port 8787 on your router to the PC running the server and share `ws://your-public-ip:8787`. |

The client is forgiving about the format. `192.168.1.20:8787`, `http://…` and `https://…` are all converted to the right `ws://` or `wss://` address.

### Server settings (`server/.env`)

| Variable | Default | What it does |
| --- | --- | --- |
| `GIPHY_API_KEY` | *(empty)* | Turns on GIF search. See below. |
| `PORT` | `8787` | Port for both HTTP and WebSocket. Most hosts set this for you. |
| `HOST` | `0.0.0.0` | Interface to listen on. |
| `MAX_IMAGE_MB` | `5` | Biggest image someone can upload. |
| `MAX_ROOM_SIZE` | `30` | Max people per room. |
| `GIPHY_RATING` | `pg-13` | GIPHY content rating: `g`, `pg`, `pg-13` or `r`. |
| `GIPHY_LANG` | `en` | Search language. |
| `GIPHY_CACHE_SECONDS` | `300` | How long search results are cached. Trending is cached for at least 10 minutes. |

Real environment variables take priority over `.env`. A health check lives at `GET /health`.

---

## 2. Turn on GIF search (GIPHY)

1. Sign in at **[developers.giphy.com](https://developers.giphy.com/dashboard/)**, click **Create an App**, choose **API**, and copy the API key.
2. Put it in `server/.env`:
   ```
   GIPHY_API_KEY=your-key-here
   ```
3. Restart the server. It should now say `GIF search: on`.

How it works:

- **The key stays on the server.** Friends' apps ask the relay for search results over their existing connection, and only people who have joined a room can search. The key never goes to clients and is never written to logs.
- **`.env` is gitignored**, so you can't commit your key by accident. Only `.env.example` is in the repo.
- **GIFs aren't relayed as files.** When you send a GIF, only its GIPHY link goes through the server, and your friend's app loads it from GIPHY itself. Both the server and the app refuse links that aren't `https://…giphy.com`.
- **Results are cached briefly** and identical searches that arrive at the same moment share one request. New GIPHY keys start as *beta* keys, limited to roughly 100 requests per hour. Caching keeps a small group well under that. If you do hit the limit, the app says "GIF search is resting" and it recovers on its own. You can apply for a production key from the GIPHY dashboard.
- **Attribution**: the Search GIFs tab shows "Powered by GIPHY" (it links to giphy.com), and GIFs on screen are tagged "via GIPHY", per GIPHY's attribution rules (see the [GIPHY developer docs](https://developers.giphy.com/docs/api/)). If you apply for a production key, GIPHY may ask you to use their official logo artwork. Swap it into the `.giphy-attribution` element in `client/src/renderer/control/index.html`.

---

## 3. Install the app (Windows)

### Option A: download a ready-made installer

Every push that changes the app builds a Windows installer with GitHub Actions:

1. Open the repo on GitHub, then **Actions**, then **CI**, then the latest green run.
2. Under **Artifacts**, download **MemeDrop-Windows-Installer** (a zip with `MemeDrop Setup x.y.z.exe` inside).
3. Share the `.exe` with your friends (Discord, Google Drive, whatever).

You can also start a fresh build any time with **Run workflow** on the CI page.

### Option B: build the installer yourself

On a Windows PC with Node.js installed:

```bash
cd client
npm install
npm run dist
```

The installer ends up at `client/dist/MemeDrop Setup 1.0.0.exe`.

### Installing

Double-click the installer. It installs for the current user (no admin rights needed), adds Start Menu and desktop shortcuts, and launches MemeDrop.

> **"Windows protected your PC"?** The installer isn't code-signed, because certificates cost money. Click **More info → Run anyway**.

### Option C: run from source (any OS, for tinkering)

```bash
cd client
npm install
npm start
```

---

## 4. Using MemeDrop

**Joining:** enter the server address, a room code (letters, numbers, `-` and `_`, not case-sensitive) and a nickname, then click **Join room**. MemeDrop remembers these and reconnects automatically next time, including after Wi-Fi drops or sleep.

**Sending:**

1. **Send to**: pick **Everyone** or one friend.
2. **Upload** tab: drop an image onto the box, click to browse, or just **Ctrl+V** to paste a screenshot or copied image. Supports PNG, JPG, GIF and WebP, up to 5 MB.
   **Search GIFs** tab: browse trending, search, and click a GIF to select it. Double-clicking a GIF sends it immediately.
3. Set the **opacity** (10% faint to 100% fully solid), **duration** (1–15 seconds) and **position**:
   - **Random**: medium-sized, somewhere random, with a slight tilt
   - **Center**: up to 60% of the screen, dead center
   - **Full screen**: as big as the screen allows, with the whole image visible
4. Use **Preview on me** to see it on your own screen first, then **Drop it!** (or **Ctrl+Enter**).

**Receiving:** the meme pops up on your screen with the sender's name in the corner, then fades out. It never takes focus or blocks the mouse, so you can keep typing, clicking or gaming underneath. At most 6 are shown at once.

**Staying in control:**

| | |
| --- | --- |
| **Ctrl+Shift+X** | **Panic button.** Instantly clears everything on your screen, from any app. |
| 🔔 button / tray → **Mute incoming memes** | Hide everything friends send until you unmute. You'll still see "X sent a meme" in the window. |
| 🗑 button / tray → **Clear screen now** | Same as the panic hotkey. |
| Tray → **Show memes on** | Choose which monitor memes appear on (only shown if you have more than one). |
| Tray → **Start with Windows** | Launch quietly into the tray when you log in. |
| Tray → **Quit MemeDrop** | Closing the window only hides it to the tray. Use this to actually quit. |

---

## Limits and safety

This is built for a small group of friends, so there are no accounts and no heavy security. It still won't let anyone wreck your PC:

- **Images**: max 5 MB, PNG, JPG, GIF or WebP only. The file type is checked from the file's contents, not its name. Images bigger than 16384 px on a side or 64 megapixels are refused, so a tiny "image bomb" can't freeze anyone's screen.
- **GIFs**: only `https://…giphy.com` links can be sent, and the overlay window is locked down (Content-Security-Policy) so it can't load anything else.
- **Spam**: about 8 drops per 10 seconds per person, 20 GIF searches per minute, 30 people per room.
- **Duration and opacity** are clamped to 1–15 s and 10–100% by the server, whatever the sender's app says.
- **The app itself**: its pages run sandboxed with no Node access, can't navigate anywhere or open pop-ups, and every permission request (camera, mic…) is denied.
- **Traffic** is plain `ws://` unless your server sits behind HTTPS (`wss://`). That's fine on a LAN or Tailscale. Use a host or tunnel with HTTPS if you'd rather not send memes unencrypted over the internet.

---

## Troubleshooting

- **The overlay shows up as a black box instead of see-through.** Some graphics drivers don't like transparent windows. Start MemeDrop with GPU acceleration off: right-click the shortcut, choose **Properties**, and add ` --no-gpu` to the end of **Target**.
- **Memes don't appear over my game.** Games in *exclusive* fullscreen draw over everything. Switch the game to **borderless windowed** (sometimes called "fullscreen windowed").
- **Ctrl+Shift+X doesn't do anything.** Another app has claimed that shortcut, and MemeDrop shows a yellow banner when this happens. The 🗑 button and the tray's **Clear screen now** always work. Also note that while MemeDrop runs, it takes Ctrl+Shift+X from other apps (e.g. VS Code's Extensions shortcut).
- **"Can't reach the server."** Check the server is running, the address and port are right, and the server PC's firewall allows Node. Hosted or tunnel addresses need `wss://`, not `ws://`.
- **"That address isn't a MemeDrop server."** You're probably pointing at a web page rather than the relay. Check the port, and use `wss://` for HTTPS hosts.
- **"GIF search isn't set up on this server."** The server has no `GIPHY_API_KEY`. See section 2.
- **"GIF search is resting."** You've hit GIPHY's hourly limit on a beta key. Wait a bit, or get a production key.

---

## Development

```
server/
  src/index.js       entry point: loads .env, starts the server
  src/server.js      HTTP (health check) + WebSocket server
  src/relay.js       rooms, roster, drops, limits, wire protocol
  src/giphy.js       GIPHY search/trending proxy with cache
  src/validate.js    input checks, image sniffing, URL allow-list
  test/              node:test suites (real sockets + a fake GIPHY)
client/
  src/main/          Electron main process: app, connection, overlay, tray, settings
  src/preload/       the only bridge between pages and the main process
  src/renderer/      control window (UI) and overlay window
  src/shared/        validation + overlay layout (unit tested)
  assets/            icons (regenerate with scripts/make-icons.py)
```

**Tests:**

```bash
cd server && npm install && npm test
cd client && npm install && npm test   # the client tests talk to the real server code, so install the server first
```

**End-to-end smoke test.** `npm run test:e2e` (in `client/`) launches the real app, joins a room, has a fake friend drop a meme, and checks the overlay. On Windows and macOS it also checks real screen pixels: the meme is drawn, everything around it shows through, 50% opacity blends correctly, and a real Ctrl+Shift+X keypress clears it. CI runs it against the packaged `MemeDrop.exe` and uploads the screenshots as an artifact. To test a packaged build yourself, set `MEMEDROP_EXE=dist/win-unpacked/MemeDrop.exe`.

**Two clients on one PC.** Each copy needs its own settings folder:

```powershell
# PowerShell, second terminal
$env:MEMEDROP_USER_DATA = "$env:TEMP\memedrop-2"; npm start
```

```bash
# macOS / Linux
MEMEDROP_USER_DATA=/tmp/memedrop-2 npm start
```

**Wire protocol.** JSON over WebSocket. It's documented at the top of [`server/src/relay.js`](server/src/relay.js).
