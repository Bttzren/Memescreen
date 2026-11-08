'use strict';

(() => {
  const stage = document.getElementById('stage');
  const { computeLayout } = window.MemeDropLayout;
  const Sounds = window.MemeDropSounds;
  const LOAD_TIMEOUT_MS = 15000; // give up on media that never loads
  const FADE_MS = 300;

  /** id -> { el, timers: number[], cleanups: Function[] } for drops that are loading or visible */
  const items = new Map();
  let fading = 0;
  let audioCtx = null;

  function audio() {
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function report() {
    window.overlay.reportCount(items.size + fading);
  }

  /** Stop timers, sounds and videos for a drop and free its memory. */
  function dispose(item) {
    item.timers.forEach(clearTimeout);
    item.timers = [];
    for (const fn of item.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function remove(id, { instant = false } = {}) {
    const item = items.get(id);
    if (!item) return;
    items.delete(id);
    dispose(item);
    if (instant || !item.el.isConnected) {
      item.el.remove();
      report();
      return;
    }
    fading += 1;
    item.el.classList.remove('in');
    item.el.classList.add('out');
    setTimeout(() => {
      item.el.remove();
      fading = Math.max(0, fading - 1);
      report();
    }, FADE_MS);
  }

  /** Panic: everything gone and silent, right now. */
  function clearAll() {
    for (const item of items.values()) dispose(item);
    items.clear();
    fading = 0;
    stage.replaceChildren();
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    report();
  }

  function blobUrl(bytes, mime, item) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    item.cleanups.push(() => URL.revokeObjectURL(url));
    return url;
  }

  /**
   * Play the drop's sound (built-in or uploaded) at the receiver's volume.
   * Calls onEnd when it finishes; returns nothing (cleanup is registered on item).
   */
  function playSound(drop, item, onEnd = () => {}) {
    const sound = drop.sound;
    if (!sound || !(drop.volume > 0)) {
      onEnd(0);
      return;
    }
    if (sound.type === 'builtin') {
      const handle = Sounds.play(audio(), sound.id, null, { volume: drop.volume });
      if (!handle) {
        onEnd(0);
        return;
      }
      item.cleanups.push(() => handle.stop());
      item.timers.push(setTimeout(() => onEnd(handle.duration), handle.duration * 1000 + 100));
      return;
    }
    if (sound.type === 'file') {
      const el = new Audio(blobUrl(sound.bytes, sound.mime, item));
      el.volume = drop.volume;
      el.addEventListener('ended', () => onEnd(el.duration));
      el.addEventListener('error', () => onEnd(0));
      el.play().catch(() => onEnd(0));
      item.cleanups.push(() => {
        el.pause();
        el.removeAttribute('src');
        el.load();
      });
    }
  }

  function soundLabel(sound) {
    if (!sound) return '';
    if (sound.type === 'builtin') {
      const info = Sounds.info(sound.id);
      return info ? `${info.emoji} ${info.label}` : 'a sound';
    }
    return `🎵 ${sound.name || 'a sound'}`;
  }

  function makeTag(drop) {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = drop.from || 'Someone';
    const extras = [];
    if (drop.kind === 'gif') extras.push('via GIPHY');
    if (drop.sound && drop.volume > 0) extras.push('🔊');
    if (extras.length) {
      const via = document.createElement('span');
      via.className = 'via';
      via.textContent = ` · ${extras.join(' · ')}`;
      tag.append(via);
    }
    return tag;
  }

  function makeRoom(maxOnScreen) {
    while (items.size >= (maxOnScreen || 6)) remove(items.keys().next().value, { instant: true });
  }

  /** Sound-only drop: a small "Bob played Air horn" pill at the top of the screen. */
  function addSoundOnly(drop) {
    const el = document.createElement('div');
    el.className = `drop drop--sound${drop.preview ? ' drop--preview' : ''}`;
    const audible = drop.volume > 0;
    el.textContent = `${audible ? '🔊' : '🔇'} ${drop.from || 'Someone'}: ${soundLabel(drop.sound)}${audible ? '' : ' (sounds are off)'}`;
    const item = { el, timers: [], cleanups: [] };
    items.set(drop.id, item);
    stage.append(el);
    report();
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));

    const cap = Math.min(drop.maxClipMs || 60000, 60000);
    item.timers.push(setTimeout(() => remove(drop.id), audible ? cap : 2500));
    if (audible) playSound(drop, item, () => remove(drop.id));
  }

  function add(drop) {
    if (!drop || !drop.id || items.has(drop.id)) return;
    makeRoom(drop.maxOnScreen);
    if (drop.kind === 'sound') {
      addSoundOnly(drop);
      return;
    }

    const el = document.createElement('div');
    el.className = `drop drop--${drop.position}${drop.preview ? ' drop--preview' : ''}`;
    const item = { el, timers: [], cleanups: [] };
    items.set(drop.id, item);
    report();

    const isVideo = drop.kind === 'video';
    const media = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      media.playsInline = true;
      media.preload = 'auto';
      media.loop = drop.durationMs > 0; // fixed duration: loop short clips
      media.volume = Math.max(0, Math.min(1, drop.volume || 0));
      media.muted = !(drop.videoSound && drop.volume > 0);
      item.cleanups.push(() => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      });
    } else {
      media.alt = '';
      media.draggable = false;
      media.decoding = 'async';
      media.referrerPolicy = 'no-referrer';
    }

    const timer = document.createElement('div');
    timer.className = 'timer';
    el.append(media, makeTag(drop), timer);

    const loadTimeout = setTimeout(() => remove(drop.id, { instant: true }), LOAD_TIMEOUT_MS);
    item.timers.push(loadTimeout);

    const show = () => {
      if (!items.has(drop.id) || el.isConnected) return; // cleared while loading, or already shown
      clearTimeout(loadTimeout);
      const box = computeLayout({
        position: drop.position,
        imgW: (isVideo ? media.videoWidth : media.naturalWidth) || drop.width,
        imgH: (isVideo ? media.videoHeight : media.naturalHeight) || drop.height,
        viewW: window.innerWidth,
        viewH: window.innerHeight,
      });
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      el.style.setProperty('--rot', `${box.rotation}deg`);
      media.style.opacity = String(drop.opacity);
      stage.append(el);

      let lifetime = drop.durationMs;
      if (isVideo) {
        if (!(drop.durationMs > 0)) {
          // Whole clip: until it ends (capped).
          const cap = drop.maxClipMs || 60000;
          lifetime = Number.isFinite(media.duration) && media.duration > 0 ? Math.min(media.duration * 1000, cap) : cap;
          media.addEventListener('ended', () => remove(drop.id));
        }
        media.play().catch(() => {
          // If sound is blocked for some reason, play silently rather than not at all.
          media.muted = true;
          media.play().catch(() => {});
        });
      }
      timer.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
        duration: lifetime,
        easing: 'linear',
        fill: 'forwards',
      });
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
      item.timers.push(setTimeout(() => remove(drop.id), lifetime + 50));
      playSound(drop, item);
    };

    if (isVideo) {
      media.addEventListener('loadeddata', show, { once: true });
    } else {
      media.addEventListener('load', show, { once: true });
    }
    media.addEventListener('error', () => remove(drop.id, { instant: true }));
    media.src = drop.bytes ? blobUrl(drop.bytes, drop.mime, item) : drop.src;
  }

  window.overlay.onShow(add);
  window.overlay.onClear(clearAll);
})();
