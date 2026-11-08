'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInviteLink, parseInvite, randomRoomName } = require('../src/shared/invite');
const Hotkey = require('../src/shared/hotkey');
const Sounds = require('../src/shared/sounds');
const V = require('../src/shared/validate');

test('invite links round-trip', () => {
  const link = buildInviteLink('https://lucky-otter.trycloudflare.com/', 'PIZZA-4821');
  assert.equal(link, 'https://lucky-otter.trycloudflare.com/join/PIZZA-4821');
  assert.deepEqual(parseInvite(link), {
    serverUrl: 'wss://lucky-otter.trycloudflare.com/',
    room: 'PIZZA-4821',
    link,
  });
});

test('parseInvite understands everything a friend might paste', () => {
  const lan = parseInvite('http://192.168.1.20:8787/join/taco-1234');
  assert.equal(lan.serverUrl, 'ws://192.168.1.20:8787/');
  assert.equal(lan.room, 'TACO-1234');
  assert.equal(lan.link, 'http://192.168.1.20:8787/join/TACO-1234');

  const chat = parseInvite('yo join my memedrop https://a-b-c.trycloudflare.com/join/GOOSE-1111!!');
  assert.equal(chat.room, 'GOOSE-1111');
  assert.equal(chat.serverUrl, 'wss://a-b-c.trycloudflare.com/');

  const deep = parseInvite(`memedrop://join?link=${encodeURIComponent('https://x-y.trycloudflare.com/join/YETI-2000')}`);
  assert.equal(deep.room, 'YETI-2000');
  assert.equal(deep.serverUrl, 'wss://x-y.trycloudflare.com/');

  const direct = parseInvite('memedrop://join?server=ws://10.0.0.5:8787&room=moose');
  assert.deepEqual(direct, { serverUrl: 'ws://10.0.0.5:8787/', room: 'MOOSE', link: null });

  for (const bad of ['', 'hello', 'https://example.com/', 'https://example.com/join/', 'https://example.com/join/bad%20room', 'ftp://x/join/A', 'memedrop://join', 42]) {
    assert.equal(parseInvite(bad), null, String(bad));
  }
});

test('random room names are valid room codes', () => {
  for (let i = 0; i < 50; i += 1) {
    const name = randomRoomName();
    assert.match(name, /^[A-Z]+-\d{4}$/);
    assert.equal(V.normalizeRoom(name), name);
  }
});

const key = (code, mods = {}) => ({ key: code.replace(/^Key/, '').toLowerCase(), code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('recording a panic hotkey from key presses', () => {
  assert.deepEqual(Hotkey.eventToAccelerator(key('KeyX', { ctrlKey: true, shiftKey: true })), { accelerator: 'Control+Shift+X' });
  assert.deepEqual(Hotkey.eventToAccelerator(key('KeyP', { altKey: true })), { accelerator: 'Alt+P' });
  assert.deepEqual(Hotkey.eventToAccelerator(key('Digit9', { ctrlKey: true, altKey: true })), { accelerator: 'Control+Alt+9' });
  assert.deepEqual(Hotkey.eventToAccelerator(key('F9')), { accelerator: 'F9' }, 'F-keys work alone');
  assert.deepEqual(Hotkey.eventToAccelerator(key('ArrowUp', { ctrlKey: true })), { accelerator: 'Control+Up' });
  assert.deepEqual(Hotkey.eventToAccelerator(key('Backquote', { ctrlKey: true })), { accelerator: 'Control+`' });
  assert.deepEqual(Hotkey.eventToAccelerator({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), { pending: true });
  assert.match(Hotkey.eventToAccelerator(key('KeyX')).error, /Ctrl or Alt/);
  assert.match(Hotkey.eventToAccelerator(key('KeyX', { shiftKey: true })).error, /Ctrl or Alt/, 'Shift alone would break typing capitals');
  assert.match(Hotkey.eventToAccelerator(key('Delete', { ctrlKey: true, altKey: true })).error, /Windows/);
  assert.ok(Hotkey.eventToAccelerator(key('IntlRo', { ctrlKey: true })).error);
});

test('hotkey labels and sanity checks', () => {
  assert.equal(Hotkey.acceleratorLabel('CommandOrControl+Shift+X', 'win32'), 'Ctrl+Shift+X');
  assert.equal(Hotkey.acceleratorLabel('CommandOrControl+Shift+X', 'darwin'), 'Cmd+Shift+X');
  assert.equal(Hotkey.acceleratorLabel('Control+Super+num5', 'win32'), 'Ctrl+Win+Num 5');
  for (const ok of ['CommandOrControl+Shift+X', 'Control+Alt+P', 'F9', 'Alt+F4', 'Control+`', 'Control+Shift+num0']) {
    assert.ok(Hotkey.isPlausibleAccelerator(ok), ok);
  }
  for (const bad of ['X', 'Shift+X', 'Control+', 'Control+Banana', 'Hyper+X', '', 'Control+Alt+Shift+Super+Meta+X', 42]) {
    assert.ok(!Hotkey.isPlausibleAccelerator(bad), String(bad));
  }
  assert.ok(Hotkey.isPlausibleAccelerator(Hotkey.DEFAULT_HOTKEY));
});

test('built-in sounds match what the server accepts', () => {
  assert.deepEqual([...Sounds.ids].sort(), [...V.BUILTIN_SOUNDS].sort());
  for (const s of Sounds.SOUNDS) {
    assert.ok(s.label && s.emoji, s.id);
    assert.equal(Sounds.info(s.id), s);
  }
  assert.equal(Sounds.info('nope'), null);
});
