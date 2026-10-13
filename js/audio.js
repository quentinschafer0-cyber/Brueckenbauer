/*
 * Brückenbauer – audio.js
 * ----------------------------------------------------------------------------
 * All sound effects are synthesised with the Web Audio API (no audio files).
 *
 *   BB.Audio.unlock()            create/resume the AudioContext – call from a
 *                                user gesture (iOS only allows audio after one)
 *   BB.Audio.play(name, opts?)   'click' 'place' 'delete' 'error' 'start'
 *                                'break' 'splash' 'win' 'fail' 'star'
 *                                opts (optional): { m: materialKey } for 'break'
 *                                (steel rings, rope twangs, wood just cracks)
 *   BB.Audio.setMuted(bool), BB.Audio.muted
 *
 * Nothing in here ever throws; play() is a no-op while muted or when Web Audio
 * is unavailable. All envelopes start and end at zero (no clicks/pops); a gentle
 * compressor on the master bus keeps overlapping sounds from clipping.
 *
 * iOS notes: the context starts "suspended" and must be resumed inside a user
 * gesture; after a phone call / app switch it can become "interrupted". This
 * module therefore also listens to every user gesture itself and resumes the
 * context whenever it is not running.
 */
(function (BB) {
  'use strict';

  var G = globalThis;
  var AC = G.AudioContext || G.webkitAudioContext || null;

  var MASTER_VOLUME = 0.8;
  var MAX_VOICES = 14;                 // simultaneous sounds (collapse = many 'break' events)
  var MIN_GAP = {                      // seconds between two starts of the same sound
    click: 0.035, place: 0.03, 'delete': 0.04, error: 0.12, start: 0.5,
    'break': 0.06, splash: 0.12, win: 1.0, fail: 1.0, star: 0.12
  };
  var NAMES = ['click', 'place', 'delete', 'error', 'start', 'break', 'splash', 'win', 'fail', 'star'];

  var ctx = null;                      // live AudioContext (lazy)
  var kit = null;                      // node helpers bound to ctx
  var masterGain = null;
  var resumeAskedAt = -1e9;            // performance time of the last resume() request
  var silentPlayed = false;
  var lastStart = {};
  var voiceEnds = [];

  function nowMs() { return (G.performance && G.performance.now) ? G.performance.now() : Date.now(); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function vary(f, amount) { return f * (1 + rand(-amount, amount)); }

  // ---------------------------------------------------------------------------
  // Synth kit: small helpers that build short-lived node graphs on a context.
  // Used for the live context and for OfflineAudioContext rendering (tests).
  // ---------------------------------------------------------------------------

  function makeKit(c, dest) {
    // 2 s of white noise, shared by all noise sounds (random start offsets)
    var len = Math.floor(c.sampleRate * 2);
    var noise = c.createBuffer(1, len, c.sampleRate);
    var data = noise.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Attack → hold → exponential decay, starting and ending at exactly 0.
    function envelope(param, t0, peak, attack, hold, decay) {
      var tA = t0 + Math.max(0.001, attack);
      var tH = tA + Math.max(0, hold);
      var tE = tH + Math.max(0.005, decay);
      param.cancelScheduledValues(t0);
      param.setValueAtTime(0, t0);
      param.linearRampToValueAtTime(peak, tA);
      if (hold > 0) param.setValueAtTime(peak, tH);
      param.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.0005), tE);
      param.linearRampToValueAtTime(0, tE + 0.012);
      return tE + 0.02;
    }

    function connectChain(nodes, out) {
      for (var i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      nodes[nodes.length - 1].connect(out || dest);
    }

    // Pitched tone. o: {type, freq, freqEnd, glide, t0, vol, attack, hold, decay,
    //                  detune, filter:{type,freq,Q}, vibrato:{rate,depth,delay}, out}
    function tone(o) {
      var t0 = o.t0;
      var osc = c.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + (o.glide || 0.1));
      if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
      var g = c.createGain();
      g.gain.value = 0;
      var end = envelope(g.gain, t0, o.vol, o.attack || 0.005, o.hold || 0, o.decay || 0.2);
      var chain = [osc];
      if (o.filter) {
        var f = c.createBiquadFilter();
        f.type = o.filter.type || 'lowpass';
        f.frequency.setValueAtTime(o.filter.freq, t0);
        if (o.filter.freqEnd) f.frequency.exponentialRampToValueAtTime(o.filter.freqEnd, t0 + (o.filter.glide || 0.2));
        f.Q.value = o.filter.Q || 0.7;
        chain.push(f);
      }
      chain.push(g);
      connectChain(chain, o.out);
      if (o.vibrato) {
        var lfo = c.createOscillator();
        var lg = c.createGain();
        lfo.frequency.value = o.vibrato.rate;
        lg.gain.setValueAtTime(0, t0);
        lg.gain.linearRampToValueAtTime(o.vibrato.depth, t0 + (o.vibrato.delay || 0.1));
        lfo.connect(lg);
        lg.connect(osc.frequency);
        lfo.start(t0);
        lfo.stop(end);
      }
      osc.start(t0);
      osc.stop(end);
      return end;
    }

    // Filtered noise burst. o: {t0, vol, attack, hold, decay, filter:{type,freq,freqEnd,glide,Q,points}, rate, out}
    function noiseBurst(o) {
      var t0 = o.t0;
      var src = c.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = o.rate || 1;
      var f = c.createBiquadFilter();
      var fo = o.filter || {};
      f.type = fo.type || 'bandpass';
      f.Q.value = fo.Q || 1;
      f.frequency.setValueAtTime(fo.freq || 1000, t0);
      if (fo.points) {
        fo.points.forEach(function (p) { f.frequency.exponentialRampToValueAtTime(p[1], t0 + p[0]); });
      } else if (fo.freqEnd) {
        f.frequency.exponentialRampToValueAtTime(fo.freqEnd, t0 + (fo.glide || 0.2));
      }
      var g = c.createGain();
      g.gain.value = 0;
      var end = envelope(g.gain, t0, o.vol, o.attack || 0.002, o.hold || 0, o.decay || 0.1);
      connectChain([src, f, g], o.out);
      var offset = Math.random() * Math.max(0, noise.duration - (end - t0) * (o.rate || 1) - 0.05);
      src.start(t0, offset);
      src.stop(end);
      return end;
    }

    // A gain node (optionally panned) that a sound routes its parts into.
    function bus(vol, pan) {
      var g = c.createGain();
      g.gain.value = vol;
      if (pan && c.createStereoPanner) {
        var p = c.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        p.connect(dest);
      } else {
        g.connect(dest);
      }
      return g;
    }

    return { c: c, tone: tone, noise: noiseBurst, bus: bus };
  }

  // ---------------------------------------------------------------------------
  // Sound recipes. Each gets (kit, t0, opts) and returns its end time.
  // ---------------------------------------------------------------------------

  var SOUNDS = {
    // Soft UI tick.
    click: function (k, t0) {
      var out = k.bus(0.9);
      var e1 = k.tone({ t0: t0, type: 'sine', freq: 1750, freqEnd: 1100, glide: 0.025, vol: 0.16, attack: 0.002, decay: 0.045, out: out });
      var e2 = k.tone({ t0: t0, type: 'triangle', freq: 3300, vol: 0.035, attack: 0.001, decay: 0.018, out: out });
      return Math.max(e1, e2);
    },

    // Short wooden "tock": resonant body + tiny contact click + a little weight.
    place: function (k, t0) {
      var out = k.bus(1);
      var f = vary(820, 0.04);
      var ends = [
        k.tone({ t0: t0, type: 'sine', freq: f, freqEnd: f * 0.82, glide: 0.06, vol: 0.42, attack: 0.0015, decay: 0.1, out: out }),
        k.tone({ t0: t0, type: 'triangle', freq: f * 2.42, vol: 0.07, attack: 0.001, decay: 0.035, out: out }),
        k.tone({ t0: t0, type: 'sine', freq: 190, freqEnd: 140, glide: 0.06, vol: 0.2, attack: 0.002, decay: 0.07, out: out }),
        k.noise({ t0: t0, vol: 0.16, attack: 0.001, decay: 0.02, filter: { type: 'bandpass', freq: 2600, Q: 1.3 }, out: out })
      ];
      return Math.max.apply(null, ends);
    },

    // Soft descending "pop" when a beam is removed.
    'delete': function (k, t0) {
      var out = k.bus(1);
      var e1 = k.tone({ t0: t0, type: 'sine', freq: 640, freqEnd: 230, glide: 0.13, vol: 0.3, attack: 0.004, decay: 0.15, out: out });
      var e2 = k.tone({ t0: t0, type: 'triangle', freq: 1280, freqEnd: 460, glide: 0.1, vol: 0.05, attack: 0.003, decay: 0.08, out: out });
      var e3 = k.noise({ t0: t0, vol: 0.05, attack: 0.002, decay: 0.05, filter: { type: 'highpass', freq: 2500, Q: 0.7 }, out: out });
      return Math.max(e1, e2, e3);
    },

    // Low, muffled double buzz ("bzz-bzz") for invalid actions.
    error: function (k, t0) {
      var out = k.bus(1);
      var end = t0;
      [0, 0.15].forEach(function (dt, i) {
        var t = t0 + dt;
        var lp = { type: 'lowpass', freq: 750, Q: 1.2 };
        end = Math.max(end,
          k.tone({ t0: t, type: 'sawtooth', freq: i ? 104 : 110, vol: 0.13, attack: 0.008, hold: 0.07, decay: 0.06, filter: lp, out: out }),
          k.tone({ t0: t, type: 'square', freq: i ? 107 : 113.5, vol: 0.05, attack: 0.008, hold: 0.07, decay: 0.06, filter: lp, out: out }),
          k.tone({ t0: t, type: 'sine', freq: i ? 52 : 55, vol: 0.14, attack: 0.008, hold: 0.07, decay: 0.06, out: out }));
      });
      return end;
    },

    // Engine start: starter "chug-chug-chug", then the engine catches and revs.
    start: function (k, t0) {
      var c = k.c;
      var out = k.bus(1);
      var end = t0;
      for (var i = 0; i < 3; i++) {
        var tc = t0 + i * 0.1;
        end = Math.max(end,
          k.noise({ t0: tc, vol: 0.2, attack: 0.006, decay: 0.07, filter: { type: 'lowpass', freq: 420, Q: 1.5 }, out: out }),
          k.tone({ t0: tc, type: 'sine', freq: 70, freqEnd: 52, glide: 0.06, vol: 0.18, attack: 0.006, decay: 0.07, out: out }));
      }
      // engine: two detuned saws → resonant low-pass, amplitude-modulated ("putt-putt")
      var tE = t0 + 0.3, dur = 0.95;
      var fCurve = [[0, 34], [0.22, 92], [0.42, 78], [0.6, 64], [dur, 58]];
      var lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(380, tE);
      lp.frequency.exponentialRampToValueAtTime(1300, tE + 0.22);
      lp.frequency.exponentialRampToValueAtTime(650, tE + 0.6);
      lp.frequency.exponentialRampToValueAtTime(520, tE + dur);
      var am = c.createGain();
      am.gain.value = 0.62;
      var env = c.createGain();
      env.gain.value = 0;
      env.gain.setValueAtTime(0, tE);
      env.gain.linearRampToValueAtTime(0.32, tE + 0.06);
      env.gain.setValueAtTime(0.32, tE + 0.5);
      env.gain.exponentialRampToValueAtTime(0.0003, tE + dur);
      env.gain.linearRampToValueAtTime(0, tE + dur + 0.012);
      lp.connect(am);
      am.connect(env);
      env.connect(out);
      var oscs = [];
      [[1, 'sawtooth'], [1.012, 'sawtooth'], [0.5, 'triangle']].forEach(function (d) {
        var o = c.createOscillator();
        o.type = d[1];
        o.frequency.setValueAtTime(fCurve[0][1] * d[0], tE);
        for (var j = 1; j < fCurve.length; j++) o.frequency.exponentialRampToValueAtTime(fCurve[j][1] * d[0], tE + fCurve[j][0]);
        o.connect(lp);
        oscs.push(o);
      });
      // firing pulses: LFO at half the engine frequency modulates the amplitude
      var lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(fCurve[0][1] * 0.5, tE);
      for (var j2 = 1; j2 < fCurve.length; j2++) lfo.frequency.exponentialRampToValueAtTime(fCurve[j2][1] * 0.5, tE + fCurve[j2][0]);
      var lfoGain = c.createGain();
      lfoGain.gain.value = 0.38;
      lfo.connect(lfoGain);
      lfoGain.connect(am.gain);
      var stopAt = tE + dur + 0.03;
      oscs.concat([lfo]).forEach(function (o) { o.start(tE); o.stop(stopAt); });
      // a little exhaust rumble
      k.noise({ t0: tE, vol: 0.07, attack: 0.05, hold: 0.3, decay: 0.5, filter: { type: 'lowpass', freq: 300, Q: 0.8 }, out: out });
      return Math.max(end, stopAt);
    },

    // Crunchy crack (several noise grains) + low thump; steel adds a metallic
    // clang, rope a twang.
    'break': function (k, t0, opts) {
      var m = (opts && opts.m) || '';
      var out = k.bus(1, rand(-0.25, 0.25));
      var ends = [];
      // initial snap
      ends.push(k.noise({ t0: t0, vol: 0.5, attack: 0.001, decay: 0.07, filter: { type: 'bandpass', freq: vary(1800, 0.15), Q: 0.7 }, out: out }));
      // crackle grains
      var n = 5 + Math.floor(Math.random() * 3);
      for (var i = 0; i < n; i++) {
        var tg = t0 + 0.008 + Math.pow(Math.random(), 1.6) * 0.16;
        ends.push(k.noise({ t0: tg, vol: rand(0.12, 0.3) * (1 - i / (n + 2)), attack: 0.001, decay: rand(0.012, 0.035),
          filter: { type: 'bandpass', freq: rand(1300, 4200), Q: rand(1, 3) }, out: out }));
      }
      // low thump
      ends.push(k.tone({ t0: t0 + 0.004, type: 'sine', freq: 115, freqEnd: 42, glide: 0.2, vol: 0.55, attack: 0.003, decay: 0.3, out: out }));
      ends.push(k.noise({ t0: t0, vol: 0.18, attack: 0.002, decay: 0.16, filter: { type: 'lowpass', freq: 260, Q: 0.9 }, out: out }));
      if (m === 'steel' || m === 'steelroad') {
        [[523, 0.6], [1287, 0.4], [2213, 0.28], [3121, 0.18]].forEach(function (p, j) {
          ends.push(k.tone({ t0: t0 + 0.01, type: 'sine', freq: vary(p[0], 0.02), vol: 0.07 / (1 + j * 0.4), attack: 0.002, decay: p[1], out: out }));
        });
      } else if (m === 'rope') {
        ends.push(k.tone({ t0: t0, type: 'triangle', freq: 260, freqEnd: 170, glide: 0.35, vol: 0.12, attack: 0.002, decay: 0.4,
          filter: { type: 'lowpass', freq: 1800, freqEnd: 500, glide: 0.35, Q: 2 }, vibrato: { rate: 14, depth: 9, delay: 0.05 }, out: out }));
      }
      return Math.max.apply(null, ends);
    },

    // Airy whoosh (sweeping band-pass noise) + a "plunk" + a few droplets.
    splash: function (k, t0) {
      var out = k.bus(1, rand(-0.2, 0.2));
      var ends = [];
      ends.push(k.noise({ t0: t0, vol: 0.38, attack: 0.035, hold: 0.04, decay: 0.55,
        filter: { type: 'bandpass', freq: 500, Q: 0.9, points: [[0.09, 2300], [0.6, 650]] }, out: out }));
      ends.push(k.noise({ t0: t0, vol: 0.12, attack: 0.02, decay: 0.35, filter: { type: 'highpass', freq: 3500, Q: 0.6 }, out: out }));
      ends.push(k.tone({ t0: t0, type: 'sine', freq: 280, freqEnd: 115, glide: 0.12, vol: 0.22, attack: 0.004, decay: 0.14, out: out }));
      for (var i = 0; i < 4; i++) {
        var td = t0 + rand(0.12, 0.5);
        var f = rand(900, 1500);
        ends.push(k.tone({ t0: td, type: 'sine', freq: f, freqEnd: f * rand(1.5, 1.9), glide: 0.04, vol: rand(0.04, 0.08), attack: 0.003, decay: 0.05, out: out }));
      }
      return Math.max.apply(null, ends);
    },

    // Cheerful ascending jingle C–E–G–C with a final chord and some sparkle.
    win: function (k, t0) {
      var out = k.bus(1);
      var ends = [];
      var notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach(function (f, i) {
        var t = t0 + i * 0.11;
        var last = i === notes.length - 1;
        var dec = last ? 1.0 : 0.3;
        ends.push(k.tone({ t0: t, type: 'triangle', freq: f, vol: last ? 0.2 : 0.17, attack: 0.008, hold: last ? 0.12 : 0.02, decay: dec, out: out }));
        ends.push(k.tone({ t0: t, type: 'sine', freq: f * 2, vol: 0.05, attack: 0.006, decay: dec * 0.6, out: out }));
      });
      var tc = t0 + 0.33;
      [659.25, 783.99].forEach(function (f) {
        ends.push(k.tone({ t0: tc, type: 'sine', freq: f, vol: 0.09, attack: 0.02, hold: 0.12, decay: 0.9, out: out }));
      });
      ends.push(k.tone({ t0: tc, type: 'sine', freq: 261.63, vol: 0.12, attack: 0.02, hold: 0.1, decay: 0.8, out: out }));
      [2093, 2637, 3136, 4186].forEach(function (f, i) {
        ends.push(k.tone({ t0: tc + 0.05 + i * 0.05, type: 'sine', freq: f, vol: 0.035, attack: 0.003, decay: 0.22, out: out }));
      });
      return Math.max.apply(null, ends);
    },

    // Descending "wah-wah-wah-waaah" (sad trombone): saw through a resonant
    // low-pass whose cutoff opens and closes on every note.
    fail: function (k, t0) {
      var c = k.c;
      var out = k.bus(1);
      var notes = [[392.0, 0.3], [369.99, 0.3], [349.23, 0.3], [329.63, 0.95]];
      var t = t0;
      var end = t0;
      notes.forEach(function (n, i) {
        var f = n[0], d = n[1];
        var last = i === notes.length - 1;
        var lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 5;
        lp.frequency.setValueAtTime(320, t);
        lp.frequency.exponentialRampToValueAtTime(1500, t + Math.min(0.12, d * 0.4));
        lp.frequency.exponentialRampToValueAtTime(last ? 380 : 450, t + d);
        if (last) {
          // final note: slow "wah" wobble
          for (var w = 1; w <= 3; w++) {
            lp.frequency.exponentialRampToValueAtTime(1100, t + d + w * 0.16 - 0.08);
            lp.frequency.exponentialRampToValueAtTime(380, t + d + w * 0.16);
          }
        }
        var g = c.createGain();
        g.gain.value = 0;
        var len = last ? d + 0.5 : d * 0.92;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.2, t + 0.035);
        g.gain.setValueAtTime(0.2, t + len * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0004, t + len);
        g.gain.linearRampToValueAtTime(0, t + len + 0.012);
        var o1 = c.createOscillator();
        o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(f, t);
        if (last) o1.frequency.exponentialRampToValueAtTime(f * 0.94, t + len);
        var o2 = c.createOscillator();
        o2.type = 'sine';
        o2.frequency.setValueAtTime(f * 0.5, t);
        if (last) o2.frequency.exponentialRampToValueAtTime(f * 0.47, t + len);
        var subGain = c.createGain();
        subGain.gain.value = 0.5;
        o1.connect(lp);
        o2.connect(subGain);
        subGain.connect(lp);
        lp.connect(g);
        g.connect(out);
        var stopAt = t + len + 0.03;
        o1.start(t); o2.start(t);
        o1.stop(stopAt); o2.stop(stopAt);
        end = Math.max(end, stopAt);
        t += d;
      });
      return end;
    },

    // Sparkle: quick high arpeggio with a shimmering double and a breath of air.
    star: function (k, t0) {
      var out = k.bus(1);
      var ends = [];
      [1318.5, 1568.0, 1975.5, 2637.0].forEach(function (f, i) {
        var t = t0 + i * 0.055;
        ends.push(k.tone({ t0: t, type: 'sine', freq: f, vol: 0.12, attack: 0.003, decay: 0.32, out: out }));
        ends.push(k.tone({ t0: t, type: 'triangle', freq: f * 2, detune: 7, vol: 0.025, attack: 0.003, decay: 0.18, out: out }));
      });
      ends.push(k.noise({ t0: t0 + 0.05, vol: 0.035, attack: 0.03, decay: 0.3, filter: { type: 'highpass', freq: 6500, Q: 0.7 }, out: out }));
      return Math.max.apply(null, ends);
    }
  };

  // ---------------------------------------------------------------------------
  // Live context handling
  // ---------------------------------------------------------------------------

  function buildGraph(c) {
    var comp = c.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    comp.connect(c.destination);
    var mg = c.createGain();
    mg.gain.value = api.muted ? 0 : MASTER_VOLUME;
    mg.connect(comp);
    return mg;
  }

  function resume() {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    resumeAskedAt = nowMs();
    try {
      var p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(null, function () { /* not allowed yet */ });
    } catch (e) { /* ignore */ }
  }

  function unlock() {
    try {
      if (!AC) return false;
      if (!ctx) {
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
        masterGain = buildGraph(ctx);
        kit = makeKit(ctx, masterGain);
      }
      if (ctx.state === 'closed') return false;
      var wasRunning = ctx.state === 'running';
      resume();
      // Older iOS versions only really unlock once a sound was started inside
      // the gesture → play one silent sample (again, until the context runs).
      if (!silentPlayed || !wasRunning) {
        silentPlayed = true;
        var b = ctx.createBuffer(1, 1, ctx.sampleRate);
        var s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function setMuted(m) {
    api.muted = !!m;
    try {
      if (ctx && masterGain) {
        var t = ctx.currentTime;
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(masterGain.gain.value, t);
        masterGain.gain.linearRampToValueAtTime(api.muted ? 0 : MASTER_VOLUME, t + 0.03);
      }
    } catch (e) { /* ignore */ }
  }

  function play(name, opts) {
    try {
      if (api.muted || !ctx || !kit) return;
      var recipe = SOUNDS[name];
      if (!recipe) return;
      if (ctx.state !== 'running') {
        if (ctx.state === 'closed') return;
        // Suspended/interrupted: sounds may still be scheduled right after a
        // resume request (the tap that unlocked audio should make a sound);
        // otherwise skip – they would all burst out later at once.
        if (nowMs() - resumeAskedAt > 400) { resume(); return; }
      }
      // (re-)apply the master level in case `muted` was changed directly
      if (masterGain.gain.value < 0.001 && !api.muted) setMuted(false);
      var t = ctx.currentTime;
      var gap = MIN_GAP[name] || 0.03;
      if (lastStart[name] !== undefined && t - lastStart[name] < gap && t >= lastStart[name]) return;
      voiceEnds = voiceEnds.filter(function (e) { return e > t; });
      if (voiceEnds.length >= MAX_VOICES) return;
      lastStart[name] = t;
      var end = recipe(kit, t + 0.01, opts || {});
      voiceEnds.push(isFinite(end) ? end : t + 1);
    } catch (e) { /* never throw */ }
  }

  // Renders one sound into an AudioBuffer with an OfflineAudioContext (used by
  // tests to check levels; not needed by the game).
  function renderOffline(name, opts, seconds) {
    try {
      var OAC = G.OfflineAudioContext || G.webkitOfflineAudioContext;
      if (!OAC || !SOUNDS[name]) return Promise.resolve(null);
      var rate = 44100;
      var oc = new OAC(2, Math.ceil(rate * (seconds || 2.5)), rate);
      var mg = oc.createGain();
      mg.gain.value = MASTER_VOLUME;
      var comp = oc.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
      mg.connect(comp);
      comp.connect(oc.destination);
      SOUNDS[name](makeKit(oc, mg), 0.01, opts || {});
      return oc.startRendering();
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Create/resume on every user gesture while the context is not running (first
  // tap, iOS "interrupted" after calls/app switches, suspended while hidden).
  // main.js calls unlock() as well – this just makes the module self-sufficient.
  function onGesture() {
    if (!AC) return;
    if (!ctx || ctx.state !== 'running') unlock();
  }

  function onVisibility() {
    try {
      if (!ctx || ctx.state === 'closed') return;
      if (document.visibilityState === 'hidden') {
        if (ctx.state === 'running') ctx.suspend().then(null, function () {});
      } else {
        resume();
      }
    } catch (e) { /* ignore */ }
  }

  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'].forEach(function (t) {
        window.addEventListener(t, onGesture, { capture: true, passive: true });
      });
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onVisibility);
    }
  } catch (e) { /* ignore */ }

  var api = {
    unlock: unlock,
    play: play,
    setMuted: setMuted,
    muted: false,
    names: NAMES.slice(),
    get available() { return !!AC; },
    get state() { return ctx ? ctx.state : 'none'; },
    _renderOffline: renderOffline
  };

  BB.Audio = api;
})(globalThis.BB = globalThis.BB || {});
