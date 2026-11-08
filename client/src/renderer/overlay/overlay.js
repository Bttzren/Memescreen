'use strict';

(() => {
  const stage = document.getElementById('stage');
  const { computeLayout } = window.MemeDropLayout;
  const LOAD_TIMEOUT_MS = 15000; // give up on a GIF that never loads
  const FADE_MS = 300;

  /** id -> { el, timers: number[] } for drops that are loading or visible */
  const items = new Map();
  let fading = 0;

  function report() {
    window.overlay.reportCount(items.size + fading);
  }

  function remove(id, { instant = false } = {}) {
    const item = items.get(id);
    if (!item) return;
    items.delete(id);
    item.timers.forEach(clearTimeout);
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

  function clearAll() {
    for (const item of items.values()) item.timers.forEach(clearTimeout);
    items.clear();
    fading = 0;
    stage.replaceChildren();
    report();
  }

  function add(drop) {
    if (!drop || !drop.id || items.has(drop.id)) return;

    // Too many on screen? Drop the oldest.
    const max = drop.maxOnScreen || 6;
    while (items.size >= max) remove(items.keys().next().value, { instant: true });

    const el = document.createElement('div');
    el.className = `drop drop--${drop.position}${drop.preview ? ' drop--preview' : ''}`;

    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = drop.from || 'Someone';
    if (drop.kind === 'gif') {
      const via = document.createElement('span');
      via.className = 'via';
      via.textContent = ' · via GIPHY';
      tag.append(via);
    }

    const timer = document.createElement('div');
    timer.className = 'timer';

    el.append(img, tag, timer);
    const item = { el, timers: [] };
    items.set(drop.id, item);
    report();

    const loadTimeout = setTimeout(() => remove(drop.id, { instant: true }), LOAD_TIMEOUT_MS);
    item.timers.push(loadTimeout);

    img.addEventListener('load', () => {
      if (!items.has(drop.id)) return; // cleared while loading
      clearTimeout(loadTimeout);
      const box = computeLayout({
        position: drop.position,
        imgW: img.naturalWidth || drop.width,
        imgH: img.naturalHeight || drop.height,
        viewW: window.innerWidth,
        viewH: window.innerHeight,
      });
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      el.style.setProperty('--rot', `${box.rotation}deg`);
      img.style.opacity = String(drop.opacity);

      stage.append(el);
      timer.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
        duration: drop.durationMs,
        easing: 'linear',
        fill: 'forwards',
      });
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
      item.timers.push(setTimeout(() => remove(drop.id), drop.durationMs));
    });

    img.addEventListener('error', () => remove(drop.id, { instant: true }));
    img.src = drop.src;
  }

  window.overlay.onShow(add);
  window.overlay.onClear(clearAll);
})();
