'use strict';

/**
 * Invite links. A host shares a normal web link like
 *
 *   https://lucky-otter-tree.trycloudflare.com/join/PIZZA-4821
 *   http://192.168.1.20:8787/join/PIZZA-4821
 *
 * which opens a landing page in a browser, or can be pasted straight into
 * MemeDrop. The landing page's button uses memedrop://join?link=<that link>.
 */

const { normalizeServerUrl, normalizeRoom } = require('./validate');

/** Build the invite link for a room from the server's http(s) base URL. */
function buildInviteLink(httpBase, room) {
  return `${String(httpBase).replace(/\/+$/, '')}/join/${encodeURIComponent(room)}`;
}

/**
 * Work out { serverUrl, room, link } from anything a friend might paste:
 * an invite link, a memedrop:// link, or a message that contains one.
 * Returns null if there's no usable invite in it.
 */
function parseInvite(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const match = /(memedrop:\/\/\S+|https?:\/\/\S+)/i.exec(text);
  if (!match) return null;
  const candidate = match[1].replace(/[)>\].,!?'"]+$/, ''); // trailing punctuation from chat messages

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === 'memedrop:') {
    const link = url.searchParams.get('link');
    if (link) return parseInvite(link);
    const server = url.searchParams.get('server');
    const room = normalizeRoom(url.searchParams.get('room') || '');
    const serverUrl = server && normalizeServerUrl(server);
    if (!serverUrl || !room) return null;
    return { serverUrl, room, link: null };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const m = /^(.*?)\/join\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  const room = normalizeRoom(decodeURIComponent(m[2]));
  if (!room) return null;
  const base = `${url.protocol}//${url.host}${m[1]}`;
  const serverUrl = normalizeServerUrl(base);
  if (!serverUrl) return null;
  return { serverUrl, room, link: buildInviteLink(base, room) };
}

/** A random, easy-to-say room name like "TACO-4821". */
function randomRoomName(random = Math.random) {
  const words = [
    'TACO', 'PIZZA', 'NOODLE', 'WAFFLE', 'PICKLE', 'MANGO', 'DONUT', 'BURRITO', 'NACHO', 'PRETZEL',
    'GOBLIN', 'LLAMA', 'OTTER', 'PANDA', 'GECKO', 'WALRUS', 'MOOSE', 'TOAD', 'FERRET', 'NARWHAL',
    'COMET', 'ROCKET', 'PIXEL', 'TURBO', 'BANANA', 'CHEESE', 'YETI', 'KRAKEN', 'GOOSE', 'POTATO',
  ];
  const word = words[Math.floor(random() * words.length)];
  const num = String(1000 + Math.floor(random() * 9000));
  return `${word}-${num}`;
}

module.exports = { buildInviteLink, parseInvite, randomRoomName };
