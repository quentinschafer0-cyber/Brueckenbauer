/*
 * Brückenbauer – save.js
 * ----------------------------------------------------------------------------
 * Persistent game state ("Spielstand"). The top priority of this module is that
 * progress is NEVER lost – also on an iPad where the game runs as a home-screen
 * web app. Strategy:
 *
 *  - The state is kept in TWO independent stores: localStorage (synchronous,
 *    survives even an abrupt page kill) and IndexedDB (separate quota, survives
 *    some kinds of localStorage loss). On start both are read and the NEWER copy
 *    wins (higher `rev`, then higher `savedAt`). Afterwards both are re-synced.
 *  - Every mutation is followed by `change()` → debounced save (~300 ms). When
 *    the page is hidden / frozen / unloaded everything pending is flushed
 *    immediately (localStorage synchronously, IndexedDB transaction started).
 *  - A save that cannot be parsed is NEVER silently overwritten: its raw text is
 *    kept under `brueckenbauer.save.corrupt` (IndexedDB: `save.corrupt`) before
 *    anything else is written to that slot.
 *  - At session start the loaded state is copied to `….prev` (both stores) and
 *    used as a last-resort fallback if both main copies are unreadable.
 *  - Before a reset or an import replaces the state, the old state is copied to
 *    `….replaced` (both stores) – an emergency copy.
 *  - Saves are versioned (`version`) and migrated step by step; fields this code
 *    does not know are preserved untouched.
 *  - Every storage access is wrapped in try/catch. With no storage at all the
 *    game keeps working with an in-memory state.
 *  - `navigator.storage.persist()` is requested (again on the first user
 *    interaction if the first attempt was not granted).
 *
 * The state object (`BB.Save.state`) keeps its identity for the whole session:
 * loading, importing and resetting replace its CONTENTS in place, so a cached
 * reference never goes stale. Callers must `await BB.Save.init()` before reading
 * or mutating the state.
 */
