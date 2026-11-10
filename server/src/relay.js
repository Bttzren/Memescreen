'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createRateLimiter } = require('./cache');
const {
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  ALLOWED_AUDIO_MIMES,
  BUILTIN_SOUNDS,
  POSITIONS,
  REACTIONS,
  MAX_TEXT_LENGTH,
  canRain,
  normalizeEffect,
  normalizeTextColor,
  normalizeCaption,
  normalizeRoom,
  normalizeNickname,
  cleanText,
  clampNumber,
  normalizePosition,
  isGiphyUrl,
  decodeMedia,
} = require('./validate');

const PROTOCOL_VERSION = 3;

const DEFAULT_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxVideoBytes: 20 * 1024 * 1024,
  maxSoundBytes: 3 * 1024 * 1024,
  maxClipMs: 60_000, // "play the whole clip" videos/sounds stop after this
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
  reactionsPerWindow: 12,
  reactionWindowMs: 10_000,
});

// Skip a recipient whose connection is this backed up rather than buffering forever.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

const KIND_LABEL = { image: 'an image', gif: 'a GIF', video: 'a video', sound: 'a sound', text: 'a message' };
const DROP_KINDS = Object.keys(KIND_LABEL);
const KIND_ERROR = { image: 'bad_image', video: 'bad_video', sound: 'bad_sound' };
const HEARTBEAT_MS = 30_000;

/**
 * Attach the MemeDrop relay to an existing http.Server.
 *
 * Wire protocol (JSON text frames):
 *   client → server
 *     { type: 'join', room, nickname }
 *     { type: 'drop', ref?, to, kind: 'image', data: <base64>, opacity, durationMs, position, sound? }
 *     { type: 'drop', ref?, to, kind: 'video', data: <base64>, videoSound, opacity, durationMs, position, sound? }
 *     { type: 'drop', ref?, to, kind: 'gif', url, width?, height?, title?, opacity, durationMs, position, sound? }
 *     { type: 'drop', ref?, to, kind: 'text', text, color?, opacity, durationMs, position, sound? }
 *     { type: 'drop', ref?, to, kind: 'sound', sound, durationMs }
 *       to:         'all' | <peerId> | [<peerId>, ...]
 *       sound:      { type: 'builtin', id } | { type: 'file', data: <base64 mp3/wav/ogg/m4a>, name? }
 *       durationMs: 1000–15000, or 0 for video/sound = "play the whole clip" (max maxClipMs)
 *       effect?:    'pop' | 'slide' | 'bounce' | 'shake' | 'spin' | 'zoom' | 'none'
 *       caption?:   { top?, bottom? } meme text on images, GIFs and videos
 *       text:       up to 140 characters; color: white | yellow | pink | cyan | lime | orange
 *       rain?:      true = fill the screen with falling copies (text of 20 characters or fewer)
 *     { type: 'react', to: <peerId>, emoji, dropId? }    (emoji from REACTIONS)
 *     { type: 'gif-search', reqId, query, offset? }
 *     { type: 'gif-trending', reqId, offset? }
 *     { type: 'leave' }
 *   server → client
 *     { type: 'welcome', protocol, id, room, nickname, peers, limits, features }
 *     { type: 'features', features: { giphy } }           (GIF search switched on/off)
 *     { type: 'roster', peers: [{ id, nickname }] }      (everyone in the room, including you)
 *     { type: 'drop', dropId, from: { id, nickname }, kind, ... }
 *     { type: 'drop-sent', ref, dropId, delivered, to }
 *     { type: 'reaction', from: { id, nickname }, emoji, dropId }
 *     { type: 'gif-results', reqId, mode, query, items, nextOffset, total }
 *     { type: 'error', code, message, ref?, reqId? }
 */
