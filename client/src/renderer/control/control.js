'use strict';

/* Control window: connect, pick a friend, pick an image or GIF, tune it, drop it. */
(() => {
  const api = window.memedrop;
  const $ = (id) => document.getElementById(id);

  const els = {
    connectView: $('connect-view'),
    connectForm: $('connect-form'),
    serverUrl: $('server-url'),
    room: $('room'),
    nickname: $('nickname'),
    connectError: $('connect-error'),
    connectBtn: $('connect-btn'),

    mainView: $('main-view'),
    statusDot: $('status-dot'),
    roomCode: $('room-code'),
    meLine: $('me-line'),
    muteBtn: $('mute-btn'),
    clearBtn: $('clear-btn'),
    leaveBtn: $('leave-btn'),
    banners: $('banners'),
    targets: $('targets'),
    aloneHint: $('alone-hint'),

    tabs: [...document.querySelectorAll('.tab')],
    panelUpload: $('panel-upload'),
    panelGifs: $('panel-gifs'),

    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    dzEmpty: $('dz-empty'),
    dzPreview: $('dz-preview'),
    dzLimits: $('dz-limits'),
    uploadPreview: $('upload-preview'),
    uploadName: $('upload-name'),
    uploadSize: $('upload-size'),
    uploadClear: $('upload-clear'),

    gifForm: $('gif-search-form'),
    gifQuery: $('gif-query'),
    gifHeading: $('gif-heading'),
    gifBack: $('gif-back'),
    gifScroll: $('gif-scroll'),
    gifGrid: $('gif-grid'),
    gifStatus: $('gif-status'),
    gifMore: $('gif-more'),
    giphyLink: $('giphy-link'),

    opacity: $('opacity'),
    opacityOut: $('opacity-out'),
    duration: $('duration'),
    durationOut: $('duration-out'),
    position: $('position'),
    summary: $('selection-summary'),
    previewBtn: $('preview-btn'),
    sendBtn: $('send-btn'),
    toast: $('toast'),
  };

  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

  const ui = {
    conn: null,
    tab: 'upload',
    target: 'all',
    targetName: 'Everyone',
    upload: null, // { bytes, name, size, url }
    gif: null, // GIPHY item from the server
    gifMode: 'trending',
    gifQuery: '',
    gifItems: [],
    gifNextOffset: null,
    gifSeq: 0,
    gifLoadedOnce: false,
    position: 'random',
    sending: false,
  };

  // ---------------------------------------------------------------- helpers

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function maxBytes() {
    return (ui.conn && ui.conn.limits && ui.conn.limits.maxImageBytes) || DEFAULT_MAX_BYTES;
  }

  function isConnected() {
    return Boolean(ui.conn && ui.conn.status === 'connected');
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

  /** Build a DOM fragment from ["plain", ["strong", "bold"], ...] — no innerHTML with user text. */
  function rich(parts) {
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (typeof part === 'string') frag.append(part);
      else {
        const el = document.createElement(part[0]);
        el.textContent = part[1];
        frag.append(el);
      }
    }
    return frag;
  }

  let toastTimer = null;
  function toast(text, kind = 'info') {
    if (!text) return;
    els.toast.textContent = text;
    els.toast.className = `toast ${kind}`;
    els.toast.hidden = false;
    // restart the entry animation
    void els.toast.offsetWidth;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, kind === 'error' ? 4500 : 2800);
  }

  // ---------------------------------------------------------- connection UI

  function applyState(s) {
    const prev = ui.conn;
    ui.conn = s;
    const inRoom = s.status !== 'disconnected';

    els.connectView.hidden = inRoom;
    els.mainView.hidden = !inRoom;

    if (!inRoom) {
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Join room';
      if (s.error) {
        els.connectError.textContent = s.error;
        els.connectError.hidden = false;
      }
      return;
    }

    els.statusDot.dataset.status = s.status;
    els.roomCode.textContent = s.room || '—';
    const others = otherPeers();
    if (s.status === 'connected') {
      const online = others.length === 0 ? 'just you here' : `${others.length} friend${others.length === 1 ? '' : 's'} online`;
      els.meLine.textContent = `you're ${s.nickname} · ${online}`;
    } else {
      els.meLine.textContent = s.status === 'connecting' ? 'connecting…' : 'reconnecting…';
    }

    els.muteBtn.setAttribute('aria-pressed', String(Boolean(s.muted)));
    els.muteBtn.title = s.muted ? 'Unmute incoming memes' : 'Mute incoming memes';
    els.clearBtn.title = s.hotkey && s.hotkey.ok ? `Clear my screen (${s.hotkey.label})` : 'Clear my screen';
    els.dzLimits.textContent = `PNG, JPG, GIF or WebP · up to ${formatBytes(maxBytes())}`;

    renderTargets();
    renderBanners();
    updateSummary();

    const justConnected = s.status === 'connected' && (!prev || prev.status !== 'connected');
    if (justConnected) {
      ui.gifLoadedOnce = false;
      if (ui.tab === 'gifs') loadGifs();
    }
    if (!isConnected() && ui.tab === 'gifs' && !ui.gifLoadedOnce) {
      setGifStatus('Waiting for the server…');
    }
  }

  function renderBanners() {
    const s = ui.conn;
    const list = [];
    if (s.status === 'connecting') list.push({ kind: 'info', text: 'Connecting to the server…' });
    if (s.status === 'reconnecting') {
      list.push({ kind: 'warn', text: s.error || 'Lost the server. Reconnecting…' });
    }
    if (s.muted) {
      list.push({
        kind: 'warn',
        text: "Muted: memes from friends won't show up.",
        action: { label: 'Unmute', run: () => api.setMuted(false) },
      });
    }
    if (s.hotkey && !s.hotkey.ok) {
      list.push({
        kind: 'warn',
        text: `${s.hotkey.label} is taken by another app. Use the trash button or the tray menu to clear your screen.`,
      });
    }
    els.banners.replaceChildren(
      ...list.map((b) => {
        const div = document.createElement('div');
        div.className = `banner ${b.kind}`;
        const span = document.createElement('span');
        span.className = 'banner-text';
        span.textContent = b.text;
        div.append(span);
        if (b.action) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = b.action.label;
          btn.addEventListener('click', b.action.run);
          div.append(btn);
        }
        return div;
      }),
    );
  }

  function renderTargets() {
    const peers = otherPeers();
    if (ui.target !== 'all' && !peers.some((p) => p.id === ui.target)) {
      if (isConnected()) toast(`${ui.targetName} left. Sending to everyone instead.`);
      ui.target = 'all';
      ui.targetName = 'Everyone';
    }

    const chips = [makeChip('all', 'Everyone', null)];
    for (const p of peers) chips.push(makeChip(p.id, p.nickname, p.nickname));
    els.targets.replaceChildren(...chips);

    const alone = isConnected() && peers.length === 0;
    els.aloneHint.hidden = !alone;
    if (alone) {
      els.aloneHint.replaceChildren(
        rich(['Nobody else is here yet. Share the room code ', ['strong', ui.conn.room], ' with your friends.']),
      );
    }
  }

  function makeChip(id, label, avatarName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(ui.target === id));
    if (avatarName) {
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = [...avatarName.trim()][0].toUpperCase();
      av.style.setProperty('--avatar', `hsl(${hueFor(avatarName)} 60% 52%)`);
      btn.append(av);
    }
    const text = document.createElement('span');
    text.className = 'chip-label';
    text.textContent = label;
    btn.append(text);
    btn.title = id === 'all' ? 'Drop it on everyone in the room' : `Drop it only on ${label}`;
    btn.addEventListener('click', () => {
      ui.target = id;
      ui.targetName = label;
      renderTargets();
      updateSummary();
    });
    return btn;
  }

  els.connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.connectError.hidden = true;
    els.connectBtn.disabled = true;
    els.connectBtn.textContent = 'Joining…';
    const res = await api.connect({
      serverUrl: els.serverUrl.value,
      room: els.room.value,
      nickname: els.nickname.value,
    });
    if (!res.ok) {
      els.connectError.textContent = res.error;
      els.connectError.hidden = false;
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Join room';
    }
  });

  els.room.addEventListener('input', () => {
    const cleaned = els.room.value.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9_-]/g, '');
    if (cleaned !== els.room.value) els.room.value = cleaned;
  });

  els.leaveBtn.addEventListener('click', () => api.disconnect());
  els.muteBtn.addEventListener('click', () => api.setMuted(!(ui.conn && ui.conn.muted)));
  els.clearBtn.addEventListener('click', async () => {
    await api.clearScreen();
    toast('Screen cleared.');
  });

  // ------------------------------------------------------------------- tabs

  function switchTab(name) {
    ui.tab = name;
    for (const tab of els.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    els.panelUpload.hidden = name !== 'upload';
    els.panelGifs.hidden = name !== 'gifs';
    if (name === 'gifs' && !ui.gifLoadedOnce) loadGifs();
    updateSummary();
  }

  for (const tab of els.tabs) tab.addEventListener('click', () => switchTab(tab.dataset.tab));

  // ----------------------------------------------------------------- upload

  async function handleFile(file) {
    if (!file) return;
    const typeOk = IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name || '');
    if (!typeOk) {
      toast('Only PNG, JPG, GIF and WebP images work.', 'error');
      return;
    }
    if (file.size > maxBytes()) {
      toast(`That image is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes())}.`, 'error');
      return;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      toast("Couldn't read that file.", 'error');
      return;
    }
    if (ui.upload) URL.revokeObjectURL(ui.upload.url);
    ui.upload = { bytes, name: file.name || 'Pasted image', size: file.size, url: URL.createObjectURL(file) };
    renderUpload();
    switchTab('upload');
  }

  function renderUpload() {
    const has = Boolean(ui.upload);
    els.dzEmpty.hidden = has;
    els.dzPreview.hidden = !has;
    els.dropzone.classList.toggle('has-file', has);
    els.dropzone.title = has ? 'Click to pick a different image' : '';
    if (has) {
      els.uploadPreview.src = ui.upload.url;
      els.uploadName.textContent = ui.upload.name;
      els.uploadSize.textContent = formatBytes(ui.upload.size);
    } else {
      els.uploadPreview.removeAttribute('src');
    }
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

  // Drag an image anywhere onto the window.
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (!els.mainView.hidden) {
      if (ui.tab !== 'upload') switchTab('upload');
      els.dropzone.classList.add('dragging');
    }
  });
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = els.mainView.hidden ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropzone.classList.remove('dragging');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('dragging');
    if (els.mainView.hidden) return;
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // Paste a screenshot / copied image with Ctrl+V.
  document.addEventListener('paste', (event) => {
    if (els.mainView.hidden || !event.clipboardData) return;
    const item = [...event.clipboardData.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return; // let normal text paste happen
    event.preventDefault();
    const file = item.getAsFile();
    if (file) {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      handleFile(new File([file], file.name && file.name !== 'image.png' ? file.name : `pasted-image.${ext}`, { type: file.type }));
    }
  });

  // ------------------------------------------------------------------- GIFs

  function setGifStatus(text, isError = false) {
    els.gifStatus.textContent = text || '';
    els.gifStatus.classList.toggle('error', Boolean(isError));
  }

  async function loadGifs({ append = false } = {}) {
    if (!isConnected()) {
      setGifStatus('Connect to a room to search GIFs.');
      return;
    }
    if (!ui.conn.features || !ui.conn.features.giphy) {
      els.gifGrid.replaceChildren();
      els.gifMore.hidden = true;
      setGifStatus("GIF search isn't set up on this server yet. Whoever runs it needs to add a GIPHY_API_KEY (see the README).");
      ui.gifLoadedOnce = true;
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

    const res =
      ui.gifMode === 'search' ? await api.searchGifs(ui.gifQuery, offset) : await api.trendingGifs(offset);
    if (seq !== ui.gifSeq) return; // a newer search started meanwhile

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

    if (ui.gifItems.length === 0) {
      setGifStatus(ui.gifMode === 'search' ? `No GIFs found for “${ui.gifQuery}”.` : 'Nothing trending right now.');
    } else {
      setGifStatus('');
    }
  }

  function makeGifButton(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gif-item';
    btn.dataset.id = item.id;
    btn.setAttribute('aria-pressed', String(Boolean(ui.gif && ui.gif.id === item.id)));
    btn.title = item.user ? `${item.title} · by ${item.user}` : item.title;
    if (item.preview.width && item.preview.height) {
      btn.style.aspectRatio = `${item.preview.width} / ${item.preview.height}`;
    }
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.title;
    img.src = item.preview.url;
    btn.append(img);
    btn.addEventListener('click', (event) => {
      // event.detail is 2 on the second click of a double-click: keep it selected.
      selectGif(ui.gif && ui.gif.id === item.id && event.detail < 2 ? null : item);
    });
    // Double-click = select and drop straight away.
    btn.addEventListener('dblclick', () => {
      selectGif(item);
      sendDrop();
    });
    return btn;
  }

  function selectGif(item) {
    ui.gif = item;
    for (const el of els.gifGrid.children) {
      el.setAttribute('aria-pressed', String(Boolean(ui.gif && el.dataset.id === ui.gif.id)));
    }
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

  // --------------------------------------------------------------- controls

  function setRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  }

  function renderOpacity() {
    els.opacityOut.textContent = `${els.opacity.value}%`;
    setRangeFill(els.opacity);
  }

  function renderDuration() {
    els.durationOut.textContent = `${els.duration.value}s`;
    setRangeFill(els.duration);
  }

  function renderPosition() {
    for (const btn of els.position.querySelectorAll('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.value === ui.position));
    }
  }

  els.opacity.addEventListener('input', renderOpacity);
  els.opacity.addEventListener('change', () => api.updatePrefs({ opacity: Number(els.opacity.value) / 100 }));
  els.duration.addEventListener('input', renderDuration);
  els.duration.addEventListener('change', () => api.updatePrefs({ durationMs: Number(els.duration.value) * 1000 }));
  els.position.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    ui.position = btn.dataset.value;
    renderPosition();
    api.updatePrefs({ position: ui.position });
  });

  // ------------------------------------------------------------ send/preview

  function currentPayload() {
    const base = {
      opacity: Number(els.opacity.value) / 100,
      durationMs: Number(els.duration.value) * 1000,
      position: ui.position,
    };
    if (ui.tab === 'upload') {
      return ui.upload ? { kind: 'image', bytes: ui.upload.bytes, ...base } : null;
    }
    if (!ui.gif) return null;
    return {
      kind: 'gif',
      url: ui.gif.full.url,
      width: ui.gif.full.width,
      height: ui.gif.full.height,
      title: ui.gif.title,
      ...base,
    };
  }

  function updateSummary() {
    const target = ui.target === 'all' ? 'Everyone' : ui.targetName;
    let parts;
    if (ui.tab === 'upload' && ui.upload) {
      parts = [['strong', ui.upload.name], ` (${formatBytes(ui.upload.size)}) → `, ['strong', target]];
    } else if (ui.tab === 'gifs' && ui.gif) {
      parts = [['strong', ui.gif.title], ' → ', ['strong', target]];
    } else {
      parts = [ui.tab === 'upload' ? 'Pick an image to drop.' : 'Pick a GIF to drop.'];
    }
    els.summary.replaceChildren(rich(parts));
    updateSendState();
  }

  function updateSendState() {
    const hasSelection = Boolean(currentPayload());
    els.sendBtn.disabled = ui.sending || !hasSelection || !isConnected();
    els.previewBtn.disabled = !hasSelection;
    els.sendBtn.classList.toggle('busy', ui.sending);
  }

  async function sendDrop() {
    if (ui.sending) return;
    const payload = currentPayload();
    if (!payload) {
      toast('Pick an image or a GIF first.', 'error');
      return;
    }
    if (!isConnected()) {
      toast("You're not connected right now.", 'error');
      return;
    }
    ui.sending = true;
    updateSendState();
    const target = ui.target;
    const targetName = ui.targetName;
    const res = await api.sendDrop({ ...payload, to: target });
    ui.sending = false;
    updateSendState();
    if (!res.ok) {
      toast(res.error, 'error');
    } else if (res.delivered === 0) {
      toast("Sent, but nobody else is in the room yet.");
    } else if (target === 'all') {
      toast(`Dropped on ${res.delivered} friend${res.delivered === 1 ? '' : 's'}!`, 'success');
    } else {
      toast(`Dropped on ${targetName}!`, 'success');
    }
  }

  els.sendBtn.addEventListener('click', sendDrop);
  els.previewBtn.addEventListener('click', async () => {
    const payload = currentPayload();
    if (!payload) return;
    const res = await api.previewDrop(payload);
    if (!res.ok) toast(res.error, 'error');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !els.mainView.hidden) {
      event.preventDefault();
      sendDrop();
    }
  });

  // ------------------------------------------------------------- incoming

  function onIncoming({ from, kind, muted }) {
    const what = kind === 'gif' ? 'a GIF' : 'a meme';
    toast(muted ? `${from} sent ${what} (hidden while muted)` : `${from} dropped ${what} on you!`);
  }

  // ----------------------------------------------------------------- start

  async function init() {
    const { settings, state } = await api.init();
    els.serverUrl.value = settings.serverUrl || '';
    els.room.value = settings.room || '';
    els.nickname.value = settings.nickname || '';
    els.opacity.value = String(Math.round((settings.opacity || 1) * 100));
    els.duration.value = String(Math.round((settings.durationMs || 4000) / 1000));
    ui.position = settings.position || 'random';
    renderOpacity();
    renderDuration();
    renderPosition();
    renderUpload();

    api.onState(applyState);
    api.onNotice((n) => toast(n.text, n.kind));
    api.onIncoming(onIncoming);
    applyState(state);

    if (state.status === 'disconnected') {
      const empty = [els.serverUrl, els.room, els.nickname].find((i) => !i.value.trim());
      (empty || els.nickname).focus();
    }
  }

  init();
})();