(function (BB) {
  'use strict';

  var SAVE_VERSION = 3;

  var LS_KEY = 'brueckenbauer.save';
  var LS_PREV = LS_KEY + '.prev';
  var LS_CORRUPT = LS_KEY + '.corrupt';
  var LS_REPLACED = LS_KEY + '.replaced';
  var LS_PROBE = 'brueckenbauer.probe';

  var IDB_NAME = 'brueckenbauer';
  var IDB_STORE = 'kv';
  var IDB_MAIN = 'save';
  var IDB_PREV = 'save.prev';
  var IDB_CORRUPT = 'save.corrupt';
  var IDB_REPLACED = 'save.replaced';

  var DEBOUNCE_MS = 300;
  var IDB_TIMEOUT_MS = 3000;          // init() does not wait longer than this for IndexedDB
  var BACKUP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
  var EXPORT_APP = 'Brueckenbauer';   // marker in exported files
  var EXPORT_FORMAT = 1;
  var MAX_IMPORT_CHARS = 30 * 1024 * 1024;

  var G = (typeof globalThis !== 'undefined') ? globalThis : this;
  var hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
  var hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function now() { return Date.now(); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function warn(msg, err) {
    api.lastError = msg;
    try { console.warn('[Brückenbauer/Speichern] ' + msg + (err ? ' – ' + ((err && err.name) || '') + ' ' + ((err && err.message) || err) : '')); } catch (e) { /* ignore */ }
  }

  function defaultSandbox() {
    return { span: 16, heightDiff: 0, water: true, rocks: 0, lowAnchors: true, highAnchors: false, vehicles: ['car'], wind: 0, ice: false };
  }

  function defaultSettings() {
    return { muted: false, showStress: true, quality: 'mid', chaseCam: false, buildView: 'blueprint', snapGrid: true, volume: 0.7, sfx: true, music: false, testerMode: false, testerModeZeit: false, debugInfo: false };
  }

  // v3.3: two campaigns ("classic" = the worlds, "zeit" = Zeitreise). `active` is the one the menu continues in,
  // `chosen` is false until the player picked one at the first start. Stars / completion stay in `progress` (level ids
  // are unique – Zeitreise ids start with "Z-"); here only the position of every campaign is stored.
  function defaultCampaigns() {
    return { active: 'classic', chosen: false, classic: { world: null, level: null }, zeit: { epoch: null, level: null, seen: [] } };
  }

  // The weekly challenge replaces the daily one (the old `daily` record stays untouched).
  // `history` keeps the best stars of every past week: { '2026-W41': 3, … }.
  function defaultWeekly() {
    return { week: null, seed: 0, completed: false, bestCost: null, stars: 0, history: {} };
  }

  function defaultDaily() {
    return { date: null, seed: 0, completed: false, bestCost: null, stars: 0 };
  }

  function defaultState() {
    var t = now();
    return {
      version: SAVE_VERSION,
      rev: 0,
      savedAt: 0,
      createdAt: t,
      progress: { completed: {}, stars: {}, bestCost: {} },
      bridges: {},
      customLevels: [],
      sandbox: defaultSandbox(),
      settings: defaultSettings(),
      daily: defaultDaily(),
      weekly: defaultWeekly(),
      campaigns: defaultCampaigns(),
      lastBackupAt: null
    };
  }

  // ---------------------------------------------------------------------------
  // Migration + normalisation
  // ---------------------------------------------------------------------------

  // MIGRATIONS[v] converts a state of version v into version v + 1. Each step
  // receives a (cloned) object, may modify it in place and returns it. Steps must
  // keep all fields they do not know about.
  var MIGRATIONS = [
    // 0 → 1: saves without a version number (pre-release builds, hand-made or
    // partial files). The v1 layout is a superset of what those contained;
    // normalize() adds every missing field with its default.
    function (s) { return s; },
    // 1 → 2: added the world expansion (worlds, hydraulics, ships, …) and the
    // daily challenge. Existing progress is untouched: built-in levels keep
    // their ids (L01…L16), so `progress`/`bridges` need no change at all –
    // normalize() only has to add the new `daily` field.
    function (s) { return s; },
    // 2 → 3: 3D graphics update. New: graphics settings (quality, chase camera), the weekly
    // challenge record, bridges may contain foundations / split joints / hydraulic phases,
    // levels may have routes, zones and prebuilt parts. Everything that existed before keeps its
    // meaning: level ids (L01…, W2-…, W5-…) are unchanged, so progress, stars and saved bridges are
    // simply carried over; normalize() fills in the new fields.
    function (s) {
      if (s && s.settings && typeof s.settings === 'object') {
        if (s.settings.quality === undefined) s.settings.quality = 'mid';
        if (s.settings.chaseCam === undefined) s.settings.chaseCam = false;
      }
      if (!s.weekly || typeof s.weekly !== 'object') s.weekly = defaultWeekly();
      return s;
    }
  ];

  function versionOf(s) {
    return isNum(s.version) ? Math.max(0, Math.floor(s.version)) : 0;
  }

  // Returns a NEW, migrated + normalised state; never modifies `obj`.
  function migrate(obj) {
    var s = clone(obj);
    var v = versionOf(s);
    while (v < SAVE_VERSION) {
      var step = MIGRATIONS[v];
      if (typeof step === 'function') {
        var r = step(s);
        if (isObj(r)) s = r;
      }
      v++;
      s.version = v;
    }
    return normalize(s);
  }

  function sanitizeBridge(b) {
    if (!isObj(b)) return null;
    var beams = Array.isArray(b.beams) ? b.beams : [];
    b.beams = beams.filter(function (bm) {
      return isObj(bm) && isNum(bm.x1) && isNum(bm.y1) && isNum(bm.x2) && isNum(bm.y2) && typeof bm.m === 'string';
    });
    return b;
  }

  // Fills in / repairs every field this version knows about. Unknown fields are
  // left untouched; a version number newer than ours is kept (save from a newer
  // game version).
  function normalize(s) {
    var t = now();
    if (!isNum(s.version) || s.version < SAVE_VERSION) s.version = SAVE_VERSION;
    s.rev = isNum(s.rev) ? Math.max(0, Math.floor(s.rev)) : 0;
    s.savedAt = isNum(s.savedAt) ? Math.max(0, s.savedAt) : 0;
    if (!isNum(s.createdAt)) s.createdAt = s.savedAt || t;

    if (!isObj(s.progress)) s.progress = {};
    var p = s.progress;
    if (!isObj(p.completed)) p.completed = {};
    if (!isObj(p.stars)) p.stars = {};
    if (!isObj(p.bestCost)) p.bestCost = {};
    Object.keys(p.completed).forEach(function (id) { p.completed[id] = !!p.completed[id]; });
    Object.keys(p.stars).forEach(function (id) {
      var v = p.stars[id];
      if (isNum(v)) p.stars[id] = Math.max(0, Math.min(3, Math.round(v)));
      else delete p.stars[id];
    });
    Object.keys(p.bestCost).forEach(function (id) {
      var v = p.bestCost[id];
      if (!isNum(v) || v < 0) delete p.bestCost[id];
    });

    if (!isObj(s.bridges)) s.bridges = {};
    Object.keys(s.bridges).forEach(function (k) {
      var b = sanitizeBridge(s.bridges[k]);
      if (b) s.bridges[k] = b; else delete s.bridges[k];
    });

    if (!Array.isArray(s.customLevels)) s.customLevels = [];
    var seen = {};
    s.customLevels = s.customLevels.filter(function (lv) {
      if (!isObj(lv) || typeof lv.id !== 'string' || !lv.id || own(seen, lv.id)) return false;
      seen[lv.id] = true;
      return true;
    });

    s.sandbox = fillDefaults(s.sandbox, defaultSandbox());
    if (!Array.isArray(s.sandbox.vehicles)) s.sandbox.vehicles = defaultSandbox().vehicles;
    s.settings = fillDefaults(s.settings, defaultSettings());
    s.daily = fillDefaults(s.daily, defaultDaily());
    if (typeof s.daily.date !== 'string') s.daily.date = null;
    if (!isNum(s.daily.stars)) s.daily.stars = 0;
    s.weekly = fillDefaults(s.weekly, defaultWeekly());
    if (typeof s.weekly.week !== 'string') s.weekly.week = null;
    if (!isNum(s.weekly.stars)) s.weekly.stars = 0;
    if (!isObj(s.weekly.history)) s.weekly.history = {};
    Object.keys(s.weekly.history).forEach(function (k) { if (!isNum(s.weekly.history[k])) delete s.weekly.history[k]; });

    if (!isObj(s.campaigns)) s.campaigns = defaultCampaigns();
    var cp = s.campaigns, cd = defaultCampaigns();
    if (cp.active !== 'classic' && cp.active !== 'zeit') cp.active = 'classic';
    cp.chosen = cp.chosen === true;
    cp.classic = fillDefaults(cp.classic, cd.classic);
    cp.zeit = fillDefaults(cp.zeit, cd.zeit);
    if (!Array.isArray(cp.zeit.seen)) cp.zeit.seen = [];
    cp.zeit.seen = cp.zeit.seen.filter(function (x) { return typeof x === 'string'; });
    if (typeof cp.classic.world !== 'string') cp.classic.world = null;
    if (typeof cp.classic.level !== 'string') cp.classic.level = null;
    if (typeof cp.zeit.epoch !== 'string') cp.zeit.epoch = null;
    if (typeof cp.zeit.level !== 'string') cp.zeit.level = null;
    s.lastBackupAt = (isNum(s.lastBackupAt) && s.lastBackupAt > 0) ? s.lastBackupAt : null;
    if (!isNum(s.epoch)) delete s.epoch;
    return s;
  }

  // Keeps existing values whose type matches the default, replaces mismatching
  // ones with the default, adds missing ones, keeps unknown keys.
  function fillDefaults(obj, defs) {
    var o = isObj(obj) ? obj : {};
    Object.keys(defs).forEach(function (k) {
      var d = defs[k];
      var v = o[k];
      var okType = (d === null) || (Array.isArray(d) ? Array.isArray(v) : (typeof v === typeof d && v !== null && (typeof d !== 'number' || isFinite(v))));
      if (!own(o, k) || !okType) o[k] = clone(d);
    });
    return o;
  }

  function isNewer(a, b) {
    if (a.rev !== b.rev) return a.rev > b.rev;
    return a.savedAt > b.savedAt;
  }

  function hasProgress(s) {
    var c = s.progress.completed;
    for (var id in c) { if (own(c, id) && c[id]) return true; }
    return s.customLevels.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------

  var state = defaultState();          // identity never changes (see replaceState)
  var ready = false;                   // true once init() has loaded the stores
  var initPromise = null;
  var dirty = false;                   // changes not yet written
  var timer = null;                    // debounce timer
  var loadedSnapshot = null;           // {rev, savedAt} of the state loaded at session start
  var lsMainBlocked = false;           // corrupt LS save could not be preserved → never overwrite it
  var idbMainBlocked = false;          // same for IndexedDB
  var idbHold = null;                  // Promise; gated IDB writes wait for it (initial load, corrupt preservation)
  var lifecycleInstalled = false;
  var persistRetryInstalled = false;

  // Replace the CONTENTS of the state object (keeps references valid).
  function replaceState(next) {
    if (next === state) return;
    Object.keys(state).forEach(function (k) { delete state[k]; });
    Object.keys(next).forEach(function (k) { state[k] = next[k]; });
  }

  // ---------------------------------------------------------------------------
  // localStorage
  // ---------------------------------------------------------------------------

  function getLS() {
    try { return G.localStorage || null; } catch (e) { return null; }   // Safari throws SecurityError when blocked
  }

  function lsGet(key) {
    var ls = getLS();
    if (!ls) return null;
    try { return ls.getItem(key); } catch (e) { return null; }
  }

  function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }

  // → 'ok' | 'quota' | 'fail'
  function lsSet(key, value) {
    var ls = getLS();
    if (!ls) return 'fail';
    try { ls.setItem(key, value); return 'ok'; } catch (e) { return isQuotaError(e) ? 'quota' : 'fail'; }
  }

  function lsRemove(key) {
    var ls = getLS();
    if (!ls) return;
    try { ls.removeItem(key); } catch (e) { /* ignore */ }
  }

  function lsProbe() {
    var r = lsSet(LS_PROBE, '1');
    lsRemove(LS_PROBE);
    return r === 'ok';
  }

  // Writes the main save. On a full quota the less important copies (prev /
  // replaced – both also kept in IndexedDB) are dropped and the write retried.
  function lsWriteMain(json) {
    if (lsMainBlocked) return false;
    var r = lsSet(LS_KEY, json);
    if (r === 'quota') {
      lsRemove(LS_PREV);
      lsRemove(LS_REPLACED);
      r = lsSet(LS_KEY, json);
    }
    if (r === 'ok') {
      api.storageOk.local = true;
      return true;
    }
    api.storageOk.local = false;
    if (r === 'quota') warn('Lokaler Speicher ist voll – der Spielstand wird nur in IndexedDB gesichert.');
    else if (getLS()) warn('Lokaler Speicher (localStorage) ist nicht beschreibbar.');
    return false;
  }

  // Keeps an unreadable save. Never overwrites an older, DIFFERENT corrupt copy.
  function lsPreserveCorrupt(raw) {
    var existing = lsGet(LS_CORRUPT);
    if (existing === raw) return true;
    var key = existing == null ? LS_CORRUPT : LS_CORRUPT + '.' + now();
    return lsSet(key, raw) === 'ok';
  }

  // ---------------------------------------------------------------------------
  // IndexedDB (values are stored as JSON strings in store "kv")
  // ---------------------------------------------------------------------------

  var idb = { db: null, opening: null };

  function getIDB() {
    try { return G.indexedDB || null; } catch (e) { return null; }
  }

  // Opens (or creates) the database; resolves the connection or null.
  function idbOpen() {
    if (idb.db) return Promise.resolve(idb.db);
    if (idb.opening) return idb.opening;
    var factory = getIDB();
    if (!factory) return Promise.resolve(null);
    idb.opening = new Promise(function (resolve) {
      openWithVersion(factory, undefined, resolve, 0);
    }).then(function (db) {
      idb.opening = null;
      return db;
    });
    return idb.opening;
  }

  function openWithVersion(factory, version, resolve, depth) {
    var req;
    try {
      req = version === undefined ? factory.open(IDB_NAME) : factory.open(IDB_NAME, version);
    } catch (e) { resolve(null); return; }
    req.onupgradeneeded = function () {
      try {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      } catch (e) { /* ignore – onerror/onsuccess follows */ }
    };
    req.onsuccess = function () {
      var db = req.result;
      try {
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          // Database exists without our store (should not happen) → add it via an upgrade.
          var v = db.version + 1;
          db.close();
          if (depth < 2) openWithVersion(factory, v, resolve, depth + 1); else resolve(null);
          return;
        }
        db.onversionchange = function () {
          try { db.close(); } catch (e) { /* ignore */ }
          if (idb.db === db) idb.db = null;
        };
        db.onclose = function () { if (idb.db === db) idb.db = null; };   // closed by the browser
      } catch (e) { /* ignore */ }
      idb.db = db;
      resolve(db);
    };
    req.onerror = function (ev) {
      try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
      resolve(null);
    };
    req.onblocked = function () { /* an old connection in another tab must close first – keep waiting */ };
  }

  // Reads several keys in one transaction → {key: value} or null on failure.
  function idbReadMany(keys) {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var out = {};
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var store = tx.objectStore(IDB_STORE);
          keys.forEach(function (k) {
            var r = store.get(k);
            r.onsuccess = function () { out[k] = r.result; };
          });
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = function (ev) { try { ev.preventDefault(); } catch (e) { /* ignore */ } };
          tx.onabort = function () { resolve(null); };
        } catch (e) {
          idb.db = null;
          resolve(null);
        }
      });
    }, function () { return null; });
  }

  // Starts one readwrite transaction → 'ok' | 'reopen' | 'fail' | 'quota'.
  function idbPutWith(db, entries) {
    return new Promise(function (resolve) {
      var tx;
      try {
        tx = db.transaction(IDB_STORE, 'readwrite', { durability: 'strict' });
      } catch (e) {
        resolve('reopen');       // connection closed in the meantime (e.g. app was in the background)
        return;
      }
      try {
        var store = tx.objectStore(IDB_STORE);
        entries.forEach(function (en) {
          if (en[1] === undefined) store.delete(en[0]); else store.put(en[1], en[0]);
        });
      } catch (e) {
        try { tx.abort(); } catch (e2) { /* ignore */ }
        resolve(isQuotaError(e) ? 'quota' : 'fail');
        return;
      }
      tx.oncomplete = function () { resolve('ok'); };
      tx.onerror = function (ev) { try { ev.preventDefault(); } catch (e) { /* ignore */ } };
      tx.onabort = function () { resolve(isQuotaError(tx.error) ? 'quota' : 'fail'); };
    });
  }

  // Writes entries [[key, value|undefined], …] directly. The transaction is
  // created synchronously when a connection is open (important in pagehide).
  function idbPut(entries) {
    var run = function (db) { return db ? idbPutWith(db, entries) : Promise.resolve('fail'); };
    var p = idb.db ? run(idb.db) : idbOpen().then(run);
    return p.then(function (r) {
      if (r !== 'reopen') return r;
      idb.db = null;
      return idbOpen().then(run).then(function (r2) { return r2 === 'reopen' ? 'fail' : r2; });
    }).then(function (r) {
      var ok = r === 'ok';
      if (getIDB()) api.storageOk.idb = ok;
      if (r === 'quota') warn('IndexedDB-Speicher ist voll.');
      return ok;
    }, function () { return false; });
  }

  // Like idbPut, but waits while `idbHold` is pending (initial load not finished
  // yet, or a corrupt main save is still being preserved). Used for the
  // secondary copies (prev / replaced).
  function idbWriteGated(entries) {
    if (idbHold) {
      var h = idbHold;
      h.then(function () { idbWriteGated(entries); }, function () { idbWriteGated(entries); });
      return;
    }
    if (!getIDB()) return;
    idbPut(entries);
  }

  // The main save always writes the LATEST serialised state: while writes are
  // held back only the newest JSON is remembered, so an older queued write can
  // never land after a newer one.
  var idbPendingMain = null;
  var idbMainWaiting = false;

  function idbWriteMain(json) {
    idbPendingMain = json;
    idbDrainMain();
  }

  function idbDrainMain() {
    if (idbHold) {
      if (!idbMainWaiting) {
        idbMainWaiting = true;
        var again = function () { idbMainWaiting = false; idbDrainMain(); };
        idbHold.then(again, again);
      }
      return;
    }
    var json = idbPendingMain;
    idbPendingMain = null;
    if (json === null || idbMainBlocked || !getIDB()) return;
    idbPut([[IDB_MAIN, json]]);
  }

  function idbPreserveCorrupt(raw, existing) {
    if (existing === raw) return Promise.resolve(true);
    var key = existing == null ? IDB_CORRUPT : IDB_CORRUPT + '.' + now();
    return idbPut([[key, raw]]);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  // Interprets a stored value → null (missing) | {corrupt:true, raw} | {state, raw}
  function examine(raw, source) {
    if (raw === undefined || raw === null) return null;
    var text = raw;
    var obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { return { source: source, corrupt: true, raw: raw }; }
    } else {
      try { text = JSON.stringify(raw); } catch (e) { text = String(raw); }
    }
    if (!isObj(obj)) return { source: source, corrupt: true, raw: text };
    try {
      return { source: source, raw: text, state: migrate(obj) };
    } catch (e) {
      return { source: source, corrupt: true, raw: text };
    }
  }

  function pickNewest(list) {
    var best = null;
    list.forEach(function (c) {
      if (c && c.state && (!best || isNewer(c.state, best.state))) best = c;
    });
    return best;
  }

  function finishLoad(lsData, idbData) {
    var lsMain = examine(lsData.main, 'local');
    var idbMain = examine(idbData ? idbData[IDB_MAIN] : null, 'idb');

    // Never lose an unreadable save: keep its raw text before anything can overwrite it.
    if (lsMain && lsMain.corrupt) {
      warn('Der Spielstand im lokalen Speicher war beschädigt und wurde unter "' + LS_CORRUPT + '" aufbewahrt.');
      if (!lsPreserveCorrupt(lsMain.raw)) {
        lsMainBlocked = true;
        // try to keep a copy in IndexedDB at least
        if (idbData) idbPut([[IDB_CORRUPT + '.local.' + now(), lsMain.raw]]);
      }
    }
    if (idbMain && idbMain.corrupt) preserveIdbCorrupt(idbMain.raw, idbData[IDB_CORRUPT]);

    var winner = pickNewest([lsMain, idbMain]);
    var fromPrev = false;
    if (!winner) {
      // Both main copies missing or unreadable → fall back to the session-start snapshots.
      winner = pickNewest([examine(lsData.prev, 'local-prev'), examine(idbData ? idbData[IDB_PREV] : null, 'idb-prev')]);
      fromPrev = !!winner;
      if (winner && (lsMain || idbMain)) warn('Der Spielstand wurde aus der Sicherungskopie vom letzten Start wiederhergestellt.');
    }

    if (winner) {
      replaceState(winner.state);
      api.loadedFrom = winner.source;
      if (!fromPrev) writePrevSnapshot(winner.raw);
    } else {
      // Fresh start (or nothing readable): keep the in-memory state (normalised).
      replaceState(normalize(state));
      api.loadedFrom = null;
    }
    loadedSnapshot = { rev: state.rev, savedAt: state.savedAt };
    ready = true;
    api.ready = true;
    flush();   // brings both stores up to date with the winner
  }

  function preserveIdbCorrupt(raw, existing) {
    warn('Der Spielstand in IndexedDB war beschädigt und wurde unter "' + IDB_CORRUPT + '" aufbewahrt.');
    var p = idbPreserveCorrupt(raw, existing).then(function (ok) {
      if (!ok) idbMainBlocked = true;
      if (idbHold === p) idbHold = null;
      return ok;
    });
    idbHold = p;
  }

  function writePrevSnapshot(raw) {
    if (typeof raw !== 'string') return;
    if (lsGet(LS_PREV) !== raw) lsSet(LS_PREV, raw);   // failure is fine (main save has priority)
    idbWriteGated([[IDB_PREV, raw]]);
  }

  // IndexedDB answered only after init() had already finished (timeout). If it
  // holds something newer than what was loaded, merge it in – nothing is lost.
  function lateIdbLoad(data) {
    if (!data) return;
    api.storageOk.idb = true;
    var c = examine(data[IDB_MAIN], 'idb');
    if (c && c.corrupt) { preserveIdbCorrupt(c.raw, data[IDB_CORRUPT]); return; }
    if (!c || !c.state || !loadedSnapshot || !isNewer(c.state, loadedSnapshot)) return;
    if (state.rev === loadedSnapshot.rev && !dirty) {
      replaceState(c.state);           // nothing changed in this session yet → just take it
      loadedSnapshot = { rev: state.rev, savedAt: state.savedAt };
      writePrevSnapshot(c.raw);
    } else {
      mergeInto(state, c.state);
      state.rev = Math.max(state.rev, c.state.rev) + 1;
      state.savedAt = now();
    }
    flush();
  }

  // Monotone merge of progress-like data from `src` into `dst`: completions are
  // united, best stars/costs kept, missing custom levels and bridges added.
  // Returns true if `dst` changed.
  function mergeInto(dst, src) {
    var changed = false;
    var dp = dst.progress, sp = src.progress;
    Object.keys(sp.completed).forEach(function (id) {
      if (sp.completed[id] && !dp.completed[id]) { dp.completed[id] = true; changed = true; }
    });
    Object.keys(sp.stars).forEach(function (id) {
      if (!own(dp.stars, id) || sp.stars[id] > dp.stars[id]) { dp.stars[id] = sp.stars[id]; changed = true; }
    });
    Object.keys(sp.bestCost).forEach(function (id) {
      if (!own(dp.bestCost, id) || sp.bestCost[id] < dp.bestCost[id]) { dp.bestCost[id] = sp.bestCost[id]; changed = true; }
    });
    var have = {};
    dst.customLevels.forEach(function (lv) { have[lv.id] = true; });
    src.customLevels.forEach(function (lv) {
      if (!own(have, lv.id)) { dst.customLevels.push(clone(lv)); changed = true; }
    });
    Object.keys(src.bridges).forEach(function (k) {
      if (!own(dst.bridges, k)) { dst.bridges[k] = clone(src.bridges[k]); changed = true; }
    });
    if (src.lastBackupAt && (!dst.lastBackupAt || src.lastBackupAt > dst.lastBackupAt)) {
      dst.lastBackupAt = src.lastBackupAt;
      changed = true;
    }
    return changed;
  }

  // Another tab of the game wrote the save (PC with two open tabs). Both tabs
  // end up with the union of their progress; the newer copy provides everything
  // else (settings, bridge drafts). A reset/import in one tab (newer `epoch`) is
  // taken over as a whole instead of being merged away.
  function onStorageEvent(e) {
    try {
      if (!ready || !e || e.key !== LS_KEY || typeof e.newValue !== 'string') return;
      var c = examine(e.newValue, 'local');
      if (!c || !c.state) return;
      var incoming = c.state;
      var ie = incoming.epoch || 0, me = state.epoch || 0;
      var stopTimer = function () { dirty = false; if (timer) { clearTimeout(timer); timer = null; } };
      if (ie !== me) {
        if (ie > me) { replaceState(incoming); stopTimer(); }
        else { state.rev = Math.max(state.rev, incoming.rev) + 1; state.savedAt = now(); dirty = true; flush(); }
        return;
      }
      if (isNewer(incoming, state)) {
        var mine = clone(state);
        replaceState(incoming);
        if (mergeInto(state, mine)) {
          state.rev += 1;
          state.savedAt = now();
          dirty = true;
          flush();
        } else {
          stopTimer();
        }
      } else {
        // Our copy is newer but the other tab just overwrote the stored one →
        // add its progress to ours and store the union again.
        mergeInto(state, incoming);
        state.rev = Math.max(state.rev, incoming.rev) + 1;
        state.savedAt = now();
        dirty = true;
        flush();
      }
    } catch (err) { /* ignore */ }
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve) {
      var done = false;
      var lsData = { main: null, prev: null };
      try {
        api.storageOk.local = lsProbe();
        lsData.main = lsGet(LS_KEY);
        lsData.prev = lsGet(LS_PREV);
      } catch (e) { /* in-memory */ }

      var finish = function (idbData) {
        if (done) return;
        done = true;
        try {
          api.storageOk.idb = !!idbData;
          finishLoad(lsData, idbData);
        } catch (e) {
          warn('Fehler beim Laden des Spielstands.', e);
          ready = true;
          api.ready = true;
        }
        resolve(state);
      };

      var load;
      try {
        load = getIDB() ? idbReadMany([IDB_MAIN, IDB_PREV, IDB_CORRUPT]) : Promise.resolve(null);
      } catch (e) {
        load = Promise.resolve(null);
      }
      // All IndexedDB writes wait until the stored copy has been read.
      var hold = load.then(function () { if (idbHold === hold) idbHold = null; }, function () { if (idbHold === hold) idbHold = null; });
      idbHold = hold;

      var t = setTimeout(function () {
        warn('IndexedDB antwortet nicht – der Spielstand wird vorerst aus dem lokalen Speicher geladen.');
        finish(null);
      }, IDB_TIMEOUT_MS);

      load.then(function (data) {
        clearTimeout(t);
        if (!done) finish(data);
        else { try { lateIdbLoad(data); } catch (e) { /* ignore */ } }
      }, function () {
        clearTimeout(t);
        finish(null);
      });
    });
    installLifecycle();
    requestPersist();
    return initPromise;
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  function change() {
    state.rev = (isNum(state.rev) ? state.rev : 0) + 1;
    state.savedAt = now();
    dirty = true;
    // Trailing throttle: saves at most DEBOUNCE_MS after the FIRST unsaved
    // change, so a stream of changes can never postpone saving indefinitely.
    if (!timer) {
      timer = setTimeout(function () { timer = null; flush(); }, DEBOUNCE_MS);
    }
  }

  // Immediate save: localStorage synchronously, IndexedDB transaction started.
  // Returns true if the synchronous localStorage write succeeded.
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!ready) return false;          // before init() nothing may overwrite an existing save
    var json;
    try {
      json = JSON.stringify(state);
    } catch (e) {
      warn('Spielstand konnte nicht umgewandelt werden.', e);
      return false;
    }
    dirty = false;
    var ok = false;
    try { ok = lsWriteMain(json); } catch (e) { ok = false; }
    try { idbWriteMain(json); } catch (e) { /* ignore */ }
    return ok;
  }

  function onPageHide() {
    if (dirty || timer) flush();
  }

  function installLifecycle() {
    if (lifecycleInstalled) return;
    lifecycleInstalled = true;
    try {
      // visibilitychange: flushing on every change (not only "hidden") is harmless
      // and also covers browsers that report the state late.
      if (hasDocument) {
        document.addEventListener('visibilitychange', onPageHide);
        document.addEventListener('freeze', onPageHide);
      }
      if (hasWindow) {
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('beforeunload', onPageHide);
        window.addEventListener('storage', onStorageEvent);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Persistent storage permission
  // ---------------------------------------------------------------------------

  function storageManager() {
    try { return (G.navigator && G.navigator.storage) || null; } catch (e) { return null; }
  }

  function askPersist() {
    var sm = storageManager();
    if (!sm || typeof sm.persist !== 'function') return Promise.resolve(api.persisted);
    try {
      return Promise.resolve(sm.persist()).then(function (granted) {
        api.persisted = !!granted;
        return api.persisted;
      }, function () { return api.persisted; });
    } catch (e) {
      return Promise.resolve(api.persisted);
    }
  }

  function requestPersist() {
    var sm = storageManager();
    if (!sm) { api.persisted = null; return Promise.resolve(null); }
    var check;
    try {
      check = typeof sm.persisted === 'function' ? Promise.resolve(sm.persisted()) : Promise.resolve(false);
    } catch (e) {
      check = Promise.resolve(false);
    }
    return check.then(function (already) {
      if (already) { api.persisted = true; return true; }
      if (typeof sm.persist !== 'function') { api.persisted = false; return false; }
      api.persisted = false;
      return askPersist().then(function (granted) {
        if (!granted) installPersistRetry();
        return granted;
      });
    }, function () { return api.persisted; });
  }

  // Some browsers only grant persistence after a user interaction → ask once more.
  function installPersistRetry() {
    if (persistRetryInstalled || !hasWindow) return;
    persistRetryInstalled = true;
    var types = ['pointerdown', 'touchend', 'keydown', 'click'];
    var handler = function () {
      types.forEach(function (t) { try { window.removeEventListener(t, handler, true); } catch (e) { /* ignore */ } });
      if (api.persisted !== true) askPersist();
    };
    types.forEach(function (t) { try { window.addEventListener(t, handler, true); } catch (e) { /* ignore */ } });
  }

  // ---------------------------------------------------------------------------
  // Game data accessors
  // ---------------------------------------------------------------------------

  function getBridge(key) {
    try {
      var b = state.bridges[key];
      return isObj(b) ? clone(b) : null;
    } catch (e) { return null; }
  }

  // setBridge(key, null) removes the stored bridge.
  function setBridge(key, bridge) {
    if (typeof key !== 'string' || !key) return;
    if (bridge == null) {
      if (own(state.bridges, key)) { delete state.bridges[key]; change(); }
      return;
    }
    var b;
    try { b = sanitizeBridge(clone(bridge)); } catch (e) { b = null; }
    if (!b) return;
    state.bridges[key] = b;
    change();
  }

  function completeLevel(id, cost, stars) {
    if (typeof id !== 'string' || !id) return;
    var p = state.progress;
    p.completed[id] = true;
    var s = isNum(stars) ? Math.max(0, Math.min(3, Math.round(stars))) : 0;
    if (!own(p.stars, id) || s > p.stars[id]) p.stars[id] = s;
    if (isNum(cost) && cost >= 0) {
      var c = Math.round(cost);
      if (!own(p.bestCost, id) || c < p.bestCost[id]) p.bestCost[id] = c;
    }
    change();
    flush();   // completing a level is important progress → save right away
  }

  function isCompleted(id) { return !!(state.progress && state.progress.completed[id] === true); }
  function getStars(id) { var v = state.progress && state.progress.stars[id]; return isNum(v) ? v : 0; }
  function getBestCost(id) { var v = state.progress && state.progress.bestCost[id]; return isNum(v) ? v : null; }

  // ---------------------------------------------------------------------------
  // Daily challenge (one record for "today"; a new date simply overwrites it)
  // ---------------------------------------------------------------------------
  function getDaily(dateStr) {
    var d = state.daily;
    if (!isObj(d) || d.date !== dateStr) return { date: dateStr, seed: 0, completed: false, bestCost: null, stars: 0 };
    return clone(d);
  }
  function completeDaily(dateStr, seed, cost, stars) {
    if (typeof dateStr !== 'string' || !dateStr) return;
    var d = (isObj(state.daily) && state.daily.date === dateStr) ? state.daily : { date: dateStr, seed: seed | 0, completed: false, bestCost: null, stars: 0 };
    d.date = dateStr;
    if (isNum(seed)) d.seed = seed | 0;
    d.completed = true;
    var s = isNum(stars) ? Math.max(0, Math.min(3, Math.round(stars))) : 0;
    if (!isNum(d.stars) || s > d.stars) d.stars = s;
    if (isNum(cost) && cost >= 0) {
      var c = Math.round(cost);
      if (!isNum(d.bestCost) || c < d.bestCost) d.bestCost = c;
    }
    state.daily = d;
    change();
    flush();
  }

  // ---------------------------------------------------------------------------
  // Weekly challenge (one record for "this week"; older weeks only keep their stars in `history`)
  // ---------------------------------------------------------------------------
  function getWeekly(weekKey) {
    var w = state.weekly;
    if (!isObj(w) || w.week !== weekKey) {
      var hs = isObj(w) && isObj(w.history) && isNum(w.history[weekKey]) ? w.history[weekKey] : 0;
      return { week: weekKey, seed: 0, completed: hs > 0, bestCost: null, stars: hs, history: {} };
    }
    return clone(w);
  }
  function completeWeekly(weekKey, seed, cost, stars) {
    if (typeof weekKey !== 'string' || !weekKey) return;
    var w = isObj(state.weekly) ? state.weekly : defaultWeekly();
    if (!isObj(w.history)) w.history = {};
    if (w.week !== weekKey) {              // a new week starts: remember the last one's result
      if (w.week && w.completed && isNum(w.stars)) w.history[w.week] = Math.max(w.history[w.week] || 0, w.stars);
      w.week = weekKey; w.seed = 0; w.completed = false; w.bestCost = null; w.stars = 0;
    }
    if (isNum(seed)) w.seed = seed | 0;
    w.completed = true;
    var st = isNum(stars) ? Math.max(0, Math.min(3, Math.round(stars))) : 0;
    if (!isNum(w.stars) || st > w.stars) w.stars = st;
    if (isNum(cost) && cost >= 0) {
      var c = Math.round(cost);
      if (!isNum(w.bestCost) || c < w.bestCost) w.bestCost = c;
    }
    state.weekly = w;
    change();
    flush();
  }

  function saveCustomLevel(level) {
    if (!isObj(level) || typeof level.id !== 'string' || !level.id) return false;
    var copy;
    try { copy = clone(level); } catch (e) { return false; }
    var list = state.customLevels;
    var i = indexOfCustom(level.id);
    if (i >= 0) list[i] = copy; else list.push(copy);
    change();
    flush();
    return true;
  }

  function indexOfCustom(id) {
    var list = state.customLevels;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return i; }
    return -1;
  }

  function deleteCustomLevel(id) {
    var i = indexOfCustom(id);
    var bridgeKey = 'custom:' + id;
    if (i < 0 && !own(state.bridges, bridgeKey)) return false;
    if (i >= 0) state.customLevels.splice(i, 1);
    delete state.bridges[bridgeKey];
    change();
    flush();
    return true;
  }

  function getCustomLevels() { return clone(state.customLevels) || []; }

  function getCustomLevel(id) {
    var i = indexOfCustom(id);
    return i >= 0 ? clone(state.customLevels[i]) : null;
  }

  function setSetting(k, v) {
    if (typeof k !== 'string') return;
    if (state.settings[k] === v) return;
    state.settings[k] = v;
    change();
  }

  function getSetting(k) {
    if (own(state.settings, k)) return state.settings[k];
    var d = defaultSettings();
    return own(d, k) ? d[k] : undefined;
  }

  // ---- campaigns (v3.3) ----
  function getCampaigns() { return clone(state.campaigns) || defaultCampaigns(); }
  /** patch: { active, chosen, classic: {world, level}, zeit: {epoch, level} } (only the given fields change) */
  function setCampaigns(patch) {
    if (!isObj(patch)) return;
    var c = state.campaigns, changed = false;
    if ((patch.active === 'classic' || patch.active === 'zeit') && c.active !== patch.active) { c.active = patch.active; changed = true; }
    if (typeof patch.chosen === 'boolean' && c.chosen !== patch.chosen) { c.chosen = patch.chosen; changed = true; }
    ['classic', 'zeit'].forEach(function (k) {
      if (!isObj(patch[k])) return;
      Object.keys(patch[k]).forEach(function (f) { if (own(c[k], f) && f !== 'seen' && c[k][f] !== patch[k][f]) { c[k][f] = patch[k][f]; changed = true; } });
    });
    if (changed) change();
  }
  function markEpochSeen(id) {
    var seen = state.campaigns.zeit.seen;
    if (typeof id === 'string' && seen.indexOf(id) < 0) { seen.push(id); change(); }
  }
  function epochSeen(id) { return state.campaigns.zeit.seen.indexOf(id) >= 0; }

  function lastBackupAt() { return isNum(state.lastBackupAt) ? state.lastBackupAt : null; }

  function backupDue() {
    try {
      if (!hasProgress(state)) return false;
      var last = lastBackupAt();
      return last === null || now() - last > BACKUP_INTERVAL_MS;
    } catch (e) { return false; }
  }

  // Emergency copy of the current state before reset/import replace it.
  function snapshotReplaced() {
    try {
      var json = JSON.stringify(state);
      if (lsSet(LS_REPLACED, json) === 'quota') { lsRemove(LS_PREV); lsSet(LS_REPLACED, json); }
      idbWriteGated([[IDB_REPLACED, json]]);
    } catch (e) { /* ignore */ }
  }

  function resetProgress(opts) {
    var keepCustom = !!(opts && opts.keepCustom);
    snapshotReplaced();
    var old = state;
    var fresh = defaultState();
    fresh.settings = clone(old.settings) || defaultSettings();
    fresh.lastBackupAt = old.lastBackupAt;
    if (keepCustom) {
      fresh.customLevels = clone(old.customLevels) || [];
      Object.keys(old.bridges).forEach(function (k) {
        if (k.indexOf('custom:') === 0) fresh.bridges[k] = clone(old.bridges[k]);
      });
    }
    fresh.rev = (isNum(old.rev) ? old.rev : 0) + 1;
    fresh.savedAt = now();
    fresh.epoch = fresh.savedAt;      // other open tabs take this over instead of merging
    replaceState(fresh);
    dirty = true;
    flush();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function exportFileName(d) {
    return 'brueckenbauer-spielstand-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '.json';
  }

  function buildExport(d) {
    var snap = clone(state);
    snap.lastBackupAt = d.getTime();  // after a successful export this is the truth
    return {
      app: EXPORT_APP,
      kind: 'spielstand',
      format: EXPORT_FORMAT,
      exportedAt: d.toISOString(),
      gameVersion: (typeof BB.VERSION === 'string') ? BB.VERSION : null,
      saveVersion: SAVE_VERSION,
      state: snap
    };
  }

  function markBackedUp(t) {
    state.lastBackupAt = t;
    change();
    flush();
  }

  // File sharing (→ "In Dateien sichern" on iPad) is only offered on touch
  // devices; on a PC a normal download is the expected behaviour.
  function canShareFile(file) {
    try {
      var nav = G.navigator;
      if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
      if (!(nav.maxTouchPoints > 0)) return false;
      return !!nav.canShare({ files: [file] });
    } catch (e) { return false; }
  }

  function download(json, name) {
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    // revoke late: iOS opens the blob asynchronously
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      try { a.parentNode && a.parentNode.removeChild(a); } catch (e) { /* ignore */ }
    }, 60000);
  }

  // NOTE: everything up to navigator.share() runs synchronously so the call
  // still counts as part of the user's tap (Safari requires that).
  function exportFile() {
    var d = new Date();
    var name = exportFileName(d);
    var json;
    try {
      json = JSON.stringify(buildExport(d), null, 2);
    } catch (e) {
      warn('Spielstand konnte nicht exportiert werden.', e);
      return Promise.resolve({ ok: false, method: 'download', error: String(e && e.message || e) });
    }
    var doDownload = function () {
      try {
        download(json, name);
        markBackedUp(d.getTime());
        return { ok: true, method: 'download' };
      } catch (e) {
        warn('Download des Spielstands fehlgeschlagen.', e);
        return { ok: false, method: 'download', error: String(e && e.message || e) };
      }
    };
    var file = null;
    try { file = new File([json], name, { type: 'application/json' }); } catch (e) { file = null; }
    if (file && canShareFile(file)) {
      var shared;
      try {
        shared = G.navigator.share({ files: [file] });
      } catch (e) {
        return Promise.resolve(doDownload());
      }
      return Promise.resolve(shared).then(function () {
        markBackedUp(d.getTime());
        return { ok: true, method: 'share' };
      }, function (err) {
        if (err && err.name === 'AbortError') return { ok: false, method: 'share', cancelled: true };
        return doDownload();        // e.g. NotAllowedError → fall back to a normal download
      });
    }
    return Promise.resolve(doDownload());
  }

  function looksLikeState(o) {
    return isObj(o) && isObj(o.progress) && (isNum(o.version) || isNum(o.rev) || isObj(o.settings) || Array.isArray(o.customLevels));
  }

  function importError(msg) { return { ok: false, error: msg }; }

  // Validates + migrates an export file's text; does NOT apply it.
  function parseImport(text) {
    try {
      var obj;
      if (typeof text === 'string') {
        if (text.length > MAX_IMPORT_CHARS) return importError('Die Datei ist zu groß für einen Spielstand.');
        var t = text.replace(/^﻿/, '').trim();
        if (!t) return importError('Die Datei ist leer.');
        try { obj = JSON.parse(t); } catch (e) {
          return importError('Die Datei ist keine gültige Spielstand-Datei (kein lesbares JSON).');
        }
      } else if (isObj(text)) {
        obj = text;
      } else {
        return importError('Die Datei konnte nicht gelesen werden.');
      }
      if (!isObj(obj)) return importError('Diese Datei ist kein Brückenbauer-Spielstand.');

      var st;
      if (own(obj, 'app')) {
        if (obj.app !== EXPORT_APP) return importError('Diese Datei gehört nicht zu Brückenbauer.');
        st = obj.state;
        if (!isObj(st)) return importError('Die Datei enthält keinen Spielstand.');
      } else if (looksLikeState(obj)) {
        st = obj;                      // raw save (e.g. copied from the browser storage)
      } else {
        return importError('Diese Datei ist kein Brückenbauer-Spielstand.');
      }
      if (own(st, 'progress') && !isObj(st.progress)) return importError('Der Spielstand in der Datei ist beschädigt.');

      var migrated = migrate(st);
      var completed = Object.keys(migrated.progress.completed).filter(function (id) { return migrated.progress.completed[id]; }).length;
      var exportedAt = null;
      if (typeof obj.exportedAt === 'string') {
        var ms = Date.parse(obj.exportedAt);
        if (isFinite(ms)) exportedAt = ms;
      }
      return {
        ok: true,
        state: migrated,
        info: { completedLevels: completed, completedZeit: Object.keys(migrated.progress.completed).filter(function (id) { return migrated.progress.completed[id] && /^Z-/.test(id); }).length, customLevels: migrated.customLevels.length, exportedAt: exportedAt }
      };
    } catch (e) {
      return importError('Der Spielstand konnte nicht gelesen werden.');
    }
  }

  // Replaces the current state with an imported one (from parseImport) and saves
  // immediately. The imported state becomes the newest copy everywhere.
  function applyImport(imported) {
    if (!isObj(imported)) return false;
    var next;
    try { next = migrate(imported); } catch (e) { return false; }
    snapshotReplaced();
    next.rev = Math.max(isNum(state.rev) ? state.rev : 0, next.rev) + 1;
    next.savedAt = now();
    next.epoch = next.savedAt;
    replaceState(next);
    dirty = true;
    flush();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var api = {
    SAVE_VERSION: SAVE_VERSION,
    state: state,
    init: init,
    change: change,
    flush: flush,
    getBridge: getBridge,
    setBridge: setBridge,
    completeLevel: completeLevel,
    isCompleted: isCompleted,
    getStars: getStars,
    getBestCost: getBestCost,
    saveCustomLevel: saveCustomLevel,
    deleteCustomLevel: deleteCustomLevel,
    getCustomLevels: getCustomLevels,
    getCustomLevel: getCustomLevel,
    getDaily: getDaily,
    completeDaily: completeDaily,
    getWeekly: getWeekly,
    completeWeekly: completeWeekly,
    setSetting: setSetting,
    getSetting: getSetting,
    getCampaigns: getCampaigns,
    setCampaigns: setCampaigns,
    markEpochSeen: markEpochSeen,
    epochSeen: epochSeen,
    exportFile: exportFile,
    parseImport: parseImport,
    applyImport: applyImport,
    resetProgress: resetProgress,
    backupDue: backupDue,
    lastBackupAt: lastBackupAt,
    persisted: null,                       // true | false | null (unknown / unsupported)
    storageOk: { local: false, idb: false },
    ready: false,                          // true after init() has loaded
    loadedFrom: null,                      // 'local' | 'idb' | 'local-prev' | 'idb-prev' | null (fresh)
    lastError: null                        // last German warning text (for diagnostics)
  };

  BB.Save = api;
})(globalThis.BB = globalThis.BB || {});
