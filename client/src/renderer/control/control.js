'use strict';

/* MemeDrop control window: host or join a room, pick friends, pick something to drop, drop it. */
(() => {
  const api = window.memedrop;
  const Sounds = window.MemeDropSounds;
  const Hotkey = window.MemeDropHotkey;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const els = {
    views: { welcome: $('welcome-view'), host: $('host-view'), join: $('join-view'), main: $('main-view') },
    // host
    hostForm: $('host-form'),
    hostNickname: $('host-nickname'),
    hostRoom: $('host-room'),
    hostDice: $('host-dice'),
    hostError: $('host-error'),
    hostStart: $('host-start'),
    hostProgress: $('host-progress'),
    hostStep: $('host-step'),
    hostBar: $('host-bar'),
    hostCancel: $('host-cancel'),
    // join
    joinForm: $('join-form'),
    joinNickname: $('join-nickname'),
    joinInvite: $('join-invite'),
    joinPaste: $('join-paste'),
    joinAdvanced: $('join-advanced'),
    serverUrl: $('server-url'),
    room: $('room'),
    joinError: $('join-error'),
    joinBtn: $('join-btn'),
    // main
    statusDot: $('status-dot'),
    roomCode: $('room-code'),
    meLine: $('me-line'),
    inviteBtn: $('invite-btn'),
    muteBtn: $('mute-btn'),
    clearBtn: $('clear-btn'),
    leaveBtn: $('leave-btn'),
    banners: $('banners'),
    targets: $('targets'),
    aloneHint: $('alone-hint'),
    aloneInvite: $('alone-invite'),
    tabs: $$('.tab'),
    panels: { upload: $('panel-upload'), gifs: $('panel-gifs'), text: $('panel-text'), sounds: $('panel-sounds') },
    inboxBtn: $('inbox-btn'),
    inboxBadge: $('inbox-badge'),
    inbox: $('inbox'),
    inboxClose: $('inbox-close'),
    inboxList: $('inbox-list'),
    inboxEmpty: $('inbox-empty'),
    textInput: $('text-input'),
    textColors: $('text-colors'),
    textCount: $('text-count'),
    textPreview: $('text-preview'),
    effectSelect: $('effect-select'),
    captionToggle: $('caption-toggle'),
    captionInputs: $('caption-inputs'),
    captionTop: $('caption-top'),
    captionBottom: $('caption-bottom'),
    mutedFriends: $('muted-friends'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    dzEmpty: $('dz-empty'),
    dzPreview: $('dz-preview'),
    dzMedia: $('dz-media'),
    dzLimits: $('dz-limits'),
    uploadName: $('upload-name'),
    uploadSize: $('upload-size'),
    uploadClear: $('upload-clear'),
    gifSetup: $('gif-setup'),
    gifBrowser: $('gif-browser'),
    gifForm: $('gif-search-form'),
    gifQuery: $('gif-query'),
    gifHeading: $('gif-heading'),
    gifBack: $('gif-back'),
    gifScroll: $('gif-scroll'),
    gifGrid: $('gif-grid'),
    gifStatus: $('gif-status'),
    gifMore: $('gif-more'),
    giphyLink: $('giphy-link'),
    soundboard: $('soundboard'),
    soundInput: $('sound-input'),
    opacity: $('opacity'),
    opacityOut: $('opacity-out'),
    duration: $('duration'),
    durationOut: $('duration-out'),
    position: $('position'),
    soundSelect: $('sound-select'),
    soundTest: $('sound-test'),
    videoOptions: $('video-options'),
    videoSound: $('video-sound'),
    videoFull: $('video-full'),
    summary: $('selection-summary'),
    previewBtn: $('preview-btn'),
    sendBtn: $('send-btn'),
    // settings
    settings: $('settings'),
    settingsClose: $('settings-close'),
    themeList: $('theme-list'),
    hotkeyKeys: $('hotkey-keys'),
    hotkeyChange: $('hotkey-change'),
    hotkeyReset: $('hotkey-reset'),
    hotkeyMsg: $('hotkey-msg'),
    soundsEnabled: $('sounds-enabled'),
    soundVolume: $('sound-volume'),
    soundVolumeOut: $('sound-volume-out'),
    soundVolumeTest: $('sound-volume-test'),
    giphySettings: $('giphy-settings'),
    settingsMuted: $('settings-muted'),
    about: $('about'),
    toast: $('toast'),
  };

  const THEME_NAMES = {
    bubblegum: 'Bubblegum',
    ocean: 'Ocean',
    lime: 'Lime',
    sunset: 'Sunset',
    mono: 'Midnight',
    light: 'Light',
  };
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'];
  const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac'];
  const DEFAULT_LIMITS = { maxImageBytes: 5 * 1048576, maxVideoBytes: 20 * 1048576, maxSoundBytes: 3 * 1048576 };
  const GIPHY_SIGNUP = 'https://developers.giphy.com/dashboard/';

  const ui = {
    view: 'welcome',
    conn: null,
    settings: {},
    version: '',
    platform: 'win32',
    suggestedRoom: '',
    tab: 'upload',
    targets: new Set(), // empty = everyone
    upload: null, // { kind: 'image'|'video', bytes, name, size, url }
    gif: null,
    gifMode: 'trending',
    gifQuery: '',
    gifItems: [],
    gifNextOffset: null,
    gifSeq: 0,
    gifLoadedOnce: false,
    soundPick: null, // Sounds tab: builtin id or 'custom'
    attachSound: '', // Upload/GIF tabs: '' | builtin id | 'custom'
    customSound: null, // { bytes, name, size, url }
    pendingSoundTarget: null,
    position: 'random',
    sending: false,
    recording: false,
    leaveArmed: null,
    textColor: 'white',
    inbox: [], // newest first: { key, from, fromId, dropId, kind, text, at, reacted }
    unread: 0,
  };

  const TEXT_COLORS = { white: '#ffffff', yellow: '#ffe14d', pink: '#ff5fb4', cyan: '#4de8ff', lime: '#9dff4d', orange: '#ff9a3d' };
  const REACTIONS = ['😂', '🔥', '💀', '😭', '❤️', '👍', '😮', '🤡'];
  const KIND_WORDS = { gif: 'a GIF', video: 'a video', sound: 'a sound', image: 'a meme', text: 'a message' };

  // ================================================================ helpers

  function formatBytes(bytes) {
    if (bytes >= 1048576) return `${+(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function limits() {
    return { ...DEFAULT_LIMITS, ...((ui.conn && ui.conn.limits) || {}) };
  }

  function isConnected() {
    return Boolean(ui.conn && ui.conn.status === 'connected');
  }

  function isHosting() {
    return Boolean(ui.conn && ui.conn.role === 'host');
  }

  function otherPeers() {
    if (!ui.conn) return [];
    return (ui.conn.peers || [])
      .filter((p) => p.id !== ui.conn.selfId)
      .sort((a, b) => a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base' }));
  }

  function hueFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c);
    return node;
  }

  /** ["plain", ["strong", "bold"], ...] → fragment (never innerHTML with user text). */
  function rich(parts) {
    const frag = document.createDocumentFragment();
    for (const part of parts) frag.append(typeof part === 'string' ? part : el(part[0], { text: part[1] }));
    return frag;
  }

  let toastTimer = null;
  function toast(text, kind = 'info') {
    if (!text) return;
    els.toast.textContent = text;
    els.toast.className = `toast ${kind}`;
    els.toast.hidden = false;
    void els.toast.offsetWidth;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, kind === 'error' ? 4500 : 2800);
  }

  function showError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function randomRoomName() {
    const words = ['TACO', 'PIZZA', 'NOODLE', 'WAFFLE', 'PICKLE', 'MANGO', 'DONUT', 'NACHO', 'GOBLIN', 'LLAMA', 'OTTER', 'PANDA', 'GECKO', 'WALRUS', 'MOOSE', 'COMET', 'ROCKET', 'PIXEL', 'TURBO', 'BANANA', 'YETI', 'KRAKEN', 'GOOSE', 'POTATO'];
    return `${words[Math.floor(Math.random() * words.length)]}-${1000 + Math.floor(Math.random() * 9000)}`;
  }

  function cleanRoomInput(input) {
    input.addEventListener('input', () => {
      const cleaned = input.value.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9_-]/g, '');
      if (cleaned !== input.value) input.value = cleaned;
    });
  }

  function applyTheme(theme) {
    const t = THEME_NAMES[theme] ? theme : 'bubblegum';
    if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
    for (const sw of $$('.theme-swatch', els.themeList)) sw.setAttribute('aria-checked', String(sw.dataset.theme === t));
  }

  // ============================================================== routing

  function showView(name) {
    if (ui.view === name && !els.views[name].hidden) return;
    ui.view = name;
    for (const [key, node] of Object.entries(els.views)) node.hidden = key !== name;
    if (name === 'host') onShowHost();
    if (name === 'join') onShowJoin();
  }

  function applyState(s) {
    const prev = ui.conn;
    ui.conn = s;
    applyTheme(s.theme);

    const inRoom = s.status !== 'disconnected';
    const hostStarting = s.role === 'host' && s.host && s.host.status === 'starting';

    if (inRoom) {
      showView('main');
    } else if (hostStarting) {
      showView('host');
    } else if (ui.view === 'main') {
      if (s.error && s.role === 'join') {
        showView('join');
        showError(els.joinError, s.error);
      } else {
        showView('welcome');
      }
    } else if (ui.view === 'join' && s.error && prev && prev.status !== 'disconnected') {
      showError(els.joinError, s.error);
    }

    renderHostProgress();
    if (inRoom) renderMain(prev);
    renderSettings();
    renderInbox();
  }

  // ======================================================== welcome / host

  $('go-host').addEventListener('click', () => showView('host'));
  $('go-join').addEventListener('click', () => showView('join'));
  for (const b of $$('[data-back]')) b.addEventListener('click', () => showView('welcome'));

  function onShowHost() {
    showError(els.hostError, '');
    if (!els.hostNickname.value) els.hostNickname.value = ui.settings.nickname || '';
    if (!els.hostRoom.value) els.hostRoom.value = ui.settings.hostRoom || ui.suggestedRoom || randomRoomName();
    const mode = ui.settings.hostMode === 'lan' ? 'lan' : 'internet';
    const radio = els.hostForm.querySelector(`input[name="host-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    (els.hostNickname.value ? els.hostStart : els.hostNickname).focus();
  }

  els.hostDice.addEventListener('click', () => {
    els.hostRoom.value = randomRoomName();
  });
  cleanRoomInput(els.hostRoom);

  els.hostForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(els.hostError, '');
    els.hostStart.disabled = true;
    const mode = els.hostForm.querySelector('input[name="host-mode"]:checked').value;
    const res = await api.hostRoom({ nickname: els.hostNickname.value, room: els.hostRoom.value, mode });
    els.hostStart.disabled = false;
    if (res.ok) {
      ui.settings.nickname = els.hostNickname.value.trim();
      ui.settings.hostRoom = els.hostRoom.value;
      ui.settings.hostMode = mode;
      if (res.inviteLink) {
        await api.copyText(res.inviteLink);
        toast('Your room is live! Invite link copied — paste it to your friends.', 'success');
      }
    } else if (!res.cancelled) {
      if (ui.view !== 'host') showView('host');
      showError(els.hostError, res.error);
    }
  });

  els.hostCancel.addEventListener('click', () => api.leaveRoom());

  function renderHostProgress() {
    const h = ui.conn && ui.conn.host;
    const starting = Boolean(ui.conn && ui.conn.role === 'host' && h && h.status === 'starting');
    els.hostProgress.hidden = !starting;
    els.hostForm.hidden = starting;
    if (!starting) return;
    els.hostStep.textContent = h.step || 'Starting your room…';
    const hasProgress = typeof h.progress === 'number';
    els.hostBar.hidden = !hasProgress;
    if (hasProgress) els.hostBar.firstElementChild.style.width = `${Math.round(h.progress * 100)}%`;
  }

  // ================================================================== join

  async function onShowJoin() {
    if (!els.joinNickname.value) els.joinNickname.value = ui.settings.nickname || '';
    if (!els.serverUrl.value) els.serverUrl.value = ui.settings.serverUrl || '';
    if (!els.room.value) els.room.value = ui.settings.room || '';
    els.joinPaste.hidden = true;
    (els.joinNickname.value ? els.joinInvite : els.joinNickname).focus();
    if (!els.joinInvite.value) {
      const fromClipboard = await api.inviteFromClipboard();
      if (fromClipboard && !els.joinInvite.value) {
        els.joinPaste.hidden = false;
        els.joinPaste.textContent = `📋 Use the invite you copied (${fromClipboard.room})`;
        els.joinPaste.dataset.link = fromClipboard.link;
      }
    }
  }

  els.joinPaste.addEventListener('click', () => {
    els.joinInvite.value = els.joinPaste.dataset.link || '';
    els.joinPaste.hidden = true;
    (els.joinNickname.value ? els.joinBtn : els.joinNickname).focus();
  });
  cleanRoomInput(els.room);

  els.joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(els.joinError, '');
    const invite = els.joinInvite.value.trim();
    const advanced = !invite && els.joinAdvanced.open;
    if (!invite && !advanced) {
      showError(els.joinError, 'Paste the invite link your friend sent you.');
      els.joinInvite.focus();
      return;
    }
    els.joinBtn.disabled = true;
    const res = await api.joinRoom(
      advanced
        ? { nickname: els.joinNickname.value, serverUrl: els.serverUrl.value, room: els.room.value }
        : { nickname: els.joinNickname.value, invite },
    );
    els.joinBtn.disabled = false;
    if (res.ok) ui.settings.nickname = els.joinNickname.value.trim();
    else showError(els.joinError, res.error);
  });

  // ================================================================== main

  function renderMain(prev) {
    const s = ui.conn;
    els.statusDot.dataset.status = s.status;
    els.roomCode.textContent = s.room || '—';
    const others = otherPeers();
    if (s.status === 'connected') {
      const online = others.length === 0 ? 'just you so far' : `${others.length + 1} people here`;
      els.meLine.textContent = `${isHosting() ? '🏠 Host' : 'You'}: ${s.nickname} · ${online}`;
    } else {
      els.meLine.textContent = s.status === 'connecting' ? 'connecting…' : 'reconnecting…';
    }
    els.inviteBtn.hidden = !s.inviteLink;
    els.muteBtn.setAttribute('aria-pressed', String(Boolean(s.muted)));
    els.muteBtn.title = s.muted ? 'Unmute incoming memes' : 'Mute incoming memes';
    els.clearBtn.title = s.hotkey && s.hotkey.ok ? `Clear my screen (${s.hotkey.label})` : 'Clear my screen';
    els.leaveBtn.title = isHosting() ? 'Close the room' : 'Leave room';
    const l = limits();
    els.dzLimits.textContent = `Images: PNG, JPG, GIF, WebP up to ${formatBytes(l.maxImageBytes)} · Videos: MP4, WebM up to ${formatBytes(l.maxVideoBytes)}`;

    renderTargets();
    renderBanners();
    renderGifAvailability();
    updateSummary();

    const justConnected = s.status === 'connected' && (!prev || prev.status !== 'connected');
    const giphyChanged = prev && prev.features && s.features && prev.features.giphy !== s.features.giphy;
    if (justConnected || giphyChanged) {
      ui.gifLoadedOnce = false;
      if (ui.tab === 'gifs') loadGifs();
    }
  }

  function renderBanners() {
    const s = ui.conn;
    const list = [];
    if (s.status === 'connecting') list.push({ kind: 'info', text: 'Connecting to the room…' });
    if (s.status === 'reconnecting') list.push({ kind: 'warn', text: s.error || 'Lost the connection. Reconnecting…' });
    if (isHosting() && s.host && s.host.status === 'error') {
      list.push({ kind: 'error', text: s.host.error, action: { label: 'Restart room', run: restartRoom } });
    }
    if (s.muted) {
      list.push({ kind: 'warn', text: "Muted: memes from friends won't show up.", action: { label: 'Unmute', run: () => api.setMuted(false) } });
    }
    if (s.hotkey && !s.hotkey.ok && !ui.recording) {
      list.push({
        kind: 'warn',
        text: `${s.hotkey.label} is taken by another app. Pick a different panic key in Settings.`,
        action: { label: 'Settings', run: openSettings },
      });
    }
    els.banners.replaceChildren(
      ...list.map((b) =>
        el('div', { class: `banner ${b.kind}` }, [
          el('span', { class: 'banner-text', text: b.text }),
          b.action ? el('button', { type: 'button', text: b.action.label, onclick: b.action.run }) : null,
        ]),
      ),
    );
  }

  async function restartRoom() {
    const res = await api.restartRoom();
    if (res.ok && res.inviteLink) {
      await api.copyText(res.inviteLink);
      toast('Room restarted. New invite link copied — send it to your friends again.', 'success');
    } else if (!res.ok && !res.cancelled) {
      toast(res.error, 'error');
    }
  }

  function renderTargets() {
    const peers = otherPeers();
    const present = new Set(peers.map((p) => p.id));
    const gone = [...ui.targets].filter((id) => !present.has(id));
    if (gone.length) {
      for (const id of gone) ui.targets.delete(id);
      if (isConnected()) toast(ui.targets.size ? 'Someone you picked left the room.' : 'The friend you picked left. Sending to everyone.');
    }

    const chips = [chip('all', 'Everyone', null, ui.targets.size === 0)];
    for (const p of peers) chips.push(chip(p.id, p.nickname, p.nickname, ui.targets.has(p.id)));
    els.targets.replaceChildren(...chips);

    const alone = isConnected() && peers.length === 0;
    els.aloneHint.hidden = !alone || !ui.conn.inviteLink;
  }

  function chip(id, label, avatarName, pressed) {
    const children = [];
    if (avatarName) {
      const av = el('span', { class: 'avatar', text: [...avatarName.trim()][0].toUpperCase() });
      av.style.setProperty('--avatar', `hsl(${hueFor(avatarName)} 60% 50%)`);
      children.push(av);
    }
    children.push(el('span', { class: 'chip-label', text: label }));
    const muted = Boolean(avatarName) && isMutedName(avatarName);
    if (muted) children.push(el('span', { class: 'chip-muted', text: '🔇', 'aria-label': '(muted)' }));
    return el(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(pressed),
        'data-id': id,
        title:
          id === 'all'
            ? 'Drop it on everyone in the room'
            : `Pick ${label} (click more names to pick several)${muted ? `. You muted ${label}, so you won't see their drops.` : ''}`,
        onclick: () => {
          if (id === 'all') ui.targets.clear();
          else if (ui.targets.has(id)) ui.targets.delete(id);
          else ui.targets.add(id);
          renderTargets();
          updateSummary();
        },
      },
      children,
    );
  }

  function targetLabel() {
    if (ui.targets.size === 0) return 'Everyone';
    const names = otherPeers()
      .filter((p) => ui.targets.has(p.id))
      .map((p) => p.nickname);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  }

  async function copyInvite() {
    const link = ui.conn && ui.conn.inviteLink;
    if (!link) return;
    await api.copyText(link);
    toast('Invite link copied! Paste it to your friends in Discord, text, anywhere.', 'success');
  }

  els.inviteBtn.addEventListener('click', copyInvite);
  els.aloneInvite.addEventListener('click', copyInvite);
  els.muteBtn.addEventListener('click', () => api.setMuted(!(ui.conn && ui.conn.muted)));
  els.clearBtn.addEventListener('click', async () => {
    await api.clearScreen();
    toast('Screen cleared.');
  });

  els.leaveBtn.addEventListener('click', async () => {
    if (isHosting() && otherPeers().length > 0 && !ui.leaveArmed) {
      els.leaveBtn.classList.add('confirm');
      toast('Click again to close the room for everyone.');
      ui.leaveArmed = setTimeout(() => {
        ui.leaveArmed = null;
        els.leaveBtn.classList.remove('confirm');
      }, 3500);
      return;
    }
    clearTimeout(ui.leaveArmed);
    ui.leaveArmed = null;
    els.leaveBtn.classList.remove('confirm');
    await api.leaveRoom();
  });

  // ================================================================== tabs

  function switchTab(name) {
    ui.tab = name;
    for (const tab of els.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const [key, panel] of Object.entries(els.panels)) panel.hidden = key !== name;
    for (const row of $$('[data-visual]')) row.hidden = name === 'sounds';
    for (const row of $$('[data-caption]')) row.hidden = name === 'sounds' || name === 'text';
    els.videoOptions.hidden = !(name === 'upload' && ui.upload && ui.upload.kind === 'video');
    if (name === 'gifs' && !ui.gifLoadedOnce) loadGifs();
    if (name === 'text') setTimeout(() => els.textInput.focus(), 0);
    updateSummary();
  }

  for (const tab of els.tabs) tab.addEventListener('click', () => switchTab(tab.dataset.tab));

  // ================================================================ upload

  function fileKind(file) {
    const name = (file.name || '').toLowerCase();
    if (IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
    if (VIDEO_TYPES.includes(file.type) || /\.(mp4|webm|m4v|mov)$/.test(name)) return 'video';
    if (AUDIO_TYPES.includes(file.type) || /\.(mp3|wav|ogg|m4a)$/.test(name)) return 'audio';
    return null;
  }

  async function readBytes(file) {
    try {
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      toast("Couldn't read that file.", 'error');
      return null;
    }
  }

  async function handleFile(file) {
    if (!file) return;
    const kind = fileKind(file);
    if (kind === 'audio') {
      ui.pendingSoundTarget = 'board';
      if (await setCustomSound(file)) switchTab('sounds');
      return;
    }
    if (!kind) {
      toast('That file type isn’t supported. Try a PNG, JPG, GIF, WebP, MP4 or WebM.', 'error');
      return;
    }
    const max = kind === 'image' ? limits().maxImageBytes : limits().maxVideoBytes;
    if (file.size > max) {
      toast(`That ${kind} is ${formatBytes(file.size)}. The limit is ${formatBytes(max)}.`, 'error');
      return;
    }
    const bytes = await readBytes(file);
    if (!bytes) return;
    if (ui.upload) URL.revokeObjectURL(ui.upload.url);
    ui.upload = { kind, bytes, name: file.name || `Pasted ${kind}`, size: file.size, url: URL.createObjectURL(file) };
    renderUpload();
    switchTab('upload');
  }

  function renderUpload() {
    const u = ui.upload;
    els.dzEmpty.hidden = Boolean(u);
    els.dzPreview.hidden = !u;
    els.dropzone.classList.toggle('has-file', Boolean(u));
    els.dropzone.title = u ? 'Click to pick a different file' : '';
    if (u) {
      const media =
        u.kind === 'video'
          ? el('video', { src: u.url, muted: true, loop: true, autoplay: true, playsinline: true })
          : el('img', { src: u.url, alt: '' });
      if (u.kind === 'video') media.muted = true;
      els.dzMedia.replaceChildren(media);
      els.uploadName.textContent = `${u.kind === 'video' ? '🎬' : '🖼️'} ${u.name}`;
      els.uploadSize.textContent = formatBytes(u.size);
    } else {
      els.dzMedia.replaceChildren();
    }
    els.videoOptions.hidden = !(ui.tab === 'upload' && u && u.kind === 'video');
    updateSummary();
  }

  els.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('#upload-clear')) return;
    els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === els.dropzone) {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    handleFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.uploadClear.addEventListener('click', (event) => {
    event.stopPropagation();
    if (ui.upload) URL.revokeObjectURL(ui.upload.url);
    ui.upload = null;
    renderUpload();
  });

  // Drag a file anywhere onto the window.
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (ui.view === 'main') els.dropzone.classList.add('dragging');
  });
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = ui.view === 'main' ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropzone.classList.remove('dragging');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('dragging');
    if (ui.view !== 'main') return;
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // Paste a screenshot / copied image with Ctrl+V.
  document.addEventListener('paste', (event) => {
    if (ui.view !== 'main' || !event.clipboardData) return;
    const item = [...event.clipboardData.items].find((i) => i.kind === 'file' && /^(image|video)\//.test(i.type));
    if (!item) return; // normal text paste
    event.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    handleFile(new File([file], file.name && file.name !== 'image.png' ? file.name : `pasted.${ext}`, { type: file.type }));
  });

  // ================================================================== GIFs

  function setGifStatus(text, isError = false) {
    els.gifStatus.textContent = text || '';
    els.gifStatus.classList.toggle('error', Boolean(isError));
  }

  function renderGifAvailability() {
    const connected = isConnected();
    const on = connected && ui.conn.features && ui.conn.features.giphy;
    els.gifBrowser.hidden = connected && !on;
    els.gifSetup.hidden = !connected || on;
    if (connected && !on) renderGifSetup();
  }

  function renderGifSetup() {
    const typing = document.activeElement && document.activeElement.matches('[data-giphy-input="gif-tab"]');
    if (typing) return;
    const mode = isHosting() ? 'host' : 'guest';
    if (els.gifSetup.dataset.mode === mode) return; // keep any message/text in the form
    els.gifSetup.dataset.mode = mode;
    if (mode === 'host') {
      els.gifSetup.replaceChildren(
        el('h3', { text: 'Turn on GIF search' }),
        el('p', { class: 'setting-help', text: 'GIF search uses GIPHY. You need a free key, once. Only the host needs one: your friends get GIF search automatically.' }),
        giphyForm('gif-tab'),
      );
    } else {
      els.gifSetup.replaceChildren(
        el('h3', { text: 'GIF search is off in this room' }),
        el('p', { class: 'setting-help', text: 'Ask whoever is hosting to turn it on in Settings → GIF search. It takes about a minute and is free.' }),
        el('p', { class: 'setting-help', text: 'Meanwhile you can still drop images, videos and sounds!' }),
      );
    }
  }

  /** The "paste your GIPHY key" form, used in the GIF tab and in Settings. */
  function giphyForm(where) {
    const input = el('input', { type: 'password', placeholder: 'Paste your GIPHY API key', autocomplete: 'off', spellcheck: 'false', 'data-giphy-input': where });
    const msg = el('p', { class: 'setting-msg', hidden: true });
    const save = el('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Save key', 'data-giphy-save': where });
    const show = el('button', { type: 'button', class: 'icon-btn small', title: 'Show/hide', text: '👁' });
    show.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    const submit = async () => {
      const key = input.value.trim();
      if (!key) {
        msg.hidden = false;
        msg.className = 'setting-msg error';
        msg.textContent = 'Paste the key first.';
        return;
      }
      save.disabled = true;
      save.textContent = 'Checking…';
      const res = await api.saveGiphyKey(key);
      save.disabled = false;
      save.textContent = 'Save key';
      msg.hidden = false;
      if (res.ok) {
        input.value = '';
        msg.className = 'setting-msg ok';
        msg.textContent = res.warning || '✓ Saved! GIF search is on.';
        toast(isHosting() ? 'GIF search is on for everyone in your room!' : 'GIPHY key saved. It will be used when you host.', 'success');
      } else {
        msg.className = 'setting-msg error';
        msg.textContent = res.error;
      }
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    return el('div', { class: 'giphy-form' }, [
      el('ol', { class: 'steps' }, [
        el('li', {}, [
          'Click ',
          el('button', { type: 'button', class: 'link-btn', text: 'Get a free GIPHY key', onclick: () => api.openExternal(GIPHY_SIGNUP) }),
          ' and sign up (free).',
        ]),
        el('li', { text: 'Click “Create an App”, choose “API”, give it any name.' }),
        el('li', { text: 'Copy the key it shows you, paste it here and click Save.' }),
      ]),
      el('div', { class: 'key-row' }, [input, show, save]),
      msg,
    ]);
  }

  async function loadGifs({ append = false } = {}) {
    if (!isConnected()) {
      setGifStatus('Join a room to search GIFs.');
      return;
    }
    if (!ui.conn.features || !ui.conn.features.giphy) {
      renderGifAvailability();
      return;
    }
    const seq = ++ui.gifSeq;
    const offset = append ? ui.gifNextOffset || 0 : 0;
    els.gifMore.disabled = true;
    if (append) {
      els.gifMore.textContent = 'Loading…';
    } else {
      ui.gifItems = [];
      els.gifGrid.replaceChildren();
      els.gifMore.hidden = true;
      els.gifScroll.scrollTop = 0;
      setGifStatus('Loading…');
    }
    const res = ui.gifMode === 'search' ? await api.searchGifs(ui.gifQuery, offset) : await api.trendingGifs(offset);
    if (seq !== ui.gifSeq) return;
    els.gifMore.disabled = false;
    els.gifMore.textContent = 'Load more';
    if (!res.ok) {
      setGifStatus(res.error || 'GIF search failed.', true);
      return;
    }
    ui.gifLoadedOnce = true;
    const seen = new Set(ui.gifItems.map((g) => g.id));
    const fresh = (res.items || []).filter((g) => !seen.has(g.id));
    ui.gifItems.push(...fresh);
    els.gifGrid.append(...fresh.map(makeGifButton));
    ui.gifNextOffset = res.nextOffset;
    els.gifMore.hidden = res.nextOffset === null || res.nextOffset === undefined;
    setGifStatus(ui.gifItems.length ? '' : ui.gifMode === 'search' ? `No GIFs found for “${ui.gifQuery}”.` : 'Nothing trending right now.');
  }

  function makeGifButton(item) {
    const btn = el('button', {
      type: 'button',
      class: 'gif-item',
      'data-id': item.id,
      'aria-pressed': String(Boolean(ui.gif && ui.gif.id === item.id)),
      title: item.user ? `${item.title} · by ${item.user}` : item.title,
    });
    if (item.preview.width && item.preview.height) btn.style.aspectRatio = `${item.preview.width} / ${item.preview.height}`;
    const still = typeof item.preview.still === 'string' ? item.preview.still : null;
    const img = el('img', {
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
      alt: item.title,
      'data-anim': item.preview.url,
      'data-still': still,
      src: still && !gifsAnimating() ? still : item.preview.url,
    });
    btn.append(img);
    btn.addEventListener('click', (event) => {
      // event.detail is 2 on the second click of a double-click: keep it selected.
      selectGif(ui.gif && ui.gif.id === item.id && event.detail < 2 ? null : item);
    });
    btn.addEventListener('dblclick', () => {
      selectGif(item);
      sendDrop();
    });
    return btn;
  }

  function selectGif(item) {
    ui.gif = item;
    for (const node of els.gifGrid.children) node.setAttribute('aria-pressed', String(Boolean(ui.gif && node.dataset.id === ui.gif.id)));
    updateSummary();
  }

  els.gifForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = els.gifQuery.value.trim();
    if (!q) {
      showTrending();
      return;
    }
    ui.gifMode = 'search';
    ui.gifQuery = q;
    els.gifHeading.textContent = `Results for “${q}”`;
    els.gifBack.hidden = false;
    loadGifs();
  });

  function showTrending() {
    ui.gifMode = 'trending';
    ui.gifQuery = '';
    els.gifQuery.value = '';
    els.gifHeading.textContent = 'Trending';
    els.gifBack.hidden = true;
    loadGifs();
  }

  els.gifBack.addEventListener('click', showTrending);
  els.gifMore.addEventListener('click', () => loadGifs({ append: true }));
  els.giphyLink.addEventListener('click', (event) => {
    event.preventDefault();
    api.openExternal('https://giphy.com');
  });

  // ================================================================ sounds

  let previewCtx = null;
  let previewHandle = null;

  let previewCtxTimer = null;

  function stopPreview() {
    if (previewHandle) previewHandle.stop();
    previewHandle = null;
  }

  /**
   * An open AudioContext keeps an audio thread (and Chromium's audio process)
   * busy, so close it a moment after the last preview finishes.
   */
  function releasePreviewAudioLater(handle) {
    clearTimeout(previewCtxTimer);
    const ms = ((handle && handle.duration) || 0) * 1000 + 1500;
    previewCtxTimer = setTimeout(() => {
      if (previewCtx && previewCtx.state !== 'closed') previewCtx.close().catch(() => {});
      previewCtx = null;
    }, ms);
  }

  function previewSound(pick, tile) {
    stopPreview();
    const volume = ui.conn && typeof ui.conn.soundVolume === 'number' ? Math.max(ui.conn.soundVolume, 0.15) : 0.8;
    if (pick === 'custom') {
      if (!ui.customSound) return;
      const audio = new Audio(ui.customSound.url);
      audio.volume = volume;
      audio.play().catch(() => {});
      previewHandle = { stop: () => audio.pause() };
    } else if (pick) {
      if (!previewCtx || previewCtx.state === 'closed') previewCtx = new AudioContext();
      previewCtx.resume().catch(() => {});
      previewHandle = Sounds.play(previewCtx, pick, null, { volume });
      releasePreviewAudioLater(previewHandle);
    }
    if (tile) {
      tile.classList.remove('playing');
      void tile.offsetWidth;
      tile.classList.add('playing');
    }
  }

  function soundName(pick) {
    if (pick === 'custom') return ui.customSound ? `🎵 ${ui.customSound.name}` : '🎵 Your sound';
    const info = Sounds.info(pick);
    return info ? `${info.emoji} ${info.label}` : '';
  }

  function soundPayload(pick) {
    if (!pick) return null;
    if (pick === 'custom') return ui.customSound ? { type: 'file', bytes: ui.customSound.bytes, name: ui.customSound.name } : null;
    return { type: 'builtin', id: pick };
  }

  function renderSoundboard() {
    const tiles = Sounds.SOUNDS.map((s) =>
      el(
        'button',
        {
          type: 'button',
          class: 'sound-tile',
          'data-sound': s.id,
          'aria-pressed': String(ui.soundPick === s.id),
          title: 'Click to hear it · double-click to send it',
        },
        [el('span', { class: 'emoji', text: s.emoji }), el('span', { text: s.label })],
      ),
    );
    if (ui.customSound) {
      tiles.push(
        el('button', { type: 'button', class: 'sound-tile', 'data-sound': 'custom', 'aria-pressed': String(ui.soundPick === 'custom'), title: ui.customSound.name }, [
          el('span', { class: 'emoji', text: '🎵' }),
          el('span', { text: 'Your sound' }),
          el('small', { text: ui.customSound.name }),
        ]),
      );
    }
    tiles.push(
      el('button', { type: 'button', class: 'sound-tile upload', 'data-sound': 'upload', title: 'MP3, WAV, OGG or M4A' }, [
        el('span', { class: 'emoji', text: '➕' }),
        el('span', { text: ui.customSound ? 'Change your sound' : 'Upload your own' }),
        el('small', { text: `MP3/WAV/OGG · ${formatBytes(limits().maxSoundBytes)} max` }),
      ]),
    );
    els.soundboard.replaceChildren(...tiles);
  }

  els.soundboard.addEventListener('click', (event) => {
    const tile = event.target.closest('.sound-tile');
    if (!tile) return;
    const pick = tile.dataset.sound;
    if (pick === 'upload') {
      ui.pendingSoundTarget = 'board';
      els.soundInput.click();
      return;
    }
    if (event.detail >= 2) return; // dblclick handles it
    ui.soundPick = pick;
    for (const t of $$('.sound-tile', els.soundboard)) t.setAttribute('aria-pressed', String(t.dataset.sound === pick));
    previewSound(pick, tile);
    updateSummary();
  });

  els.soundboard.addEventListener('dblclick', (event) => {
    const tile = event.target.closest('.sound-tile');
    if (!tile || tile.dataset.sound === 'upload') return;
    ui.soundPick = tile.dataset.sound;
    stopPreview();
    sendDrop();
  });

  async function setCustomSound(file) {
    const kind = fileKind(file);
    if (kind !== 'audio') {
      toast('Sounds can be MP3, WAV, OGG or M4A.', 'error');
      return false;
    }
    const max = limits().maxSoundBytes;
    if (file.size > max) {
      toast(`That sound is ${formatBytes(file.size)}. The limit is ${formatBytes(max)}.`, 'error');
      return false;
    }
    const bytes = await readBytes(file);
    if (!bytes) return false;
    if (ui.customSound) URL.revokeObjectURL(ui.customSound.url);
    ui.customSound = { bytes, name: file.name || 'sound', size: file.size, url: URL.createObjectURL(file) };
    if (ui.pendingSoundTarget === 'attach') ui.attachSound = 'custom';
    else ui.soundPick = 'custom';
    ui.pendingSoundTarget = null;
    renderSoundboard();
    renderSoundSelect();
    updateSummary();
    return true;
  }

  els.soundInput.addEventListener('change', async () => {
    const file = els.soundInput.files[0];
    els.soundInput.value = '';
    if (file) await setCustomSound(file);
    else renderSoundSelect();
  });

  function renderSoundSelect() {
    const options = [el('option', { value: '', text: '🔇 No sound' })];
    for (const s of Sounds.SOUNDS) options.push(el('option', { value: s.id, text: `${s.emoji} ${s.label}` }));
    if (ui.customSound) options.push(el('option', { value: 'custom', text: `🎵 ${ui.customSound.name}` }));
    options.push(el('option', { value: '__upload', text: '➕ Upload a sound…' }));
    els.soundSelect.replaceChildren(...options);
    els.soundSelect.value = ui.attachSound || '';
    els.soundTest.disabled = !ui.attachSound;
  }

  els.soundSelect.addEventListener('change', () => {
    const v = els.soundSelect.value;
    if (v === '__upload') {
      els.soundSelect.value = ui.attachSound || '';
      ui.pendingSoundTarget = 'attach';
      els.soundInput.click();
      return;
    }
    ui.attachSound = v;
    els.soundTest.disabled = !v;
    if (v) previewSound(v);
    updateSummary();
  });
  els.soundTest.addEventListener('click', () => previewSound(ui.attachSound));

  // ============================================================== controls

  function setRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  }

  function renderOpacity() {
    els.opacityOut.textContent = `${els.opacity.value}%`;
    setRangeFill(els.opacity);
  }

  function renderDuration() {
    const full = els.videoFull.checked && ui.upload && ui.upload.kind === 'video' && ui.tab === 'upload';
    els.durationOut.textContent = full ? 'clip' : `${els.duration.value}s`;
    els.duration.disabled = Boolean(full);
    setRangeFill(els.duration);
  }

  function renderPosition() {
    for (const btn of els.position.querySelectorAll('button')) btn.setAttribute('aria-checked', String(btn.dataset.value === ui.position));
  }

  els.opacity.addEventListener('input', renderOpacity);
  els.opacity.addEventListener('change', () => api.updateSettings({ opacity: Number(els.opacity.value) / 100 }));
  els.duration.addEventListener('input', renderDuration);
  els.duration.addEventListener('change', () => api.updateSettings({ durationMs: Number(els.duration.value) * 1000 }));
  els.position.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    ui.position = btn.dataset.value;
    renderPosition();
    api.updateSettings({ position: ui.position });
  });
  els.videoSound.addEventListener('change', () => api.updateSettings({ videoSound: els.videoSound.checked }));
  els.videoFull.addEventListener('change', () => {
    renderDuration();
    updateSummary();
  });

  // ========================================================== send/preview

  function currentPayload() {
    const base = {
      opacity: Number(els.opacity.value) / 100,
      durationMs: Number(els.duration.value) * 1000,
      position: ui.position,
      effect: els.effectSelect.value,
    };
    if (ui.tab === 'sounds') {
      const sound = soundPayload(ui.soundPick);
      return sound ? { kind: 'sound', sound } : null;
    }
    const sound = soundPayload(ui.attachSound);
    if (ui.tab === 'text') {
      const text = els.textInput.value.trim();
      return text ? { kind: 'text', text, color: ui.textColor, ...base, sound } : null;
    }
    base.caption = captionPayload();
    if (ui.tab === 'upload') {
      if (!ui.upload) return null;
      if (ui.upload.kind === 'video') {
        return {
          kind: 'video',
          bytes: ui.upload.bytes,
          ...base,
          durationMs: els.videoFull.checked ? 0 : base.durationMs,
          videoSound: els.videoSound.checked,
          sound,
        };
      }
      return { kind: 'image', bytes: ui.upload.bytes, ...base, sound };
    }
    if (!ui.gif) return null;
    return {
      kind: 'gif',
      url: ui.gif.full.url,
      width: ui.gif.full.width,
      height: ui.gif.full.height,
      title: ui.gif.title,
      ...base,
      sound,
    };
  }

  function captionPayload() {
    if (els.captionInputs.hidden) return undefined;
    const top = els.captionTop.value.trim();
    const bottom = els.captionBottom.value.trim();
    return top || bottom ? { top, bottom } : undefined;
  }

  function updateSummary() {
    const target = targetLabel();
    let parts;
    if (ui.tab === 'text') {
      const text = els.textInput.value.trim();
      const extra = ui.attachSound ? [' + ', soundName(ui.attachSound)] : [];
      parts = text ? [['strong', `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`], ...extra, ' → ', ['strong', target]] : ['Type a message to drop.'];
    } else if (ui.tab === 'sounds') {
      parts = ui.soundPick ? [['strong', soundName(ui.soundPick)], ' → ', ['strong', target]] : ['Pick a sound to play on their speakers.'];
    } else {
      const extra = ui.attachSound ? [' + ', soundName(ui.attachSound)] : [];
      if (ui.tab === 'upload' && ui.upload) {
        parts = [['strong', ui.upload.name], ` (${formatBytes(ui.upload.size)})`, ...extra, ' → ', ['strong', target]];
      } else if (ui.tab === 'gifs' && ui.gif) {
        parts = [['strong', ui.gif.title], ...extra, ' → ', ['strong', target]];
      } else {
        parts = [ui.tab === 'upload' ? 'Pick an image or video to drop.' : 'Pick a GIF to drop.'];
      }
    }
    els.summary.replaceChildren(rich(parts));
    renderDuration();
    updateSendState();
  }

  function updateSendState() {
    const has = Boolean(currentPayload());
    els.sendBtn.disabled = ui.sending || !has || !isConnected();
    els.previewBtn.disabled = !has;
    els.sendBtn.classList.toggle('busy', ui.sending);
  }

  async function sendDrop() {
    if (ui.sending) return;
    const payload = currentPayload();
    if (!payload) {
      toast('Pick something to drop first.', 'error');
      return;
    }
    if (!isConnected()) {
      toast("You're not connected right now.", 'error');
      return;
    }
    ui.sending = true;
    updateSendState();
    const targets = [...ui.targets];
    const label = targetLabel();
    const res = await api.sendDrop({ ...payload, to: targets.length ? targets : 'all' });
    ui.sending = false;
    updateSendState();
    if (res.ok && payload.kind === 'text') {
      els.textInput.value = '';
      renderText();
    }
    if (!res.ok) toast(res.error, 'error');
    else if (res.delivered === 0) toast('Sent, but nobody else is in the room yet. Send them the invite link!');
    else if (!targets.length) toast(`Dropped on ${res.delivered} friend${res.delivered === 1 ? '' : 's'}!`, 'success');
    else toast(`Dropped on ${label}!`, 'success');
  }

  els.sendBtn.addEventListener('click', sendDrop);
  els.previewBtn.addEventListener('click', async () => {
    const payload = currentPayload();
    if (!payload) return;
    const res = await api.previewDrop(payload);
    if (!res.ok) toast(res.error, 'error');
  });

  // ============================================= pause GIFs when not looking

  // Two dozen animated GIFs cost real CPU/GPU. While MemeDrop isn't the
  // active window, the grid shows still frames instead.
  function gifsAnimating() {
    return document.hasFocus() && document.visibilityState === 'visible';
  }

  function syncGifAnimation() {
    const animate = gifsAnimating();
    for (const img of els.gifGrid.querySelectorAll('img[data-still]')) {
      const want = animate ? img.dataset.anim : img.dataset.still;
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    }
  }

  window.addEventListener('focus', syncGifAnimation);
  window.addEventListener('blur', syncGifAnimation);
  document.addEventListener('visibilitychange', syncGifAnimation);

  // ================================================================== text

  function renderTextColors() {
    els.textColors.replaceChildren(
      ...Object.entries(TEXT_COLORS).map(([name, color]) => {
        const dot = el('button', {
          type: 'button',
          class: 'color-dot',
          role: 'radio',
          'aria-checked': String(name === ui.textColor),
          'aria-label': name,
          title: name[0].toUpperCase() + name.slice(1),
          'data-color': name,
          onclick: () => {
            ui.textColor = name;
            api.updateSettings({ textColor: name });
            renderTextColors();
            renderText();
          },
        });
        dot.style.setProperty('--dot', color);
        return dot;
      }),
    );
  }

  function renderText() {
    const text = els.textInput.value;
    els.textCount.textContent = `${text.length}/140`;
    els.textPreview.textContent = text.trim() || 'Your message';
    els.textPreview.className = `text-preview c-${ui.textColor}${text.trim() ? '' : ' placeholder'}`;
    updateSummary();
  }

  els.textInput.addEventListener('input', renderText);
  els.textInput.addEventListener('keydown', (event) => {
    // Enter sends, like a chat box (the message is one line anyway).
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (els.textInput.value.trim()) sendDrop();
    }
  });

  // ======================================================== effect/caption

  els.effectSelect.addEventListener('change', () => api.updateSettings({ effect: els.effectSelect.value }));

  function setCaptionOpen(open) {
    els.captionInputs.hidden = !open;
    els.captionToggle.textContent = open ? '－ Remove meme text' : '＋ Add top/bottom text';
    if (open) els.captionTop.focus();
    else {
      els.captionTop.value = '';
      els.captionBottom.value = '';
    }
  }
  els.captionToggle.addEventListener('click', () => setCaptionOpen(els.captionInputs.hidden));

  // ================================================================= inbox

  function timeAgo(at) {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 45) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
  }

  function isMutedName(name) {
    const list = (ui.conn && ui.conn.mutedFriends) || [];
    return list.includes(String(name).toLowerCase());
  }

  function setInboxOpen(open) {
    els.inbox.hidden = !open;
    els.inboxBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      ui.unread = 0;
      api.inboxSeen();
      renderInbox();
    }
    renderInboxBadge();
  }

  function renderInboxBadge() {
    els.inboxBadge.hidden = ui.unread === 0;
    els.inboxBadge.textContent = ui.unread > 9 ? '9+' : String(ui.unread);
  }

  function renderInbox() {
    renderInboxBadge();
    if (els.inbox.hidden) return;
    els.inboxEmpty.hidden = ui.inbox.length > 0;
    els.inboxList.replaceChildren(
      ...ui.inbox.map((entry) => {
        const muted = isMutedName(entry.from);
        const av = el('span', { class: 'avatar', text: [...entry.from.trim()][0].toUpperCase() });
        av.style.setProperty('--avatar', `hsl(${hueFor(entry.from)} 60% 50%)`);
        const line = el('div', { class: 'inbox-line' }, [
          el('strong', { text: entry.from }),
          el('span', { class: 'inbox-what', text: ` sent ${KIND_WORDS[entry.kind] || 'something'}` }),
          el('span', { class: 'inbox-time', text: ` · ${timeAgo(entry.at)}` }),
        ]);
        const quote = entry.text ? el('div', { class: 'inbox-text', text: `“${entry.text}”` }) : null;
        const canReact = Boolean(entry.fromId) && isConnected() && otherPeers().some((p) => p.id === entry.fromId);
        const reactions = el(
          'div',
          { class: 'reactions', role: 'group', 'aria-label': `React to ${entry.from}` },
          REACTIONS.map((emoji) =>
            el('button', {
              type: 'button',
              class: `react-btn${entry.reacted === emoji ? ' picked' : ''}`,
              text: emoji,
              title: canReact ? `Send ${emoji} to ${entry.from}` : `${entry.from} isn't here anymore`,
              disabled: !canReact,
              onclick: async () => {
                const res = await api.react(entry.fromId, emoji, entry.dropId);
                if (!res.ok) return toast(res.error, 'error');
                entry.reacted = emoji;
                renderInbox();
                return toast(`Sent ${emoji} to ${entry.from}!`, 'success');
              },
            }),
          ),
        );
        const mute = el('button', {
          type: 'button',
          class: 'link-btn inbox-mute',
          text: muted ? `Unmute ${entry.from}` : `Mute ${entry.from}`,
          title: muted ? `Show ${entry.from}'s drops again` : `Stop showing anything ${entry.from} sends you`,
          onclick: async () => {
            await api.muteFriend(entry.from, !muted);
            toast(muted ? `${entry.from} is unmuted.` : `Muted ${entry.from}. Their drops won't show up anymore.`);
          },
        });
        return el('li', { class: `inbox-item${muted ? ' is-muted' : ''}` }, [av, el('div', { class: 'inbox-body' }, [line, quote, reactions]), mute]);
      }),
    );
  }

  els.inboxBtn.addEventListener('click', () => setInboxOpen(els.inbox.hidden));
  els.inboxClose.addEventListener('click', () => setInboxOpen(false));

  function renderMutedFriends() {
    const list = (ui.conn && ui.conn.mutedFriends) || [];
    if (!list.length) {
      els.mutedFriends.replaceChildren(el('p', { class: 'setting-help', text: "Muted friends: nobody. To mute someone, open 📥 (top bar) and click Mute under one of their drops." }));
      return;
    }
    els.mutedFriends.replaceChildren(
      el('p', { class: 'setting-help', text: "Muted friends (their drops and reactions never show up):" }),
      el(
        'div',
        { class: 'muted-list' },
        list.map((name) =>
          el('span', { class: 'muted-chip' }, [
            el('span', { text: name }),
            el('button', { type: 'button', class: 'link-btn', text: 'Unmute', onclick: () => api.muteFriend(name, false) }),
          ]),
        ),
      ),
    );
  }

  // ============================================================== settings

  function openSettings() {
    els.settings.hidden = false;
    renderSettings(true);
    els.settingsClose.focus();
  }

  function closeSettings() {
    if (ui.recording) stopRecording();
    els.settings.hidden = true;
  }

  for (const b of $$('[data-open-settings]')) b.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);

  function renderThemes() {
    const current = (ui.conn && ui.conn.theme) || ui.settings.theme || 'bubblegum';
    els.themeList.replaceChildren(
      ...Object.entries(THEME_NAMES).map(([id, name]) =>
        el(
          'button',
          {
            type: 'button',
            class: 'theme-swatch',
            role: 'radio',
            'data-theme': id,
            'aria-checked': String(id === current),
            onclick: () => {
              applyTheme(id);
              api.updateSettings({ theme: id });
            },
          },
          [
            el('span', { class: 'sample' }, [el('span', { class: 's-bg' }), el('span', { class: 's-panel' }), el('span', { class: 's-a1' }), el('span', { class: 's-a2' })]),
            el('span', { text: name }),
          ],
        ),
      ),
    );
  }

  function renderKeys(label) {
    const parts = String(label || '').split('+');
    const nodes = [];
    parts.forEach((p, i) => {
      if (i) nodes.push(el('span', { class: 'plus', text: '+' }));
      nodes.push(el('kbd', { text: p }));
    });
    els.hotkeyKeys.replaceChildren(...nodes);
  }

  function hotkeyMessage(text, kind) {
    els.hotkeyMsg.hidden = !text;
    els.hotkeyMsg.textContent = text || '';
    els.hotkeyMsg.className = `setting-msg ${kind || ''}`;
  }

  function renderSettings(force = false) {
    if (els.settings.hidden && !force) return;
    const s = ui.conn || {};
    if (!ui.recording && s.hotkey) {
      els.hotkeyKeys.classList.remove('recording');
      renderKeys(s.hotkey.label);
      if (!s.hotkey.ok && !els.hotkeyMsg.textContent) {
        hotkeyMessage(`${s.hotkey.label} is taken by another app. Click Change to pick another shortcut.`, 'error');
      }
    }
    els.soundsEnabled.checked = s.soundsEnabled !== false;
    if (document.activeElement !== els.soundVolume) els.soundVolume.value = String(Math.round((s.soundVolume ?? 0.8) * 100));
    els.soundVolumeOut.textContent = `${els.soundVolume.value}%`;
    setRangeFill(els.soundVolume);
    els.settingsMuted.checked = Boolean(s.muted);
    renderMutedFriends();
    for (const sw of $$('.theme-swatch', els.themeList)) sw.setAttribute('aria-checked', String(sw.dataset.theme === s.theme));
    renderGiphySettings();
  }

  let giphySettingsKey = '';
  function renderGiphySettings() {
    const s = ui.conn || {};
    const key = `${Boolean(s.hasGiphyKey)}|${isHosting()}`;
    if (key === giphySettingsKey && els.giphySettings.childElementCount) return; // nothing changed: keep their typing/messages
    giphySettingsKey = key;
    const status = el('p', { class: `giphy-status ${s.hasGiphyKey ? 'on' : ''}` }, [
      el('span', { class: 'dot' }),
      s.hasGiphyKey ? 'Your GIPHY key is saved. GIF search is on when you host.' : 'No GIPHY key yet, so GIF search is off when you host.',
    ]);
    const children = [status];
    if (!isHosting()) children.push(el('p', { class: 'setting-help', text: 'Only the person hosting needs a key. Joining someone else’s room? Their key is used.' }));
    children.push(giphyForm('settings'));
    if (s.hasGiphyKey) {
      children.push(
        el('button', {
          type: 'button',
          class: 'link-btn',
          text: 'Remove my key',
          onclick: async () => {
            await api.saveGiphyKey('');
            toast('GIPHY key removed.');
          },
        }),
      );
    }
    els.giphySettings.replaceChildren(...children);
  }

  // Panic hotkey recorder
  async function startRecording() {
    ui.recording = true;
    await api.pauseHotkey(true);
    els.hotkeyKeys.classList.add('recording');
    els.hotkeyKeys.replaceChildren('Press your new shortcut…');
    els.hotkeyChange.textContent = 'Cancel';
    hotkeyMessage('Hold Ctrl and/or Alt (plus Shift if you like) and press a key. Esc cancels.');
  }

  async function stopRecording() {
    ui.recording = false;
    els.hotkeyChange.textContent = 'Change';
    els.hotkeyKeys.classList.remove('recording');
    await api.pauseHotkey(false);
    renderSettings(true);
  }

  els.hotkeyChange.addEventListener('click', () => {
    if (ui.recording) {
      hotkeyMessage('');
      stopRecording();
    } else {
      startRecording();
    }
  });

  els.hotkeyReset.addEventListener('click', async () => {
    const res = await api.resetHotkey();
    hotkeyMessage(res.ok ? 'Back to the default shortcut.' : res.error, res.ok ? 'ok' : 'error');
  });

  document.addEventListener(
    'keydown',
    async (event) => {
      if (!ui.recording) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        hotkeyMessage('');
        stopRecording();
        return;
      }
      const result = Hotkey.eventToAccelerator(event);
      if (result.pending) {
        const held = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win'].filter(Boolean);
        els.hotkeyKeys.replaceChildren(`${held.join(' + ')} + …`);
        return;
      }
      if (result.error) {
        hotkeyMessage(result.error, 'error');
        return;
      }
      ui.recording = false; // stop listening while we try it
      const res = await api.setHotkey(result.accelerator);
      await stopRecording();
      if (res.ok) {
        const label = Hotkey.acceleratorLabel(result.accelerator, ui.platform);
        hotkeyMessage(`✓ Saved. ${label} now clears your screen.`, 'ok');
        toast(`Panic key is now ${label}`, 'success');
      } else {
        hotkeyMessage(res.error, 'error');
      }
    },
    true,
  );

  els.soundsEnabled.addEventListener('change', () => api.updateSettings({ soundsEnabled: els.soundsEnabled.checked }));
  els.soundVolume.addEventListener('input', () => {
    els.soundVolumeOut.textContent = `${els.soundVolume.value}%`;
    setRangeFill(els.soundVolume);
  });
  els.soundVolume.addEventListener('change', () => api.updateSettings({ soundVolume: Number(els.soundVolume.value) / 100 }));
  els.soundVolumeTest.addEventListener('click', () => {
    stopPreview();
    if (!previewCtx || previewCtx.state === 'closed') previewCtx = new AudioContext();
    previewHandle = Sounds.play(previewCtx, 'ding', null, { volume: Number(els.soundVolume.value) / 100 });
    releasePreviewAudioLater(previewHandle);
  });
  els.settingsMuted.addEventListener('change', () => api.setMuted(els.settingsMuted.checked));

  // ============================================================== keyboard

  document.addEventListener('keydown', (event) => {
    if (ui.recording) return;
    if (event.key === 'Escape' && !els.settings.hidden) {
      closeSettings();
      return;
    }
    if (event.key === 'Escape' && !els.inbox.hidden) {
      setInboxOpen(false);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && ui.view === 'main' && els.settings.hidden) {
      event.preventDefault();
      sendDrop();
    }
  });

  // ================================================================ events

  api.onIncoming((n) => {
    const what = KIND_WORDS[n.kind] || 'something';
    ui.inbox.unshift({ ...n });
    ui.inbox.length = Math.min(ui.inbox.length, 20);
    if (els.inbox.hidden) ui.unread += 1;
    else api.inboxSeen();
    renderInbox();
    toast(n.muted ? `${n.from} sent ${what} (hidden while muted)` : `${n.from} dropped ${what} on you! Open 📥 to react.`);
  });

  api.onReaction(({ from, emoji }) => toast(`${from} reacted ${emoji}`, 'success'));

  api.onNotice((n) => toast(n.text, n.kind));

  api.onInvite(({ link, room }) => {
    els.joinInvite.value = link;
    showView('join');
    showError(els.joinError, '');
    if (ui.conn && ui.conn.status !== 'disconnected') {
      showError(els.joinError, `Joining ${room} will leave the room you're in now.`);
    }
    (els.joinNickname.value ? els.joinBtn : els.joinNickname).focus();
  });

  // ================================================================= start

  async function init() {
    const boot = await api.init();
    ui.settings = boot.settings;
    ui.version = boot.version;
    ui.platform = boot.platform;
    ui.suggestedRoom = boot.suggestedRoom;
    ui.inbox = Array.isArray(boot.inbox) ? boot.inbox.map((n) => ({ ...n })) : [];
    ui.unread = Number(boot.unread) || 0;
    els.about.textContent = `MemeDrop ${boot.version}`;

    const s = boot.settings;
    els.opacity.value = String(Math.round((s.opacity || 1) * 100));
    els.duration.value = String(Math.round((s.durationMs || 4000) / 1000));
    els.videoSound.checked = s.videoSound !== false;
    ui.position = s.position || 'random';
    ui.textColor = TEXT_COLORS[s.textColor] ? s.textColor : 'white';
    els.effectSelect.value = [...els.effectSelect.options].some((o) => o.value === s.effect) ? s.effect : 'pop';
    renderOpacity();
    renderDuration();
    renderPosition();
    renderUpload();
    renderSoundboard();
    renderSoundSelect();
    renderTextColors();
    renderText();
    renderThemes();
    switchTab('upload');

    api.onState(applyState);
    showView('welcome');
    applyState(boot.state);
  }

  init();
})();
