'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createRateLimiter } = require('./cache');
const {
  ALLOWED_IMAGE_MIMES,
  POSITIONS,
  normalizeRoom,
  normalizeNickname,
  cleanText,
  clampNumber,
  normalizePosition,
  isGiphyUrl,
  decodeImage,
} = require('./validate');

const PROTOCOL_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxRoomSize: 30,
  minDurationMs: 1000,
  maxDurationMs: 15000,
  defaultDurationMs: 4000,
  minOpacity: 0.1,
  maxOpacity: 1,
  // Anti-spam: 8 drops per 10 s burst, 20 GIF searches per minute (per person).
  dropsPerWindow: 8,
  dropWindowMs: 10_000,
  searchesPerWindow: 20,
  searchWindowMs: 60_000,
});

// Skip a recipient whose connection is this backed up rather than buffering forever.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

/**
 * Attach the MemeDrop relay to an existing http.Server.
 *
 * Wire protocol (JSON text frames):
 *   client → server
 *     { type: 'join', room, nickname }
 *     { type: 'drop', ref?, to: 'all' | <peerId>, kind: 'image', data: <base64>, opacity, durationMs, position }
 *     { type: 'drop', ref?, to: 'all' | <peerId>, kind: 'gif', url, width?, height?, title?, opacity, durationMs, position }
 *     { type: 'gif-search', reqId, query, offset? }
 *     { type: 'gif-trending', reqId, offset? }
 *     { type: 'leave' }
 *   server → client
 *     { type: 'welcome', protocol, id, room, nickname, peers, limits, features }
 *     { type: 'roster', peers: [{ id, nickname }] }      (everyone in the room, including you)
 *     { type: 'drop', dropId, from: { id, nickname }, kind, ... }
 *     { type: 'drop-sent', ref, dropId, delivered, to }
 *     { type: 'gif-results', reqId, mode, query, items, nextOffset, total }
 *     { type: 'error', code, message, ref?, reqId? }
 */
