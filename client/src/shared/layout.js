/**
 * Where and how big a drop appears on screen. Pure function so it can be unit
 * tested in Node and loaded as a plain <script> in the overlay window.
 *
 *   random     – 25–45% of the screen width, random spot, slight tilt
 *   center     – up to 60% of the screen, dead centre
 *   fullscreen – as large as possible while keeping the whole image visible
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemeDropLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_UPSCALE = 2.5; // don't blow tiny images up into a blurry mess (except fullscreen)

  function fit(imgW, imgH, boxW, boxH, maxScale) {
    const scale = Math.min(boxW / imgW, boxH / imgH, maxScale);
    return { width: Math.max(1, Math.round(imgW * scale)), height: Math.max(1, Math.round(imgH * scale)) };
  }

  function computeLayout({ position, imgW, imgH, viewW, viewH, random = Math.random }) {
    const w = imgW > 0 ? imgW : 400;
    const h = imgH > 0 ? imgH : 300;

    if (position === 'fullscreen') {
      const size = fit(w, h, viewW, viewH, Infinity);
      return {
        ...size,
        left: Math.round((viewW - size.width) / 2),
        top: Math.round((viewH - size.height) / 2),
        rotation: 0,
      };
    }

    if (position === 'center') {
      const size = fit(w, h, viewW * 0.6, viewH * 0.6, MAX_UPSCALE);
      return {
        ...size,
        left: Math.round((viewW - size.width) / 2),
        top: Math.round((viewH - size.height) / 2),
        rotation: 0,
      };
    }

    // random
    const boxW = viewW * (0.25 + random() * 0.2);
    const size = fit(w, h, boxW, viewH * 0.5, MAX_UPSCALE);
    const margin = Math.round(Math.min(viewW, viewH) * 0.03);
    const maxLeft = Math.max(margin, viewW - size.width - margin);
    const maxTop = Math.max(margin, viewH - size.height - margin);
    return {
      ...size,
      left: Math.round(margin + random() * (maxLeft - margin)),
      top: Math.round(margin + random() * (maxTop - margin)),
      rotation: Math.round((random() * 12 - 6) * 10) / 10,
    };
  }

  return { computeLayout };
});
