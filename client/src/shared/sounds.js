/**
 * Built-in sound effects, synthesised with the Web Audio API (no audio files,
 * so nothing to license and nothing to download). Used by the overlay to play
 * sounds friends send, and by the control window to preview them.
 *
 * play(ctx, id, destination, { volume }) → { duration, stop() }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemeDropSounds = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOUNDS = [
    { id: 'airhorn', label: 'Air horn', emoji: '📯' },
    { id: 'boing', label: 'Boing', emoji: '🦘' },
    { id: 'ding', label: 'Ding', emoji: '🔔' },
    { id: 'drumroll', label: 'Drum roll', emoji: '🥁' },
    { id: 'sad-trombone', label: 'Sad trombone', emoji: '🎺' },
    { id: 'whoosh', label: 'Whoosh', emoji: '💨' },
    { id: 'tada', label: 'Ta-da!', emoji: '🎉' },
    { id: 'siren', label: 'Siren', emoji: '🚨' },
    { id: 'toot', label: 'Toot', emoji: '😳' },
    { id: 'pop', label: 'Pop', emoji: '🎈' },
  ];

  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    let buf = noiseCache.get(ctx);
    if (!buf) {
      buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let seed = 12345; // deterministic noise
      for (let i = 0; i < data.length; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x7fffffff) * 2 - 1;
      }
      noiseCache.set(ctx, buf);
    }
    return buf;
  }

  /** Small helper that tracks every node it starts so stop() can silence them all. */
  function kit(ctx, out) {
    const sources = [];
    const k = {
      ctx,
      out,
      osc(type, freq, t0, t1, dest) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (dest !== false) o.connect(dest || out); // false = modulator, wired up by the caller
        o.start(t0);
        o.stop(t1);
        sources.push(o);
        return o;
      },
      noise(t0, t1, dest) {
        const s = ctx.createBufferSource();
        s.buffer = noiseBuffer(ctx);
        s.loop = true;
        s.connect(dest || out);
        s.start(t0);
        s.stop(t1);
        sources.push(s);
        return s;
      },
      gain(value, dest) {
        const g = ctx.createGain();
        g.gain.value = value;
        g.connect(dest || out);
        return g;
      },
      filter(type, freq, q, dest) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        if (q !== undefined) f.Q.value = q;
        f.connect(dest || out);
        return f;
      },
      /** Attack-hold-release envelope on a gain node. */
      env(g, t0, attack, hold, release, peak = 1) {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
        g.gain.setValueAtTime(peak, t0 + attack + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
      },
      stopAll() {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            /* already stopped */
          }
        }
      },
    };
    return k;
  }

  function distortion(ctx, amount) {
    const ws = ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    ws.curve = curve;
    return ws;
  }

  const RECIPES = {
    airhorn(k, t) {
      const { ctx } = k;
      const lp = k.filter('lowpass', 2600, 0.7);
      const shaper = distortion(ctx, 4);
      shaper.connect(lp);
      const blasts = [
        [0, 0.16],
        [0.22, 0.16],
        [0.44, 0.85],
      ];
      for (const [start, len] of blasts) {
        const g = k.gain(0, shaper);
        k.env(g, t + start, 0.02, len - 0.08, 0.06, 0.35);
        for (const [f, type] of [
          [415, 'sawtooth'],
          [419, 'sawtooth'],
          [830, 'sawtooth'],
          [207.5, 'square'],
        ]) {
          const o = k.osc(type, f, t + start, t + start + len + 0.02, g);
          o.frequency.setValueAtTime(f, t + start + len - 0.1);
          o.frequency.linearRampToValueAtTime(f * 0.94, t + start + len);
        }
      }
      return 1.35;
    },

    boing(k, t) {
      const g = k.gain(0);
      k.env(g, t, 0.01, 0.1, 0.6, 0.6);
      const o = k.osc('sine', 180, t, t + 0.8, g);
      o.frequency.exponentialRampToValueAtTime(620, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(160, t + 0.75);
      const lfo = k.osc('sine', 14, t, t + 0.8, false);
      const depth = k.ctx.createGain();
      depth.gain.setValueAtTime(90, t);
      depth.gain.exponentialRampToValueAtTime(5, t + 0.75);
      lfo.connect(depth);
      depth.connect(o.frequency);
      return 0.8;
    },

    ding(k, t) {
      for (const [f, level, decay] of [
        [1318.5, 0.5, 1.4],
        [2637, 0.18, 0.8],
        [3951, 0.08, 0.5],
      ]) {
        const g = k.gain(0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(level, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        k.osc('sine', f, t, t + decay + 0.05, g);
      }
      return 1.45;
    },

    drumroll(k, t) {
      const bp = k.filter('bandpass', 1800, 0.8);
      let time = t;
      let gap = 0.07;
      while (time < t + 1.4) {
        const g = k.gain(0, bp);
        k.env(g, time, 0.003, 0.01, 0.05, 0.5);
        k.noise(time, time + 0.08, g);
        time += gap;
        gap = Math.max(0.035, gap * 0.95);
      }
      // Crash + kick
      const crashT = t + 1.45;
      const hp = k.filter('highpass', 4500, 0.7);
      const cg = k.gain(0, hp);
      k.env(cg, crashT, 0.005, 0.02, 0.9, 0.5);
      k.noise(crashT, crashT + 1, cg);
      const kg = k.gain(0);
      k.env(kg, crashT, 0.005, 0.03, 0.3, 0.9);
      const kick = k.osc('sine', 120, crashT, crashT + 0.4, kg);
      kick.frequency.exponentialRampToValueAtTime(45, crashT + 0.3);
      return 2.45;
    },

    'sad-trombone': function sadTrombone(k, t) {
      const lp = k.filter('lowpass', 900, 1.5);
      const notes = [
        [293.66, 0, 0.45],
        [277.18, 0.5, 0.45],
        [261.63, 1.0, 0.45],
        [246.94, 1.5, 1.1],
      ];
      for (const [f, start, len] of notes) {
        const g = k.gain(0, lp);
        k.env(g, t + start, 0.04, len - 0.2, 0.18, 0.35);
        const o = k.osc('sawtooth', f, t + start, t + start + len + 0.05, g);
        if (len > 1) {
          const lfo = k.osc('sine', 5.5, t + start, t + start + len, false);
          const depth = k.ctx.createGain();
          depth.gain.value = 7;
          lfo.connect(depth);
          depth.connect(o.frequency);
        }
      }
      lp.frequency.setValueAtTime(500, t);
      for (const [, start] of notes) {
        lp.frequency.setValueAtTime(500, t + start);
        lp.frequency.linearRampToValueAtTime(1400, t + start + 0.15);
        lp.frequency.linearRampToValueAtTime(700, t + start + 0.4);
      }
      return 2.65;
    },

    whoosh(k, t) {
      const bp = k.filter('bandpass', 300, 1.2);
      bp.frequency.setValueAtTime(250, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + 0.45);
      bp.frequency.exponentialRampToValueAtTime(500, t + 0.85);
      const g = k.gain(0, bp);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      k.noise(t, t + 0.95, g);
      return 0.95;
    },

    tada(k, t) {
      const lp = k.filter('lowpass', 2500, 0.8);
      const chord = [523.25, 659.25, 783.99, 1046.5];
      for (const [start, len] of [
        [0, 0.14],
        [0.18, 1.1],
      ]) {
        for (const f of chord) {
          const g = k.gain(0, lp);
          k.env(g, t + start, 0.015, len * 0.6, len * 0.4, 0.12);
          k.osc('sawtooth', f, t + start, t + start + len + 0.05, g);
          k.osc('triangle', f * 2, t + start, t + start + len + 0.05, g);
        }
      }
      return 1.35;
    },

    siren(k, t) {
      const g = k.gain(0);
      k.env(g, t, 0.03, 1.8, 0.15, 0.22);
      const o = k.osc('square', 650, t, t + 2.05, k.filter('lowpass', 1800, 0.7, g));
      for (let i = 0; i < 8; i += 1) o.frequency.setValueAtTime(i % 2 ? 900 : 650, t + i * 0.25);
      return 2.05;
    },

    toot(k, t) {
      const lp = k.filter('lowpass', 420, 2);
      const g = k.gain(0, lp);
      k.env(g, t, 0.02, 0.45, 0.25, 0.9);
      const o = k.osc('sawtooth', 95, t, t + 0.75, g);
      o.frequency.linearRampToValueAtTime(70, t + 0.7);
      const lfo = k.osc('square', 22, t, t + 0.75, false);
      const depth = k.ctx.createGain();
      depth.gain.value = 18;
      lfo.connect(depth);
      depth.connect(o.frequency);
      const ng = k.gain(0, lp);
      k.env(ng, t, 0.02, 0.4, 0.2, 0.15);
      k.noise(t, t + 0.7, ng);
      return 0.8;
    },

    pop(k, t) {
      const g = k.gain(0);
      k.env(g, t, 0.003, 0.02, 0.12, 0.8);
      const o = k.osc('sine', 900, t, t + 0.2, g);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.12);
      return 0.25;
    },
  };

  // Per-sound level so they all sound about equally loud (measured RMS ≈ 0.1).
  const LEVEL = {
    airhorn: 0.3,
    boing: 1,
    ding: 1.2,
    drumroll: 0.55,
    'sad-trombone': 0.85,
    whoosh: 1.7,
    tada: 1,
    siren: 0.7,
    toot: 0.6,
    pop: 1.1,
  };

  function info(id) {
    return SOUNDS.find((s) => s.id === id) || null;
  }

  /**
   * Play a built-in sound. Returns { duration (seconds), stop() }, or null for
   * an unknown id.
   */
  function play(ctx, id, destination, { volume = 1, when = 0 } = {}) {
    const recipe = RECIPES[id];
    if (!recipe) return null;
    // recipe → level → volume → limiter → speakers (the limiter stops any clipping)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    limiter.connect(destination || ctx.destination);
    const master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume)) * (LEVEL[id] || 1);
    master.connect(limiter);
    const k = kit(ctx, master);
    const t = Math.max(ctx.currentTime, when) + 0.02;
    const duration = recipe(k, t);
    let stopped = false;
    return {
      duration,
      stop() {
        if (stopped) return;
        stopped = true;
        k.stopAll();
        try {
          master.disconnect();
          limiter.disconnect();
        } catch {
          /* already disconnected */
        }
      },
    };
  }

  return { SOUNDS, play, info, ids: SOUNDS.map((s) => s.id) };
});