function createRelay({ server, limits: limitOverrides = {}, giphy = null, log = defaultLog } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  // Leave headroom over the image cap (base64 + JSON) so oversized images get a
  // friendly error instead of a dropped connection.
  const maxPayload = Math.ceil((limits.maxImageBytes * 4) / 3) + 256 * 1024;

  const wss = new WebSocketServer({ server, maxPayload, perMessageDeflate: false });
  /** @type {Map<string, Map<string, Client>>} room code -> (client id -> client) */
  const rooms = new Map();
  /** @type {Set<Client>} every connected socket, joined or not */
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    const client = {
      id: crypto.randomBytes(6).toString('hex'),
      ws,
      room: null,
      nickname: null,
      isAlive: true,
      dropLimiter: createRateLimiter({ limit: limits.dropsPerWindow, windowMs: limits.dropWindowMs }),
      searchLimiter: createRateLimiter({ limit: limits.searchesPerWindow, windowMs: limits.searchWindowMs }),
    };

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        sendError(client, 'bad_message', 'Binary messages are not supported.');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        sendError(client, 'bad_message', 'Could not read that message.');
        return;
      }
      if (!msg || typeof msg !== 'object') {
        sendError(client, 'bad_message', 'Could not read that message.');
        return;
      }
      try {
        handleMessage(client, msg);
      } catch (err) {
        log('error', `handler crashed on "${msg.type}": ${err && err.stack ? err.stack : err}`);
        sendError(client, 'server_error', 'Something went wrong on the server.', msg);
      }
    });

    clients.add(client);
    ws.on('close', () => {
      clients.delete(client);
      leaveRoom(client);
    });
    ws.on('error', (err) => log('warn', `socket error (${client.nickname || client.id}): ${err.message}`));

    log('debug', `connection from ${req.socket.remoteAddress}`);
  });

  // Drop connections that stopped answering pings (laptop lid closed, Wi-Fi gone...).
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function handleMessage(client, msg) {
    switch (msg.type) {
      case 'join':
        return handleJoin(client, msg);
      case 'leave':
        leaveRoom(client);
        return undefined;
      case 'drop':
        return handleDrop(client, msg);
      case 'gif-search':
      case 'gif-trending':
        return handleGif(client, msg);
      case 'ping':
        return send(client, { type: 'pong', t: msg.t });
      default:
        return sendError(client, 'bad_message', `Unknown message type "${String(msg.type).slice(0, 32)}".`, msg);
    }
  }

  function handleJoin(client, msg) {
    const room = normalizeRoom(msg.room);
    if (!room) {
      return sendError(client, 'bad_room', 'Room codes are 1–32 letters, numbers, dashes or underscores.', msg);
    }
    const requestedNick = normalizeNickname(msg.nickname);
    if (!requestedNick) {
      return sendError(client, 'bad_nickname', 'Pick a nickname between 1 and 24 characters.', msg);
    }

    if (client.room) leaveRoom(client);

    const members = rooms.get(room) || new Map();
    if (members.size >= limits.maxRoomSize) {
      return sendError(client, 'room_full', `That room is full (${limits.maxRoomSize} people max).`, msg);
    }

    client.nickname = uniqueNickname(requestedNick, members);
    client.room = room;
    members.set(client.id, client);
    rooms.set(room, members);

    send(client, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      id: client.id,
      room,
      nickname: client.nickname,
      peers: roster(members),
      limits: publicLimits(),
      features: { giphy: Boolean(giphy) },
    });
    broadcastRoster(room, client.id);
    log('info', `${client.nickname} joined ${room} (${members.size} online)`);
    return undefined;
  }

  function leaveRoom(client) {
    const room = client.room;
    if (!room) return;
    const members = rooms.get(room);
    client.room = null;
    if (!members) return;
    members.delete(client.id);
    log('info', `${client.nickname} left ${room} (${members.size} online)`);
    if (members.size === 0) {
      rooms.delete(room);
    } else {
      broadcastRoster(room);
    }
  }

  function handleDrop(client, msg) {
    if (!client.room) return sendError(client, 'not_joined', 'Join a room first.', msg);
    if (!client.dropLimiter.take()) {
      return sendError(client, 'rate_limited', 'Whoa, slow down! Too many memes at once.', msg);
    }

    const members = rooms.get(client.room);
    let recipients;
    if (msg.to === 'all') {
      recipients = [...members.values()].filter((c) => c.id !== client.id);
    } else {
      const target = typeof msg.to === 'string' ? members.get(msg.to) : undefined;
      if (!target || target.id === client.id) {
        return sendError(client, 'peer_not_found', "That friend isn't in the room anymore.", msg);
      }
      recipients = [target];
    }

    const base = {
      type: 'drop',
      dropId: crypto.randomBytes(6).toString('hex'),
      from: { id: client.id, nickname: client.nickname },
      opacity: round2(clampNumber(msg.opacity, limits.minOpacity, limits.maxOpacity, 1)),
      durationMs: Math.round(
        clampNumber(msg.durationMs, limits.minDurationMs, limits.maxDurationMs, limits.defaultDurationMs),
      ),
      position: normalizePosition(msg.position),
      sentAt: Date.now(),
    };

    let outgoing;
    if (msg.kind === 'image') {
      const image = decodeImage(msg.data, limits.maxImageBytes);
      if (image.error) return sendError(client, 'bad_image', image.error, msg);
      outgoing = { ...base, kind: 'image', mime: image.mime, data: image.base64 };
    } else if (msg.kind === 'gif') {
      if (!isGiphyUrl(msg.url)) {
        return sendError(client, 'bad_gif', 'Only GIPHY links can be sent as GIFs.', msg);
      }
      outgoing = {
        ...base,
        kind: 'gif',
        url: msg.url,
        width: optionalDimension(msg.width),
        height: optionalDimension(msg.height),
        title: cleanText(msg.title, 100),
      };
    } else {
      return sendError(client, 'bad_message', 'Unknown drop kind.', msg);
    }

    const payload = JSON.stringify(outgoing);
    let delivered = 0;
    for (const peer of recipients) {
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      peer.ws.send(payload);
      delivered += 1;
    }

    send(client, {
      type: 'drop-sent',
      ref: msg.ref,
      dropId: outgoing.dropId,
      kind: outgoing.kind,
      to: msg.to === 'all' ? 'all' : msg.to,
      delivered,
    });
    log('info', `${client.nickname} dropped a ${outgoing.kind} on ${msg.to === 'all' ? 'everyone' : recipients[0].nickname} in ${client.room} (${delivered} delivered)`);
    return undefined;
  }

  async function handleGif(client, msg) {
    const reqId = msg.reqId;
    if (!client.room) return sendError(client, 'not_joined', 'Join a room first.', msg);
    if (!giphy) {
      return sendError(client, 'giphy_disabled', "GIF search isn't set up on this server (no GIPHY_API_KEY).", msg);
    }
    if (!client.searchLimiter.take()) {
      return sendError(client, 'rate_limited', 'Too many GIF searches — give it a few seconds.', msg);
    }
    const mode = msg.type === 'gif-search' ? 'search' : 'trending';
    try {
      const result =
        mode === 'search' ? await giphy.search(msg.query, msg.offset) : await giphy.trending(msg.offset);
      send(client, {
        type: 'gif-results',
        reqId,
        mode,
        query: mode === 'search' ? cleanText(msg.query, 50) : null,
        offset: Math.max(0, Math.floor(Number(msg.offset) || 0)),
        ...result,
      });
    } catch (err) {
      if (err && err.name === 'GiphyError') {
        log('warn', `GIPHY ${mode} failed: ${err.code}${err.status ? ` (${err.status})` : ''}`);
        sendError(client, err.code, err.message, msg);
      } else {
        log('error', `GIPHY ${mode} crashed: ${err && err.stack ? err.stack : err}`);
        sendError(client, 'giphy_error', 'GIF search failed. Try again.', msg);
      }
    }
    return undefined;
  }

  function uniqueNickname(nick, members) {
    const taken = new Set([...members.values()].map((c) => c.nickname.toLowerCase()));
    if (!taken.has(nick.toLowerCase())) return nick;
    for (let i = 2; ; i += 1) {
      const suffix = ` ${i}`;
      const candidate = nick.slice(0, 24 - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  function roster(members) {
    return [...members.values()].map((c) => ({ id: c.id, nickname: c.nickname }));
  }

  function broadcastRoster(room, skipId) {
    const members = rooms.get(room);
    if (!members) return;
    const msg = { type: 'roster', peers: roster(members) };
    for (const c of members.values()) {
      if (c.id !== skipId) send(c, msg);
    }
  }

  function publicLimits() {
    return {
      maxImageBytes: limits.maxImageBytes,
      minDurationMs: limits.minDurationMs,
      maxDurationMs: limits.maxDurationMs,
      minOpacity: limits.minOpacity,
      maxOpacity: limits.maxOpacity,
      imageTypes: ALLOWED_IMAGE_MIMES,
      positions: POSITIONS,
    };
  }

  function send(client, obj) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(obj));
  }

  function sendError(client, code, message, msg) {
    const err = { type: 'error', code, message };
    if (msg && msg.ref !== undefined) err.ref = msg.ref;
    if (msg && msg.reqId !== undefined) err.reqId = msg.reqId;
    send(client, err);
  }

  function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return { wss, rooms, limits, close };
}

function optionalDimension(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 && n <= 10000 ? n : undefined;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function defaultLog(level, message) {
  if (level === 'debug' && !process.env.DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = { createRelay, DEFAULT_LIMITS, PROTOCOL_VERSION };