function createRelay({ server, limits: limitOverrides = {}, giphy = null, log = defaultLog } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  // Leave headroom over the biggest allowed drop (base64 + JSON) so oversized
  // files get a friendly error instead of a dropped connection.
  const biggestDrop = Math.max(limits.maxImageBytes, limits.maxVideoBytes) + limits.maxSoundBytes;
  const maxPayload = Math.ceil((biggestDrop * 4) / 3) + 512 * 1024;

  const wss = new WebSocketServer({ server, maxPayload, perMessageDeflate: false });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE). Without a listener
  // that would be an uncaught exception; startServer() reports it instead.
  wss.on('error', (err) => log('debug', `websocket server error: ${err.message}`));
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
      reactLimiter: createRateLimiter({ limit: limits.reactionsPerWindow, windowMs: limits.reactionWindowMs }),
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
      const crashed = (err) => {
        log('error', `handler crashed on "${msg.type}": ${err && err.stack ? err.stack : err}`);
        sendError(client, 'server_error', 'Something went wrong on the server.', msg);
      };
      try {
        const result = handleMessage(client, msg);
        // Async handlers (GIF search) must never become unhandled rejections —
        // those would take the whole server down.
        if (result && typeof result.catch === 'function') result.catch(crashed);
      } catch (err) {
        crashed(err);
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
      case 'react':
        return handleReact(client, msg);
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

    const target = resolveRecipients(client, msg.to);
    if (target.error) return sendError(client, 'peer_not_found', target.error, msg);

    const kind = msg.kind;
    if (!DROP_KINDS.includes(kind)) {
      return sendError(client, 'bad_message', 'Unknown drop kind.', msg);
    }

    // Optional sound for visual drops; required for sound-only drops.
    const sound = parseSound(msg.sound, kind === 'sound');
    if (sound.error) return sendError(client, 'bad_sound', sound.error, msg);

    const clipAllowed = kind === 'video' || kind === 'sound';
    const wantsFullClip = clipAllowed && (Number(msg.durationMs) === 0 || (kind === 'sound' && msg.durationMs === undefined));
    const base = {
      type: 'drop',
      dropId: crypto.randomBytes(6).toString('hex'),
      from: { id: client.id, nickname: client.nickname },
      kind,
      opacity: round2(clampNumber(msg.opacity, limits.minOpacity, limits.maxOpacity, 1)),
      durationMs: wantsFullClip
        ? 0
        : Math.round(clampNumber(msg.durationMs, limits.minDurationMs, limits.maxDurationMs, limits.defaultDurationMs)),
      position: normalizePosition(msg.position),
      effect: normalizeEffect(msg.effect),
      sound: sound.value,
      sentAt: Date.now(),
    };
    const caption = kind === 'sound' || kind === 'text' ? null : normalizeCaption(msg.caption);
    if (caption) base.caption = caption;

    let outgoing;
    if (kind === 'image' || kind === 'video') {
      const maxBytes = kind === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;
      const media = decodeMedia(msg.data, { kind, maxBytes });
      if (media.error) return sendError(client, KIND_ERROR[kind], media.error, msg);
      outgoing = { ...base, mime: media.mime, data: media.base64 };
      if (kind === 'video') outgoing.videoSound = msg.videoSound !== false;
    } else if (kind === 'gif') {
      if (!isGiphyUrl(msg.url)) {
        return sendError(client, 'bad_gif', 'Only GIPHY links can be sent as GIFs.', msg);
      }
      outgoing = {
        ...base,
        url: msg.url,
        width: optionalDimension(msg.width),
        height: optionalDimension(msg.height),
        title: cleanText(msg.title, 100),
      };
    } else if (kind === 'text') {
      const text = cleanText(msg.text, MAX_TEXT_LENGTH);
      if (!text) return sendError(client, 'bad_text', 'Type a message to drop.', msg);
      outgoing = { ...base, text, color: normalizeTextColor(msg.color) };
      if (msg.rain === true && canRain(text)) outgoing.rain = true;
    } else {
      outgoing = base; // sound only
    }

    const payload = JSON.stringify(outgoing);
    let delivered = 0;
    for (const peer of target.recipients) {
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      peer.ws.send(payload);
      delivered += 1;
    }

    send(client, {
      type: 'drop-sent',
      ref: msg.ref,
      dropId: outgoing.dropId,
      kind,
      to: typeof msg.to === 'string' ? msg.to : target.recipients.map((r) => r.id),
      delivered,
    });
    log('info', `${client.nickname} dropped ${KIND_LABEL[kind]} on ${target.label} in ${client.room} (${delivered} delivered)`);
    return undefined;
  }

  function handleReact(client, msg) {
    if (!client.room) return sendError(client, 'not_joined', 'Join a room first.', msg);
    if (!client.reactLimiter.take()) {
      return sendError(client, 'rate_limited', 'Easy on the reactions!', msg);
    }
    if (!REACTIONS.includes(msg.emoji)) return sendError(client, 'bad_message', 'Unknown reaction.', msg);
    const peer = typeof msg.to === 'string' ? rooms.get(client.room).get(msg.to) : null;
    if (!peer || peer === client) {
      return sendError(client, 'peer_not_found', "They're not in the room anymore.", msg);
    }
    const dropId = typeof msg.dropId === 'string' && /^[a-f0-9]{1,32}$/.test(msg.dropId) ? msg.dropId : null;
    send(peer, { type: 'reaction', from: { id: client.id, nickname: client.nickname }, emoji: msg.emoji, dropId });
    return undefined;
  }

  /** 'all', one peer id, or a list of peer ids → the matching people in the sender's room. */
  function resolveRecipients(client, to) {
    const members = rooms.get(client.room);
    if (to === 'all') {
      return { recipients: [...members.values()].filter((c) => c.id !== client.id), label: 'everyone' };
    }
    const ids = typeof to === 'string' ? [to] : Array.isArray(to) ? to : [];
    if (ids.length > limits.maxRoomSize) return { error: 'Too many people picked.' };
    const unique = [...new Set(ids.filter((id) => typeof id === 'string'))];
    const recipients = unique.map((id) => members.get(id)).filter((c) => c && c.id !== client.id);
    if (recipients.length === 0) {
      return { error: unique.length > 1 ? "Those friends aren't in the room anymore." : "That friend isn't in the room anymore." };
    }
    return { recipients, label: recipients.map((c) => c.nickname).join(', ') };
  }

  function parseSound(sound, required) {
    if (sound === undefined || sound === null || sound === false) {
      return required ? { error: 'Pick a sound to play.' } : { value: null };
    }
    if (typeof sound !== 'object') return { error: 'Unknown sound.' };
    if (sound.type === 'builtin') {
      if (!BUILTIN_SOUNDS.includes(sound.id)) return { error: 'Unknown sound.' };
      return { value: { type: 'builtin', id: sound.id } };
    }
    if (sound.type === 'file') {
      const audio = decodeMedia(sound.data, { kind: 'audio', maxBytes: limits.maxSoundBytes });
      if (audio.error) return { error: audio.error };
      return { value: { type: 'file', mime: audio.mime, data: audio.base64, name: cleanText(sound.name, 60) } };
    }
    return { error: 'Unknown sound.' };
  }

  async function handleGif(client, msg) {
    const reqId = msg.reqId;
    if (!client.room) return sendError(client, 'not_joined', 'Join a room first.', msg);
    if (!giphy) {
      return sendError(client, 'giphy_disabled', "GIF search isn't set up yet. The host can add a free GIPHY key in Settings.", msg);
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
      maxVideoBytes: limits.maxVideoBytes,
      maxSoundBytes: limits.maxSoundBytes,
      maxClipMs: limits.maxClipMs,
      minDurationMs: limits.minDurationMs,
      maxDurationMs: limits.maxDurationMs,
      minOpacity: limits.minOpacity,
      maxOpacity: limits.maxOpacity,
      imageTypes: ALLOWED_IMAGE_MIMES,
      videoTypes: ALLOWED_VIDEO_MIMES,
      audioTypes: ALLOWED_AUDIO_MIMES,
      sounds: BUILTIN_SOUNDS,
      positions: POSITIONS,
    };
  }

  /** Turn GIF search on/off while running (e.g. the host pasted a GIPHY key). */
  function setGiphy(next) {
    giphy = next || null;
    const msg = { type: 'features', features: { giphy: Boolean(giphy) } };
    for (const c of clients) if (c.room) send(c, msg);
  }

  function stats() {
    let people = 0;
    for (const members of rooms.values()) people += members.size;
    return { rooms: rooms.size, people };
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

  return { wss, rooms, limits, close, setGiphy, stats };
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
