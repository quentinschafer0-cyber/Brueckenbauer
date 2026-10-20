/*
 * Brückenbauer – audio.js (v3.1: soft and quiet)
 * ----------------------------------------------------------------------------
 * All sounds are synthesised with the Web Audio API (no audio files).
 *
 *   BB.Audio.unlock()             create / resume the AudioContext – call from a user gesture (iOS)
 *   BB.Audio.play(name, opts?)    'click' 'place' 'delete' 'error' 'start' 'break' 'splash' 'win' 'fail' 'star'
 *                                 opts: { m: materialKey } for 'break'
 *   BB.Audio.setMuted(bool)       everything off (kept for the old mute button)
 *   BB.Audio.setVolume(0..1)      master volume (default 0.7; the base level is about 40 % of the old one)
 *   BB.Audio.setEffects(bool)     sound effects on / off
 *   BB.Audio.setMusic(bool)       soft background pad on / off (default OFF)
 *
 * Design: low base level, a low-pass filter on the master bus (nothing shrill), soft envelopes (every sound
 * starts and ends at zero), a little random pitch so repeated sounds do not tire, no loops except the optional
 * music, and a minimum gap between two sounds of the same kind (never fires per frame).
 */
(function (BB) {
  'use strict';

  var G = globalThis;
  var AC = G.AudioContext || G.webkitAudioContext || null;

  var BASE = 0.32;                     // master level at volume 1.0 (the old game used 0.8 → about 40 %)
  var MAX_VOICES = 8;
  var MIN_GAP = { click: 0.08, place: 0.08, 'delete': 0.08, error: 0.2, start: 0.5, 'break': 0.12, splash: 0.2, horn: 1.5, win: 1.2, fail: 1.2, star: 0.2 };
  var NAMES = ['click', 'place', 'delete', 'error', 'start', 'break', 'splash', 'horn', 'win', 'fail', 'star'];

  var ctx = null, master = null, sfxBus = null, musicBus = null;
  var state = { volume: 0.7, effects: true, music: false, muted: false };
  var lastStart = {}, voices = 0, musicTimer = null, musicStep = 0, musicOn = false;

  function now() { return ctx ? ctx.currentTime : 0; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // ------------------------------------------------------------------------------------ building blocks
  function env(g, t0, attack, hold, decay, peak) {
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
    g.gain.linearRampToValueAtTime(0, t0 + attack + hold + decay + 0.01);
    return t0 + attack + hold + decay + 0.02;
  }
  function tone(o) {
    var osc = ctx.createOscillator(), g = ctx.createGain(), node = osc;
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, o.t0);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t0 + (o.glide || 0.08));
    if (o.lp) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = 0.5; osc.connect(f); f.connect(g); } else osc.connect(g);
    var end = env(g, o.t0, o.attack || 0.004, o.hold || 0, o.decay, o.vol);
    g.connect(o.out || sfxBus);
    osc.start(o.t0); osc.stop(end);
    return end;
  }
  var noiseBuf = null;
  function noise(o) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0), last = 0;
      for (var i = 0; i < d.length; i++) { last = last * 0.82 + (Math.random() * 2 - 1) * 0.18; d[i] = last; }   // brownish: soft, no hiss
    }
    var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf; src.loop = true;
    f.type = o.type || 'bandpass'; f.frequency.value = o.freq; f.Q.value = o.Q || 0.8;
    src.connect(f); f.connect(g);
    var end = env(g, o.t0, o.attack || 0.006, o.hold || 0, o.decay, o.vol);
    g.connect(o.out || sfxBus);
    src.start(o.t0, Math.random()); src.stop(end);
    return end;
  }

  // ------------------------------------------------------------------------------------ the sounds
  var SOUNDS = {
    click: function (t) { return tone({ t0: t, f0: 560 * rnd(0.97, 1.03), decay: 0.05, vol: 0.05, lp: 1800 }); },
    place: function (t) {                     // soft wooden "tock"
      var f = 175 * rnd(0.92, 1.1);
      return Math.max(tone({ t0: t, f0: f * 1.35, f1: f, glide: 0.03, type: 'triangle', decay: 0.09, vol: 0.2, lp: 1100 }),
        noise({ t0: t, freq: 700, Q: 0.7, decay: 0.03, vol: 0.05, type: 'lowpass' }));
    },
    'delete': function (t) { return tone({ t0: t, f0: 330 * rnd(0.95, 1.05), f1: 130, glide: 0.07, decay: 0.09, vol: 0.14, lp: 1400 }); },
    error: function (t) { return tone({ t0: t, f0: 170, f1: 150, glide: 0.1, type: 'triangle', decay: 0.16, vol: 0.12, lp: 700 }); },
    start: function (t) { return Math.max(tone({ t0: t, f0: 330, decay: 0.16, vol: 0.09, lp: 1500 }), tone({ t0: t + 0.1, f0: 440, decay: 0.26, vol: 0.09, lp: 1500 })); },
    'break': function (t, o) {
      var m = o && o.m, e = t;
      e = Math.max(e, noise({ t0: t, freq: m === 'steel' || m === 'steelroad' ? 900 : 520, Q: 1.1, decay: 0.12, vol: 0.2 }));
      e = Math.max(e, tone({ t0: t, f0: 95, f1: 60, glide: 0.1, decay: 0.14, vol: 0.2, lp: 400 }));
      if (m === 'rope' || m === 'cable') e = Math.max(e, tone({ t0: t, f0: 310, f1: 200, glide: 0.2, decay: 0.22, vol: 0.06, lp: 900 }));
      else e = Math.max(e, tone({ t0: t + 0.01, f0: 150, f1: 110, glide: 0.25, type: 'sawtooth', decay: 0.26, vol: 0.05, lp: 500 }));   // creak
      return e;
    },
    splash: function (t) {
      return Math.max(noise({ t0: t, freq: 1100, type: 'lowpass', Q: 0.4, attack: 0.02, decay: 0.34, vol: 0.14 }), tone({ t0: t, f0: 210, f1: 110, glide: 0.12, decay: 0.16, vol: 0.1, lp: 700 }));
    },
    flag: function (t) { return Math.max(tone({ t0: t, f0: 660, decay: 0.12, vol: 0.07, lp: 2200 }), tone({ t0: t + 0.09, f0: 880, decay: 0.2, vol: 0.07, lp: 2400 })); },
    horn: function (t) { return Math.max(tone({ t0: t, f0: 196, type: 'triangle', attack: 0.05, hold: 0.28, decay: 0.3, vol: 0.12, lp: 700 }), tone({ t0: t + 0.02, f0: 247, type: 'triangle', attack: 0.05, hold: 0.28, decay: 0.3, vol: 0.08, lp: 700 })); },
    win: function (t) {
      var notes = [523.25, 659.25, 783.99, 1046.5], e = t;
      notes.forEach(function (f, i) {
        e = Math.max(e, tone({ t0: t + i * 0.12, f0: f, decay: 0.5, vol: 0.09, lp: 2600 }), tone({ t0: t + i * 0.12, f0: f / 2, type: 'triangle', decay: 0.5, vol: 0.05, lp: 1200 }));
      });
      return e;
    },
    fail: function (t) { return Math.max(tone({ t0: t, f0: 330, decay: 0.3, vol: 0.08, lp: 1000 }), tone({ t0: t + 0.22, f0: 262, decay: 0.5, vol: 0.08, lp: 1000 })); },
    star: function (t) { return Math.max(tone({ t0: t, f0: 784 * rnd(0.99, 1.01), decay: 0.4, vol: 0.07, lp: 2400 }), tone({ t0: t, f0: 1568, decay: 0.2, vol: 0.015, lp: 3000 })); },
  };

  // ------------------------------------------------------------------------------------ music (optional pad)
  var CHORDS = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
  function musicChord() {
    if (!ctx || !musicOn || ctx.state !== 'running') return;
    var t = now() + 0.05, ch = CHORDS[musicStep++ % CHORDS.length];
    ch.forEach(function (f, i) {
      var osc = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      osc.type = 'sine'; osc.frequency.value = f * (i === 0 ? 0.5 : 1); lp.type = 'lowpass'; lp.frequency.value = 800;
      osc.connect(lp); lp.connect(g); g.connect(musicBus);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 1.4); g.gain.linearRampToValueAtTime(0.0, t + 4.6);
      osc.start(t); osc.stop(t + 4.7);
    });
    // a soft, sparse melody note
    var mf = ch[(musicStep * 2) % 3] * 2;
    tone({ t0: t + 1.2, f0: mf, decay: 1.4, vol: 0.02, attack: 0.05, lp: 1400, out: musicBus });
  }
  function startMusic() {
    if (musicTimer || !ctx) return;
    musicOn = true; musicChord();
    musicTimer = setInterval(musicChord, 4000);
  }
  function stopMusic() { musicOn = false; if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }

  // ------------------------------------------------------------------------------------ context
  function build() {
    master = ctx.createGain();
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4800; lp.Q.value = 0.4;
    var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.25;
    sfxBus = ctx.createGain(); musicBus = ctx.createGain();
    sfxBus.connect(master); musicBus.connect(master); master.connect(lp); lp.connect(comp); comp.connect(ctx.destination);
    applyGains();
  }
  function applyGains() {
    if (!ctx || !master) return;
    var t = now();
    master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(state.muted ? 0 : BASE * Math.max(0, Math.min(1, state.volume)), t, 0.03);
    sfxBus.gain.value = state.effects ? 1 : 0;
    musicBus.gain.value = 0.9;
  }
  function unlock() {
    if (!AC) return false;
    try {
      if (!ctx) { ctx = new AC(); build(); }
      if (ctx.state !== 'running') { var p = ctx.resume(); if (p && p.catch) p.catch(function () { /* needs another gesture */ }); }
      if (state.music && !state.muted && !musicTimer) startMusic();
    } catch (e) { return false; }
    return true;
  }
  function onGesture() { if (AC && (!ctx || ctx.state !== 'running')) unlock(); }

  function play(name, opts) {
    if (state.muted || !state.effects || !AC) return;
    var fn = SOUNDS[name];
    if (!fn) return;
    if (!ctx) { unlock(); if (!ctx) return; }
    if (ctx.state !== 'running') return;
    var t = now(), gap = MIN_GAP[name] || 0.08;
    if (lastStart[name] !== undefined && t - lastStart[name] < gap) return;
    if (voices >= MAX_VOICES) return;
    lastStart[name] = t;
    voices++;
    try {
      var end = fn(t + 0.005, opts || {});
      setTimeout(function () { voices = Math.max(0, voices - 1); }, Math.max(60, (end - t) * 1000));
    } catch (e) { voices = Math.max(0, voices - 1); }
  }

  function setMuted(m) { state.muted = !!m; api.muted = state.muted; applyGains(); if (state.muted) stopMusic(); else if (state.music && ctx) startMusic(); }
  function setVolume(v) { state.volume = Math.max(0, Math.min(1, +v || 0)); applyGains(); }
  function setEffects(on) { state.effects = !!on; applyGains(); }
  function setMusic(on) { state.music = !!on; if (!state.music) stopMusic(); else if (ctx && !state.muted) startMusic(); }

  try {
    if (typeof window !== 'undefined' && window.addEventListener) ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (t) { window.addEventListener(t, onGesture, { capture: true, passive: true }); });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', function () { if (document.hidden) stopMusic(); else if (state.music && !state.muted && ctx) startMusic(); });
  } catch (e) { /* ignore */ }

  var api = {
    unlock: unlock, play: play, setMuted: setMuted, setVolume: setVolume, setEffects: setEffects, setMusic: setMusic,
    muted: false, names: NAMES.slice(),
    get volume() { return state.volume; }, get effects() { return state.effects; }, get music() { return state.music; },
    get available() { return !!AC; }, get state() { return ctx ? ctx.state : 'none'; },
  };
  BB.Audio = api;
})(globalThis.BB = globalThis.BB || {});
