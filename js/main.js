/*
 * Brückenbauer – main.js
 * App controller: screens, HUD, input (Pointer Events), fixed-timestep game loop, sandbox, level editor,
 * settings/backup, self test and all iPad no-zoom/no-scroll measures (SPEC §9).
 *
 * Defensive by design: every call into another module (Save, Audio, Render, Physics, Levels) is guarded so
 * that one failing module never blanks the game. Without BB.Save (or if init() fails) the game runs with an
 * in-memory state; without BB.Render a simple built-in renderer is used.
 */
(function (BB) {
  'use strict';

  BB.VERSION = '3.4.0';

  const doc = document;

  // ===========================================================================
  // Small helpers
  // ===========================================================================
  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function jsonClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /** German number format: 3450 → "3.450", negative numbers with a real minus sign. */
  function fmtNum(n) {
    n = Math.round(Number(n) || 0);
    const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (n < 0 ? '−' : '') + s;
  }
  function fmtEuro(n) { return fmtNum(n) + ' €'; }
  /** 4 → "4", 4.5 → "4,5" */
  function fmtDec(v) { return String(Math.round(Number(v) * 10) / 10).replace('.', ','); }
  function fmtSigned(v) { return v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDateTime(ms) {
    const d = new Date(ms);
    return d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' Uhr';
  }
  function isoDate() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function icon(name, cls) { return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>'; }

  const warned = Object.create(null);
  function warn(msg, err) {
    try {
      const key = msg + (err && err.message ? ':' + err.message : '');
      if (warned[key]) return;
      warned[key] = true;
      console.warn('[Brückenbauer] ' + msg, err || '');
    } catch (e) { /* console unavailable */ }
  }
  function sound(name) {
    try { if (BB.Audio && typeof BB.Audio.play === 'function') BB.Audio.play(name); } catch (e) { warn('Audio.play', e); }
  }
  function isEditable(t) { return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')); }

  // ===========================================================================
  // Save facade (BB.Save or an in-memory fallback with the same API subset)
  // ===========================================================================
  let Save = null;
  let saveIsMemory = false;
  const SETTING_DEFAULTS = { muted: false, showStress: true, helpSeen: false, quality: 'mid', chaseCam: false, buildView: 'blueprint', volume: 0.7, sfx: true, music: false, testerMode: false, testerModeZeit: false, debugInfo: false, lastLevel: null };
  const SANDBOX_DEFAULT = { span: 16, heightDiff: 0, water: true, rocks: 0, lowAnchors: true, highAnchors: false, vehicles: ['car'], wind: 0, ice: false };

  function defaultState() {
    return {
      version: 1, rev: 0, savedAt: 0, createdAt: Date.now(),
      progress: { completed: {}, stars: {}, bestCost: {} },
      bridges: {}, customLevels: [],
      sandbox: jsonClone(SANDBOX_DEFAULT),
      settings: { muted: false, showStress: true },
      lastBackupAt: null,
    };
  }

  function createMemorySave() {
    const S = {
      SAVE_VERSION: 1, memory: true, persisted: null, storageOk: { local: false, idb: false },
      state: defaultState(),
      init() { return Promise.resolve(S.state); },
      change() { S.state.rev = (S.state.rev || 0) + 1; S.state.savedAt = Date.now(); },
      flush() {},
      getBridge(k) { const b = S.state.bridges[k]; return b ? jsonClone(b) : null; },
      setBridge(k, b) { S.state.bridges[k] = jsonClone(b); S.change(); },
      completeLevel(id, cost, stars) {
        const p = S.state.progress;
        p.completed[id] = true;
        p.stars[id] = Math.max(p.stars[id] || 0, stars | 0);
        p.bestCost[id] = p.bestCost[id] == null ? cost : Math.min(p.bestCost[id], cost);
        S.change();
      },
      isCompleted(id) { return !!S.state.progress.completed[id]; },
      getStars(id) { return S.state.progress.stars[id] || 0; },
      saveCustomLevel(level) {
        const list = S.state.customLevels, copy = jsonClone(level);
        const i = list.findIndex((l) => l.id === level.id);
        if (i >= 0) list[i] = copy; else list.push(copy);
        S.change();
      },
      deleteCustomLevel(id) {
        S.state.customLevels = S.state.customLevels.filter((l) => l.id !== id);
        delete S.state.bridges['custom:' + id];
        S.change();
      },
      getCustomLevels() { return S.state.customLevels.slice(); },
      getCampaigns() { return S.state.campaigns ? jsonClone(S.state.campaigns) : { active: 'classic', chosen: false, classic: { world: null, level: null }, zeit: { epoch: null, level: null, seen: [] } }; },
      setCampaigns(patch) { const c = S.state.campaigns || (S.state.campaigns = { active: 'classic', chosen: false, classic: { world: null, level: null }, zeit: { epoch: null, level: null, seen: [] } }); if (patch.active) c.active = patch.active; if (typeof patch.chosen === 'boolean') c.chosen = patch.chosen; ['classic', 'zeit'].forEach((k) => { if (patch[k]) Object.assign(c[k], patch[k]); }); S.change(); },
      markEpochSeen(id) { const c = S.state.campaigns; if (c && c.zeit.seen.indexOf(id) < 0) { c.zeit.seen.push(id); S.change(); } },
      epochSeen(id) { const c = S.state.campaigns; return !!(c && c.zeit.seen.indexOf(id) >= 0); },
      setSetting(k, v) { S.state.settings[k] = v; S.change(); },
      getSetting(k) { return S.state.settings[k]; },
      getWeekly(k) { const w = S.state.weekly; return (w && w.week === k) ? jsonClone(w) : { week: k, seed: 0, completed: false, bestCost: null, stars: 0 }; },
      completeWeekly(k, seed, cost, stars) { S.state.weekly = { week: k, seed: seed | 0, completed: true, bestCost: Math.round(cost), stars: Math.max(0, Math.min(3, stars | 0)) }; S.change(); },
      exportFile() {
        try {
          const blob = new Blob([JSON.stringify(S.state, null, 1)], { type: 'application/json' });
          const a = doc.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'brueckenbauer-spielstand-' + isoDate() + '.json';
          doc.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
          S.state.lastBackupAt = Date.now();
          return Promise.resolve({ ok: true, method: 'download' });
        } catch (e) {
          return Promise.resolve({ ok: false, method: 'download' });
        }
      },
      parseImport(text) {
        try {
          const st = JSON.parse(text);
          if (!st || typeof st !== 'object' || !st.progress) return { ok: false, error: 'Die Datei ist kein Brückenbauer-Spielstand.' };
          return { ok: true, state: st };
        } catch (e) {
          return { ok: false, error: 'Die Datei konnte nicht gelesen werden.' };
        }
      },
      applyImport(st) {
        const rev = Math.max(S.state.rev || 0, st.rev || 0) + 1;
        S.state = Object.assign(defaultState(), jsonClone(st));
        S.state.rev = rev;
      },
      resetProgress(opts) {
        const keep = !!(opts && opts.keepCustom);
        const ns = defaultState();
        ns.settings = S.state.settings;
        ns.sandbox = S.state.sandbox;
        if (keep) ns.customLevels = S.state.customLevels;
        S.state = ns;
        S.change();
      },
      backupDue() { return false; },
      lastBackupAt() { return S.state.lastBackupAt || null; },
    };
    return S;
  }

  /** Calls Save[method](...args) and never throws. */
  function sv(method) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const f = Save && Save[method];
      if (typeof f === 'function') return f.apply(Save, args);
    } catch (e) { warn('Save.' + method + ' fehlgeschlagen', e); }
    return undefined;
  }
  function getSetting(k) {
    const v = sv('getSetting', k);
    return (v === undefined || v === null) ? SETTING_DEFAULTS[k] : v;
  }
  function setSetting(k, v) { sv('setSetting', k, v); }
  function saveState() { return (Save && Save.state) || null; }

  function initSave() {
    const fallback = () => { Save = createMemorySave(); saveIsMemory = true; };
    if (!BB.Save || typeof BB.Save.init !== 'function') {
      warn('Speichermodul fehlt – Spielstand nur im Arbeitsspeicher');
      fallback();
      return Promise.resolve();
    }
    let settled = false;
    return new Promise((resolve) => {
      const done = (useReal) => {
        if (settled) return;
        settled = true;
        if (useReal && BB.Save.state && typeof BB.Save.state === 'object') { Save = BB.Save; saveIsMemory = false; }
        else fallback();
        resolve();
      };
      // IndexedDB can hang in some private modes – don't wait forever.
      setTimeout(() => { if (!settled) warn('Speicher-Initialisierung dauert zu lange'); done(true); }, 6000);
      try {
        Promise.resolve(BB.Save.init()).then(() => done(true), (e) => { warn('Save.init fehlgeschlagen', e); done(false); });
      } catch (e) { warn('Save.init fehlgeschlagen', e); done(false); }
    });
  }

  // ===========================================================================
  // Defensive access to the other modules
  // ===========================================================================
  // ===========================================================================
  // Campaigns: "classic" (BB.LEVELS + BB.Worlds) and "zeit" (BB.TIME: the Zeitreise with its epochs)
  // ===========================================================================
  const CAMP = { id: 'classic' };
  function isZeit() { return CAMP.id === 'zeit' && !!BB.TIME; }
  function LEVELS() { const L = isZeit() ? BB.TIME.LEVELS : BB.LEVELS; return Array.isArray(L) ? L : []; }
  /** levels of both campaigns (self test, lookups by id) */
  function ALL_LEVELS() { return (Array.isArray(BB.LEVELS) ? BB.LEVELS : []).concat(BB.TIME && Array.isArray(BB.TIME.LEVELS) ? BB.TIME.LEVELS : []); }
  /** worlds of the classic campaign / epochs of the Zeitreise (same fields: id, name, subtitle, theme, unlockStars, mx, my, description) */
  function WORLDS() { return isZeit() ? ((BB.TIME && BB.TIME.EPOCHS) || []) : (BB.Worlds ? BB.Worlds.LIST : []); }
  function worldGet(id) { return WORLDS().find((w) => w.id === id) || null; }
  function isZeitLevel(L) { return !!(L && BB.TIME && L.world && BB.TIME.get(L.world)); }
  function testerOn() { return !!getSetting(isZeit() ? 'testerModeZeit' : 'testerMode'); }
  function campaignData() {
    const c = sv('getCampaigns');
    return c && typeof c === 'object' ? c : { active: 'classic', chosen: false, classic: { world: null, level: null }, zeit: { epoch: null, level: null, seen: [] } };
  }
  function campaignLast() { const c = campaignData()[CAMP.id]; return c && c.level ? c.level : null; }
  function rememberPosition(lv) {
    if (!lv) return;
    const w = worldOfLevel(lv);
    sv('setCampaigns', isZeit() ? { zeit: { epoch: w, level: lv.id } } : { classic: { world: w, level: lv.id } });
  }
  function initCampaign() {
    const c = campaignData();
    CAMP.id = c.active === 'zeit' && BB.TIME && BB.TIME.availableEpochs().length ? 'zeit' : 'classic';
  }
  function switchCampaign(id, goMenu) {
    if (id === 'zeit' && !(BB.TIME && BB.TIME.availableEpochs().length)) { sound('error'); toast('Die Zeitreise ist bald verfügbar.', 'info'); return; }
    CAMP.id = id === 'zeit' ? 'zeit' : 'classic';
    sv('setCampaigns', { active: CAMP.id, chosen: true });
    const c = campaignData()[CAMP.id];
    currentWorld = c && (c.world || c.epoch) ? (c.world || c.epoch) : null;
    Menu.idx = 0; Menu.level = null; Menu.sim = null;
    if (goMenu !== false) showScreen('menu');
  }
  function campStats(id) {
    const list = id === 'zeit' ? ((BB.TIME && BB.TIME.LEVELS) || []) : (BB.LEVELS || []);
    let stars = 0;
    list.forEach((l) => { if (sv('isCompleted', l.id)) stars += clamp(sv('getStars', l.id) | 0, 0, 3); });
    const c = campaignData()[id] || {};
    const worlds = id === 'zeit' ? ((BB.TIME && BB.TIME.EPOCHS) || []) : (BB.Worlds ? BB.Worlds.LIST : []);
    const wid = c.epoch || c.world || (worlds[0] && worlds[0].id), w = worlds.find((x) => x.id === wid) || worlds[0];
    const done = list.filter((l) => sv('isCompleted', l.id)).length;
    return { stars, max: list.length * 3, levels: list.length, done, current: w ? w.name : '', epochs: id === 'zeit' ? BB.TIME.availableEpochs().length : (BB.Worlds ? BB.Worlds.LIST.length : 0) };
  }
  function hasPhysics() { return !!(BB.Physics && typeof BB.Physics.createSim === 'function' && typeof BB.Physics.step === 'function'); }
  function matDef(k) { return (BB.MATERIALS && BB.MATERIALS[k]) || null; }
  function vehicleOrder() { return (Array.isArray(BB.VEHICLE_ORDER) && BB.VEHICLE_ORDER.length) ? BB.VEHICLE_ORDER : ['bike', 'car', 'bus', 'truck']; }
  const VEHICLE_NAMES = { bike: 'Fahrrad', car: 'Auto', bus: 'Bus', truck: 'LKW' };
  function vehicleName(k) { const v = BB.VEHICLES && BB.VEHICLES[k]; return (v && v.name) || VEHICLE_NAMES[k] || k; }
  /** Vehicle weight in tonnes with German decimal comma, e.g. "1,2 t" ('' if unknown). */
  function vehicleWeight(k) {
    const v = BB.VEHICLES && BB.VEHICLES[k];
    return v && v.mass ? fmtDec(v.mass / 1000) + ' t' : '';
  }
  /** Special role of a material for the info texts. */
  /** materials that move in phases (hydraulics, winch) */
  function isHydKey(k) { const m = BB.MATERIALS && BB.MATERIALS[k]; return !!(m && m.hyd); }
  function matRole(m) { return m.drivable ? 'befahrbar' : m.tensionOnly ? 'nur Zug' : m.hyd ? 'fährt aus/ein' : m.k ? 'federt' : m.vertical ? 'senkrecht' : 'Stütze'; }
  /** One-line material info, e.g. "Holz · 100 €/m · 25 kg/m · hält 55 kN · max. 4 m". */
  function materialInfo(k) {
    const m = matDef(k);
    if (!m) return '';
    return m.name + ' · ' + fmtNum(m.price) + ' €/m · ' + fmtNum(m.mass) + ' kg/m · hält ' + fmtNum(m.strength / 1000) + ' kN · max. ' +
      fmtDec(m.maxLength) + ' m' + (m.drivable ? ' · befahrbar' : m.tensionOnly ? ' · nur Zug' : '');
  }
  /** Tables of all materials and vehicles for the help dialog (built from the physics data). */
  function materialTablesHtml() {
    const order = (Array.isArray(BB.MATERIAL_ORDER) && BB.MATERIAL_ORDER.length) ? BB.MATERIAL_ORDER : Object.keys(BB.MATERIALS || {});
    const rows = order.map(matDef).filter(Boolean).map((m) =>
      '<tr><td><span class="mt-sw" style="background:' + esc(m.color || '#888') + '"></span>' + esc(m.name) + '</td>' +
      '<td>' + fmtNum(m.price) + ' €</td><td>' + fmtNum(m.mass) + ' kg</td><td>' + fmtNum(m.strength / 1000) + ' kN</td>' +
      '<td>' + fmtDec(m.maxLength) + ' m</td><td>' + matRole(m) + '</td></tr>').join('');
    const veh = vehicleOrder().filter((k) => BB.VEHICLES && BB.VEHICLES[k]).map((k) =>
      '<span class="vt-item"><b>' + esc(vehicleName(k)) + '</b> ' + vehicleWeight(k) + '</span>').join('');
    if (!rows) return '';
    const F = BB.FOUNDATION;
    const foundRow = F ? '<tr><td><span class="mt-sw" style="background:' + esc(F.color) + '"></span>' + esc(F.name) + '</td><td>' + fmtNum(F.price) + ' € / Stück</td><td>–</td><td>trägt alles</td><td>am Boden</td><td>fester Punkt</td></tr>' : '';
    return '<h3 class="help-h">Materialien</h3>' +
      '<div class="mat-table-wrap"><table class="mat-table"><thead><tr><th>Material</th><th>Preis/m</th><th>Gewicht/m</th>' +
      '<th>Stärke</th><th>max. Länge</th><th>Art</th></tr></thead><tbody>' + rows + foundRow + '</tbody></table></div>' +
      '<p class="help-note">Stärke = größte Zug- oder Druckkraft, bevor der Balken bricht.</p>' +
      (veh ? '<h3 class="help-h">Fahrzeuge</h3><div class="veh-table">' + veh + '</div>' : '');
  }
  function starsFor(cost, budget) {
    try { if (BB.Levels && BB.Levels.stars) return BB.Levels.stars(cost, budget) | 0; } catch (e) { warn('Levels.stars', e); }
    if (budget == null) return 3;
    const r = cost / budget;
    return r <= 0.75 ? 3 : r <= 0.9 ? 2 : r <= 1 ? 1 : 0;
  }
  function cloneLevel(l) {
    let c = null;
    try { if (BB.Levels && BB.Levels.clone) c = BB.Levels.clone(l); } catch (e) { warn('Levels.clone', e); }
    c = c || jsonClone(l);
    if (l && l.editorParams && !c.editorParams) c.editorParams = jsonClone(l.editorParams);
    return c;
  }
  function bridgeClone(b) { return BB.Editor ? BB.Editor.cloneBridge(b) : jsonClone(b || { beams: [] }); }
  function bridgeCost(level, bridge) {
    try { if (BB.Bridge && BB.Bridge.cost) return BB.Bridge.cost(bridge); } catch (e) { warn('Bridge.cost', e); }
    let sum = 0;
    (bridge && bridge.beams || []).forEach((b) => { const m = matDef(b.m); if (m) sum += m.price * Math.hypot(b.x2 - b.x1, b.y2 - b.y1); });
    return Math.round(sum);
  }
  function validateLevel(l) {
    try { if (BB.Levels && BB.Levels.validate) { const r = BB.Levels.validate(l); if (r) return { ok: !!r.ok, errors: r.errors || [] }; } } catch (e) { warn('Levels.validate', e); return { ok: false, errors: ['Das Level konnte nicht geprüft werden.'] }; }
    return { ok: true, errors: [] };
  }
  function validateBridge(level, bridge) {
    try { if (BB.Bridge && BB.Bridge.validate) { const r = BB.Bridge.validate(level, bridge); if (r) return { ok: !!r.ok, errors: r.errors || [] }; } } catch (e) { warn('Bridge.validate', e); }
    return { ok: true, errors: [] };
  }
  function generateLevel(params) {
    try { if (BB.Levels && BB.Levels.generate) return BB.Levels.generate(params) || null; } catch (e) { warn('Levels.generate', e); }
    return null;
  }
  function resultText(reason) {
    try { if (BB.Physics && BB.Physics.resultText) { const t = BB.Physics.resultText(reason); if (t) return t; } } catch (e) { warn('Physics.resultText', e); }
    return ({ break: 'Ein Balken ist gebrochen!', fall: 'Ein Fahrzeug ist abgestürzt!', stuck: 'Ein Fahrzeug kommt nicht weiter.', timeout: 'Die Zeit ist abgelaufen.' })[reason] || 'Die Testfahrt ist gescheitert.';
  }
  function levelBounds(level) {
    try {
      if (BB.Levels && BB.Levels.fitBounds) {
        const b = BB.Levels.fitBounds(level);
        if (b && isFinite(b.minX) && isFinite(b.maxX) && isFinite(b.minY) && isFinite(b.maxY) && b.maxX > b.minX && b.maxY > b.minY) return b;
      }
    } catch (e) { warn('Levels.fitBounds', e); }
    const bd = level.build || { minX: -10, maxX: 10, minY: -10, maxY: 10 };
    const fx = isFinite(level.flagX) ? level.flagX : bd.maxX;
    return { minX: bd.minX - 3, maxX: Math.max(bd.maxX, fx) + 3, minY: bd.minY - 2, maxY: bd.maxY + 2 };
  }
  function vehKey(e) { return typeof e === 'string' ? e : (e && typeof e === 'object' && e.t) || ''; }
  function summarizeVehicles(list, withWeight) {
    const counts = {};
    (list || []).forEach((e) => { const k = vehKey(e); counts[k] = (counts[k] || 0) + 1; });
    const order = vehicleOrder().concat(Object.keys(counts).filter((k) => vehicleOrder().indexOf(k) < 0));
    return order.filter((k) => counts[k]).map((k) => {
      const w = withWeight ? vehicleWeight(k) : '';
      return counts[k] + '× ' + vehicleName(k) + (w ? ' (' + w + ')' : '');
    }).join(', ');
  }

  // ===========================================================================
  // Renderer (BB.Render or a simple built-in fallback)
  // ===========================================================================
  let canvas = null;
  let R = null;
  let usingFallbackRenderer = false;
  let drawFailures = 0;

  function viewW() { return (canvas && canvas.clientWidth) || window.innerWidth || 1024; }
  function viewH() { return (canvas && canvas.clientHeight) || window.innerHeight || 768; }
  // Camera math exactly as SPEC §2 (independent of the renderer, used for input)
  function w2s(c, x, y) {
    if (R && R.is3d) return R.worldToScreen(c, x, y);
    return [(x - c.x) * c.zoom + viewW() / 2, (c.y - y) * c.zoom + viewH() / 2];
  }
  function s2w(c, sx, sy) {
    if (R && R.is3d) return R.screenToWorld(c, sx, sy);
    return [(sx - viewW() / 2) / c.zoom + c.x, c.y - (sy - viewH() / 2) / c.zoom];
  }

  function fitFor(level, insets, W, H) {
    const b = levelBounds(level);
    const l = insets.left || 0, r = insets.right || 0, t = insets.top || 0, bo = insets.bottom || 0;
    const aw = Math.max(60, W - l - r), ah = Math.max(60, H - t - bo);
    const zoom = Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { x: cx - (l - r) / (2 * zoom), y: cy + (t - bo) / (2 * zoom), zoom: zoom };
  }

  /**
   * Minimal renderer used when render.js is missing or keeps failing (and for thumbnails without render.js).
   * fixedW/fixedH: draw into a canvas of exactly that pixel size (thumbnails), otherwise full-screen with DPR.
   */
  function createFallbackRenderer(cv, fixedW, fixedH) {
    const ctx = cv.getContext('2d');
    let W = 1, H = 1, dpr = 1;
    const api = {
      resize() {
        if (fixedW) { W = fixedW; H = fixedH; dpr = 1; cv.width = W; cv.height = H; return; }
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = cv.clientWidth || window.innerWidth; H = cv.clientHeight || window.innerHeight;
        cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
      },
      worldToScreen(c, x, y) { return [(x - c.x) * c.zoom + W / 2, (c.y - y) * c.zoom + H / 2]; },
      screenToWorld(c, sx, sy) { return [(sx - W / 2) / c.zoom + c.x, c.y - (sy - H / 2) / c.zoom]; },
      fitCamera(level, insets) { return fitFor(level, insets || {}, W, H); },
      addEvents() {},
      draw(scene) {
        if (!fixedW && (Math.round(cv.clientWidth) !== Math.round(W) || Math.round(cv.clientHeight) !== Math.round(H))) api.resize();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const sky = ctx.createLinearGradient(0, 0, 0, H);
        sky.addColorStop(0, '#5fb9f2'); sky.addColorStop(1, '#dff3ff');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
        const L = scene && scene.level, c = scene && scene.camera;
        if (!L || !c) return;
        const P = (x, y) => [(x - c.x) * c.zoom + W / 2, (c.y - y) * c.zoom + H / 2];
        const line = (x1, y1, x2, y2, color, width, dash) => {
          const a = P(x1, y1), b = P(x2, y2);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
          ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
        };
        const dot = (x, y, r, fill, stroke) => {
          const p = P(x, y);
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          ctx.fillStyle = fill; ctx.fill();
          if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
        };
        const z = c.zoom;
        // build grid
        if (scene.showGrid && L.build && z >= 9) {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          for (let x = Math.ceil(L.build.minX); x <= L.build.maxX; x++) {
            for (let y = Math.ceil(L.build.minY); y <= L.build.maxY; y++) { const p = P(x, y); ctx.fillRect(p[0] - 1.2, p[1] - 1.2, 2.4, 2.4); }
          }
        }
        // terrain
        const g = L.ground || [];
        if (g.length > 1) {
          ctx.beginPath();
          const first = P(g[0][0], g[0][1]);
          ctx.moveTo(first[0], first[1]);
          for (let i = 1; i < g.length; i++) { const p = P(g[i][0], g[i][1]); ctx.lineTo(p[0], p[1]); }
          const last = P(g[g.length - 1][0], g[g.length - 1][1]);
          ctx.lineTo(last[0], H + 50); ctx.lineTo(first[0], H + 50); ctx.closePath();
          ctx.fillStyle = '#a0764a'; ctx.fill();
          ctx.strokeStyle = '#5c4026'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
          for (let i = 0; i + 1 < g.length; i++) if (g[i][0] !== g[i + 1][0]) line(g[i][0], g[i][1], g[i + 1][0], g[i + 1][1], '#5cb83c', Math.max(3, z * 0.35));
        }
        // water
        if (L.water != null) {
          const wy = P(0, L.water)[1];
          ctx.fillStyle = 'rgba(40,130,215,0.55)'; ctx.fillRect(0, wy, W, H - wy);
        }
        // start & finish
        if (isFinite(L.flagX)) {
          const fy = surfaceAt(L, L.flagX);
          line(L.flagX, fy, L.flagX, fy + 4, '#333', 3);
          const p = P(L.flagX, fy + 4);
          ctx.fillStyle = '#e8443a'; ctx.fillRect(p[0], p[1], z * 1.6, z * 1);
        }
        if (scene.mode === 'leveledit' && L.build) {
          const a = P(L.build.minX, L.build.maxY), b = P(L.build.maxX, L.build.minY);
          ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(35,48,71,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.setLineDash([]);
          if (isFinite(L.startX)) { const sy = surfaceAt(L, L.startX); line(L.startX, sy, L.startX, sy + 3, '#2a9539', 4); }
        }
        const beamColor = (m) => { const d = matDef(m); return d ? d.color : '#888'; };
        const beamWidth = (m) => Math.max(2, z * (m === 'rope' ? 0.08 : m === 'road' || m === 'steelroad' ? 0.32 : 0.22));
        if (scene.mode === 'test' && scene.sim) {
          const sim = scene.sim;
          (sim.beams || []).forEach((b) => {
            if (b.broken) return;
            const col = scene.showStress && !b.debris ? stressColor(b.stress || 0) : beamColor(b.m);
            line(b.a.x, b.a.y, b.b.x, b.b.y, col, beamWidth(b.m));
          });
          (sim.joints || []).forEach((p) => { if (p.deg > 0 || p.anchor) dot(p.x, p.y, Math.max(2.5, z * (p.anchor ? 0.32 : 0.16)), p.anchor ? '#444' : '#ddd', '#333'); });
          (sim.vehicles || []).forEach((v) => {
            if (!v.visible || !v.pose) return;
            const d = v.def || {};
            const len = d.length || 4, hei = d.height || 1.5, ca = Math.cos(v.pose.angle || 0), sa = Math.sin(v.pose.angle || 0);
            const pt = (lx, ly) => P(v.pose.x + lx * ca - ly * sa, v.pose.y + lx * sa + ly * ca);
            const q = [pt(-len / 2, 0.3), pt(len / 2, 0.3), pt(len / 2, hei), pt(-len / 2, hei)];
            ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]); ctx.closePath();
            ctx.fillStyle = d.color || '#e8443a'; ctx.fill(); ctx.strokeStyle = '#233047'; ctx.lineWidth = 2; ctx.stroke();
            (v.wheels || []).forEach((w) => { if (w.p) dot(w.p.x, w.p.y, Math.max(3, (w.r || 0.4) * z), '#2b2b2b', '#111'); });
          });
        } else if (scene.bridge) {
          scene.bridge.beams.forEach((b, i) => {
            line(b.x1, b.y1, b.x2, b.y2, scene.deleteHighlight === i ? '#ff5050' : beamColor(b.m), beamWidth(b.m) + (scene.deleteHighlight === i ? 3 : 0));
          });
          const seen = {};
          scene.bridge.beams.forEach((b) => {
            [[b.x1, b.y1], [b.x2, b.y2]].forEach((p) => { const k = p[0] + ',' + p[1]; if (!seen[k]) { seen[k] = 1; dot(p[0], p[1], Math.max(2.5, z * 0.16), '#eee', '#333'); } });
          });
        }
        (L.anchors || []).forEach((a) => dot(a[0], a[1], Math.max(4, z * 0.3), '#4d5566', '#1f2533'));
        if (scene.preview) {
          const pv = scene.preview;
          line(pv.x1, pv.y1, pv.x2, pv.y2, pv.valid ? beamColor(pv.m) : 'rgba(230,50,50,0.9)', beamWidth(pv.m), pv.valid ? null : [8, 6]);
          dot(pv.x2, pv.y2, Math.max(3, z * 0.18), pv.valid ? '#fff' : '#f55', '#333');
        }
        if (scene.hoverNode) {
          const p = P(scene.hoverNode[0], scene.hoverNode[1]);
          ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(9, z * 0.5), 0, Math.PI * 2); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3; ctx.stroke();
        }
        if (scene.mode === 'leveledit') {
          g.forEach((p, i) => {
            const hv = scene.leveledit && scene.leveledit.hoverVertex === i;
            dot(p[0], p[1], hv ? 9 : 6, hv ? '#ffd23f' : '#fff', '#233047');
          });
        }
      },
    };
    api.resize();
    return api;
  }
  function surfaceAt(level, x) {
    try { if (BB.Terrain && BB.Terrain.surfaceY) return BB.Terrain.surfaceY(level.ground, x); } catch (e) { /* fall through */ }
    let best = -Infinity;
    const g = level.ground || [];
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i], b = g[i + 1];
      if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
      const y = a[0] === b[0] ? Math.max(a[1], b[1]) : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      if (y > best) best = y;
    }
    return isFinite(best) ? best : 0;
  }
  function stressColor(s) {
    try { if (BB.Render && BB.Render.stressColor) return BB.Render.stressColor(s); } catch (e) { /* fall through */ }
    s = clamp(s, 0, 1);
    const r = s < 0.5 ? Math.round(80 + 350 * s) : 255, gg = s < 0.5 ? 200 : Math.round(200 - 360 * (s - 0.5));
    return 'rgb(' + clamp(r, 0, 255) + ',' + clamp(gg, 0, 255) + ',60)';
  }

  // ---- graphics settings (read synchronously at start, before the save file is loaded) ----
  const GFX_KEY = 'brueckenbauer.gfx';
  function readGfx() { try { return JSON.parse(localStorage.getItem(GFX_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writeGfx(o) { try { localStorage.setItem(GFX_KEY, JSON.stringify(o)); } catch (e) { /* no storage */ } }
  function autoQuality() {
    const ua = navigator.userAgent || '';
    const touch = (navigator.maxTouchPoints || 0) > 1;
    if (/iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'mid';
    return 'mid';
  }
  let using3d = false;                 // the 3D scene renderer exists (WebGL works)
  let RBP = null, R3D = null, R2D = null;
  let viewKind = 'scene';               // what is drawn right now: 'blueprint' (Architektenansicht) | 'scene' (Szenenansicht)
  function initRenderer() {
    canvas = $('#game');
    const gfx = readGfx();
    const params = new URLSearchParams(location.search);
    const forced = params.get('gfx');
    const want3d = forced ? forced !== '2d' : gfx.mode !== '2d';
    const quality = (forced === 'low' || forced === 'mid' || forced === 'high') ? forced : (gfx.quality || autoQuality());
    try { if (BB.RenderBP) RBP = BB.RenderBP.create(canvas); } catch (e) { warn('Architektenansicht nicht verfügbar', e); RBP = null; }
    if (want3d && BB.Render3D && BB.Render3D.supported()) {
      try {
        R3D = BB.Render3D.create(canvas, $('#game3d'), { quality: quality, onLost: () => { warn('Grafikkarte hat die 3D-Ansicht verloren – wechsle auf 2D'); fallbackTo2d(); } });
        using3d = true;
      } catch (e) { warn('3D-Grafik nicht verfügbar – benutze 2D', e); R3D = null; using3d = false; }
    }
    if (!R3D) R2D = make2dClassic();
    if (!RBP && !R3D && !R2D) { R2D = createFallbackRenderer(canvas); usingFallbackRenderer = true; }
    setViewKind('scene', true);
  }
  function make2dClassic() {
    try { if (BB.Render && typeof BB.Render.create === 'function') return BB.Render.create(canvas); } catch (e) { warn('Render.create fehlgeschlagen', e); }
    return null;
  }
  /** Picks the renderer for a view: blueprint (2D, always possible) or scene (3D, else the classic 2D picture). */
  function setViewKind(k, silent) {
    if (k === 'blueprint' && !RBP) k = 'scene';
    const prevR = R;
    if (k === 'blueprint') R = RBP;
    else R = R3D || R2D || (R2D = make2dClassic()) || RBP || createFallbackRenderer(canvas);
    viewKind = (R === RBP) ? 'blueprint' : 'scene';
    const gl = R && R.is3d;
    doc.body.classList.toggle('gfx3d', !!gl);
    doc.body.setAttribute('data-view', viewKind);
    if (prevR !== R) { try { if (R.resize) R.resize(); if (R.clearEffects) R.clearEffects(); } catch (e) { warn('Ansicht wechseln', e); } }
    updateViewButtons();
    if (!silent && prevR !== R && camIsFit && viewLevel()) fitView(false);
  }
  function updateViewButtons() {
    $$('.view-btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(viewKind === 'blueprint'));
      b.title = viewKind === 'blueprint' ? 'Zur Szenenansicht wechseln (V)' : 'Zur Architektenansicht wechseln (V)';
      const t = b.querySelector('.view-text'); if (t) t.textContent = viewKind === 'blueprint' ? 'Architekt' : 'Szene';
    });
  }
  function buildViewPref() { const v = getSetting('buildView'); return v === 'scene' ? 'scene' : 'blueprint'; }
  /** Manual switch (button / key V). While building it is remembered as the preferred building view. */
  function toggleViewKind() {
    const next = viewKind === 'blueprint' ? 'scene' : 'blueprint';
    if (!(G.mode === 'test' && view === 'game')) setSetting('buildView', next);
    setViewKind(next);
    sound('click');
  }
  /** Switches from the 3D view to the classic 2D one (WebGL lost or switched off) without a reload. */
  function fallbackTo2d() {
    if (!using3d) return;
    using3d = false; R3D = null;
    try { const gl = $('#game3d'); if (gl) { gl.width = 1; gl.height = 1; } } catch (e) { /* ignore */ }
    R2D = make2dClassic();
    setViewKind(viewKind, true);
    resizeRenderer();
  }
  function resizeRenderer() { try { if (R && R.resize) R.resize(); } catch (e) { warn('Render.resize', e); } }

  /** Thumbnail canvas for a box of w×h CSS px (BB.Render.thumbnail applies devicePixelRatio itself). */
  function makeThumb(level, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let c = null;
    try { if (BB.RenderBP && typeof BB.RenderBP.thumbnail === 'function') c = BB.RenderBP.thumbnail(level, w, h); } catch (e) { warn('RenderBP.thumbnail', e); c = null; }
    try { if (!c && BB.Render && typeof BB.Render.thumbnail === 'function') c = BB.Render.thumbnail(level, w, h); } catch (e) { warn('Render.thumbnail', e); c = null; }
    if (!c || c.nodeType !== 1) {
      c = doc.createElement('canvas');
      try {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const fr = createFallbackRenderer(c, Math.round(w * dpr), Math.round(h * dpr));
        const camF = fr.fitCamera(level, { top: 4, left: 4, right: 4, bottom: 4 });
        fr.draw({ mode: 'build', level: level, camera: camF, time: 0, bridge: { beams: [] } });
      } catch (e) { warn('Vorschaubild', e); }
    }
    c.style.width = ''; c.style.height = '';      // the box's CSS (100 % × 100 %) decides the display size
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  let thumbCache = Object.create(null);
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function thumbFor(level, w, h) {
    const key = level.id + '|' + w + 'x' + h + '|' + hashStr(JSON.stringify([level.ground, level.anchors, level.water, level.flagX, level.startX]));
    if (!thumbCache[key]) thumbCache[key] = makeThumb(level, w, h);
    return thumbCache[key];
  }

  // ===========================================================================
  // Camera
  // ===========================================================================
  let cam = { x: 0, y: 0, zoom: 30 };
  let camLim = null;
  let camIsFit = true;
  let camTween = null;

  function setCamLimits(level, fit) {
    const b = levelBounds(level);
    const sx = isFinite(level.startX) ? level.startX - 4 : b.minX;
    const fx = isFinite(level.flagX) ? level.flagX + 6 : b.maxX;
    camLim = {
      minX: Math.min(b.minX, sx, fit.x), maxX: Math.max(b.maxX, fx, fit.x),
      minY: Math.min(b.minY - 2, fit.y), maxY: Math.max(b.maxY + 2, fit.y),
      zMin: fit.zoom * 0.45, zMax: Math.max(fit.zoom * 5, 70),
    };
  }
  function clampCam() {
    if (!camLim) return;
    cam.zoom = clamp(cam.zoom, camLim.zMin, camLim.zMax);
    cam.x = clamp(cam.x, camLim.minX, camLim.maxX);
    cam.y = clamp(cam.y, camLim.minY, camLim.maxY);
  }
  function computeFit(level, insets) {
    let c = null;
    try { c = R.fitCamera(level, insets); } catch (e) { warn('Render.fitCamera', e); c = null; }
    if (!c || !isFinite(c.x) || !isFinite(c.y) || !isFinite(c.zoom) || c.zoom <= 0) c = fitFor(level, insets, viewW(), viewH());
    return { x: c.x, y: c.y, zoom: c.zoom };
  }
  function measureInsets() {
    const W = viewW(), H = viewH();
    const ins = { top: 10, right: 10, bottom: 10, left: 10 };
    const rect = (sel) => {
      const e = $(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) ? r : null;
    };
    if (view === 'game') {
      const tb = rect('#screen-game .topbar');
      if (tb) ins.top = tb.bottom + 10;
      const bb = rect(G.mode === 'test' ? '#bar-test' : '#bar-build');
      if (bb) ins.bottom = H - bb.top + 10;
      const rl = G.mode === 'build' && !G.hudOff ? rect('#tool-rail') : null;
      if (rl && rl.right < W * 0.3) ins.left = rl.right + 10;
    } else if (view === 'editor') {
      const tb = rect('#screen-editor .topbar');
      if (tb) ins.top = tb.bottom + 10;
      const pn = rect('#screen-editor .ed-panel');
      if (pn) { if (pn.width > W * 0.6) ins.bottom = H - pn.top + 10; else ins.right = W - pn.left + 10; }
    } else if (view === 'menu') {
      const mp = rect('#screen-menu .menu-panel');
      if (mp) { if (mp.width < W * 0.5) ins.left = mp.right + 16; else ins.top = mp.bottom + 10; }
    }
    if (W - ins.left - ins.right < 220) { ins.left = 10; ins.right = 10; }
    if (H - ins.top - ins.bottom < 180) { ins.top = Math.min(ins.top, H * 0.3); ins.bottom = Math.min(ins.bottom, H * 0.3); }
    return ins;
  }
  /** Level editor: the fitted view must also show the ground vertices below the build area (canyon floor). */
  function editorFitLevel(L) {
    if (!L || !L.build || !Array.isArray(L.ground)) return L;
    let low = Infinity;
    L.ground.forEach((p) => { if (p && p[0] >= L.build.minX - 1 && p[0] <= L.build.maxX + 1 && p[1] < low) low = p[1]; });
    if (!(low < L.build.minY - 0.5)) return L;
    return Object.assign({}, L, { build: Object.assign({}, L.build, { minY: Math.floor(low) - 1 }) });
  }
  /** Level whose bounds the camera fits (only used for fitting / camera limits). */
  function viewLevel() {
    if (view === 'game') return G.level;
    if (view === 'editor') return editorFitLevel(E.level);
    if (view === 'menu') return Menu.level;
    return null;
  }
  function fitView(animate) {
    const L = viewLevel();
    if (!L) return;
    const fit = computeFit(L, measureInsets());
    setCamLimits(L, fit);
    camIsFit = true;
    if (animate) camTween = { from: { x: cam.x, y: cam.y, zoom: cam.zoom }, to: fit, t: 0, dur: 0.35 };
    else { camTween = null; cam = { x: fit.x, y: fit.y, zoom: fit.zoom }; }
  }
  function updateCamTween(dt) {
    if (!camTween) return;
    camTween.t += dt;
    const k = Math.min(1, camTween.t / camTween.dur), e = 1 - Math.pow(1 - k, 3);
    const a = camTween.from, b = camTween.to;
    cam.x = a.x + (b.x - a.x) * e;
    cam.y = a.y + (b.y - a.y) * e;
    cam.zoom = a.zoom * Math.pow(b.zoom / a.zoom, e);
    if (k >= 1) camTween = null;
  }
  function zoomAt(sx, sy, factor) {
    camTween = null;
    const w = s2w(cam, sx, sy);
    cam.zoom = camLim ? clamp(cam.zoom * factor, camLim.zMin, camLim.zMax) : cam.zoom * factor;
    for (let it = 0; it < 3; it++) {          // keep the point under the cursor fixed (iterative: also exact for the tilted 3D camera)
      const w2 = s2w(cam, sx, sy);
      cam.x += w[0] - w2[0]; cam.y += w[1] - w2[1];
    }
    clampCam();
    camIsFit = false;
  }

  // ===========================================================================
  // Screens, modals, toasts, small widgets
  // ===========================================================================
  let currentScreen = 'loading';
  let view = 'none';                // what the canvas shows: 'menu' | 'game' | 'editor' | 'none'
  const screenHooks = {};

  function setView(v) {
    view = v;
    resetPointers();
    camTween = null;
    if (canvas) canvas.style.cursor = '';
  }
  function showScreen(name) {
    if (currentScreen === name) { const h0 = screenHooks[name]; if (h0 && h0.show) h0.show(); return; }
    const prev = screenHooks[currentScreen];
    if (prev && prev.hide) { try { prev.hide(); } catch (e) { warn('Bildschirm verlassen', e); } }
    currentScreen = name;
    $$('#toast-layer .toast.warn').forEach((t) => { if (t.parentNode) t.parentNode.removeChild(t); });   // stale hints of the old screen
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    doc.body.setAttribute('data-screen', name);
    const h = screenHooks[name];
    if (h && h.show) { try { h.show(); } catch (e) { warn('Bildschirm anzeigen: ' + name, e); } }
  }

  const modalStack = [];
  /**
   * Custom modal dialog. o: { title, html, node, icon, cls, buttons:[{label, kind, icon, action(handle) → false keeps open}],
   * dismissable (backdrop/Esc closes, default true), onEscape, onClose }
   */
  function openModal(o) {
    const layer = $('#modal-layer');
    const back = el('div', 'modal-back');
    const box = el('div', 'modal' + (o.cls ? ' ' + o.cls : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (o.icon) box.appendChild(el('div', 'modal-icon', icon(o.icon)));
    if (o.title) { const h = el('h2', 'modal-title'); h.textContent = o.title; box.appendChild(h); }
    const body = el('div', 'modal-body scroll');
    if (o.html) body.innerHTML = o.html;
    if (o.node) body.appendChild(o.node);
    box.appendChild(body);
    const btns = el('div', 'modal-buttons');
    const handle = { el: box, body: body, opts: o, closed: false, close: close };
    (o.buttons || [{ label: 'OK', kind: 'blue' }]).forEach((b) => {
      const bt = el('button', 'btn btn-' + (b.kind || 'white'), (b.icon ? icon(b.icon) : '') + '<span>' + esc(b.label) + '</span>');
      bt.type = 'button';
      if (b.id) bt.id = b.id;
      bt.addEventListener('click', () => {
        if (handle.closed) return;
        let r;
        try { r = b.action ? b.action(handle) : undefined; } catch (e) { warn('Dialog-Aktion', e); }
        if (r !== false) close();
      });
      btns.appendChild(bt);
    });
    box.appendChild(btns);
    back.appendChild(box);
    layer.appendChild(back);
    void back.offsetWidth;          // start the CSS transition
    back.classList.add('show');
    if (o.dismissable !== false) back.addEventListener('click', (e) => { if (e.target === back) close(); });
    modalStack.push(handle);
    resetPointers();
    function close() {
      if (handle.closed) return;
      handle.closed = true;
      const i = modalStack.indexOf(handle);
      if (i >= 0) modalStack.splice(i, 1);
      back.classList.remove('show');
      back.classList.add('closing');
      setTimeout(() => { if (back.parentNode) back.parentNode.removeChild(back); }, 230);
      if (o.onClose) { try { o.onClose(); } catch (e) { warn('Dialog schließen', e); } }
    }
    return handle;
  }
  function closeAllModals() { modalStack.slice().forEach((m) => m.close()); }
  function infoModal(title, text, cls) {
    return openModal({ title: title, icon: cls === 'fail' || cls === 'warn' ? 'warn' : null, cls: cls || '', html: '<p>' + esc(text) + '</p>', buttons: [{ label: 'OK', kind: 'blue' }] });
  }
  function errorsHtml(errors) {
    return '<ul class="errors">' + (errors || []).slice(0, 8).map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>';
  }
  function confirmModal(o) {
    return openModal({
      title: o.title, icon: o.icon || null, cls: o.cls || '', html: o.html || ('<p>' + esc(o.text || '') + '</p>'),
      buttons: [
        { label: o.cancelLabel || 'Abbrechen', kind: 'white' },
        { label: o.okLabel || 'OK', kind: o.okKind || 'blue', icon: o.okIcon, action: o.onOk },
      ],
    });
  }

  function toast(msg, kind) {
    const layer = $('#toast-layer');
    if (!layer) return;
    const last = layer.lastElementChild;
    if (last && last.textContent === msg) layer.removeChild(last);
    if (kind === 'info') Array.from(layer.querySelectorAll('.toast.info')).forEach((n) => { if (n.parentNode) n.parentNode.removeChild(n); });   // one hint at a time
    while (layer.children.length >= 3) layer.removeChild(layer.firstElementChild);
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''));
    t.textContent = msg;
    layer.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 330);
    }, 2300);
  }

  /** Calls fn on press and repeats while the button is held (steppers). Keyboard clicks still work. */
  function holdRepeat(btn, fn) {
    let t1 = null, t2 = null;
    const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (btn.disabled) return;
      fn();
      stop();
      t1 = setTimeout(() => { t2 = setInterval(() => { if (btn.disabled) { stop(); return; } fn(); }, 85); }, 430);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture'].forEach((t) => btn.addEventListener(t, stop));
    btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
  }
  function makeStepper(value, min, max, step, fmt, onChange) {
    const wrap = el('div', 'stepper');
    const minus = el('button', 'step-btn', icon('minus'));
    const val = el('span', 'step-val');
    const plus = el('button', 'step-btn', icon('plus'));
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'weniger');
    plus.setAttribute('aria-label', 'mehr');
    wrap.appendChild(minus); wrap.appendChild(val); wrap.appendChild(plus);
    const api = {
      el: wrap, value: value, min: min, max: max,
      render() { val.textContent = fmt(api.value); minus.disabled = api.value <= api.min; plus.disabled = api.value >= api.max; },
    };
    const change = (d) => {
      const v = clamp(api.value + d, api.min, api.max);
      if (v === api.value) return;
      api.value = v;
      onChange(v, api);
      api.render();
    };
    holdRepeat(minus, () => change(-step));
    holdRepeat(plus, () => change(step));
    api.render();
    return api;
  }
  function makeSwitch(value, onChange, label) {
    const b = el('button', 'switch', '<i></i>');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    if (label) b.setAttribute('aria-label', label);
    const api = { el: b, value: !!value, set(v) { api.value = !!v; b.setAttribute('aria-checked', String(api.value)); } };
    b.addEventListener('click', () => { api.set(!api.value); onChange(api.value); });
    api.set(api.value);
    return api;
  }
  function paramRow(iconName, title, sub, control, iconCls) {
    const row = el('div', 'prow');
    row.innerHTML = '<div class="prow-label">' + (iconName ? icon(iconName, iconCls) : '') +
      '<div class="prow-text"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div></div>';
    row.appendChild(control);
    return row;
  }
  function starsHtml(n, cls) {
    let s = '<span class="stars ' + (cls || '') + '" aria-label="' + n + ' von 3 Sternen">';
    for (let i = 0; i < 3; i++) s += icon('star', i < n ? 'on' : '');
    return s + '</span>';
  }

  /** Normalizes generator parameters (sandbox / level editor). */
  function normalizeShape(p) {
    const int = (v, a, b, d) => { v = Math.round(Number(v)); return isFinite(v) ? clamp(v, a, b) : d; };
    p.span = int(p.span, 6, 48, 16);
    p.heightDiff = int(p.heightDiff, -8, 8, 0);
    p.water = p.water !== false;
    p.rocks = int(p.rocks, 0, 2, 0);
    p.lowAnchors = !!p.lowAnchors;
    p.highAnchors = !!p.highAnchors;
    p.wind = int(p.wind, -6, 6, 0);
    p.ice = !!p.ice;
    return p;
  }
  function normalizeVehicles(list) {
    const order = vehicleOrder();
    const out = (Array.isArray(list) ? list : []).filter((k) => order.indexOf(vehKey(k)) >= 0).slice(0, 8);
    return out.length ? out : ['car'];
  }

  /** Rows for span / height / water / rocks / anchors / towers. onChange(field) after each change. */
  function buildShapeRows(container, p, onChange) {
    container.innerHTML = '';
    const st = (field, iconName, title, sub, min, max, fmt) => {
      const s = makeStepper(p[field], min, max, 1, fmt, (v) => { p[field] = v; onChange(field); });
      container.appendChild(paramRow(iconName, title, sub, s.el));
    };
    const sw = (field, iconName, title, sub) => {
      const s = makeSwitch(p[field], (v) => { p[field] = v; onChange(field); }, title);
      container.appendChild(paramRow(iconName, title, sub, s.el));
    };
    st('span', 'fit', 'Spannweite', 'Abstand der Ufer', 6, 48, (v) => v + ' m');
    st('heightDiff', 'terrain', 'Höhenunterschied', 'Rechtes Ufer höher/tiefer', -8, 8, (v) => fmtSigned(v) + ' m');
    sw('water', 'sandbox', 'Wasser', 'Fluss in der Schlucht');
    st('rocks', 'anchor', 'Felsen', 'Pfeiler mit Anker', 0, 2, (v) => String(v));
    sw('lowAnchors', 'anchor', 'Tiefe Anker', '3 m unter den Kanten');
    sw('highAnchors', 'flag', 'Hängebrücken-Türme', 'Hohe Anker für Seile');
    st('wind', 'wind', 'Wind', 'Seitlicher Schub auf Brücke & Fahrzeuge', -6, 6, (v) => fmtSigned(v));
    sw('ice', 'ice', 'Glatte Fahrbahn', 'Weniger Grip – Eis im Winter');
  }

  /** One counter row per vehicle type; getList/setList access the vehicle key array. */
  function buildVehicleRows(container, getList, setList, nRoutes) {
    container.innerHTML = '';
    nRoutes = nRoutes || 1;
    const order = vehicleOrder();
    const steppers = [];
    const routeOf = (e) => (typeof e === 'object' && e && e.r) || 0;
    const counts = (r) => { const c = {}; getList().forEach((e) => { if (routeOf(e) === r) { const k = vehKey(e); c[k] = (c[k] || 0) + 1; } }); return c; };
    const refreshLimits = () => {
      const total = getList().length;
      steppers.forEach((s) => {
        s.min = (total <= 1 && s.value >= 1) ? s.value : 0;     // at least one vehicle overall
        s.max = Math.min(5, s.value + (8 - total));             // at most 8 vehicles
        s.render();
      });
    };
    const rebuild = (changedR, changedK, v) => {
      const c = [];
      for (let r = 0; r < nRoutes; r++) c.push(counts(r));
      c[changedR][changedK] = v;
      const list = [];
      for (let r = 0; r < nRoutes; r++) order.forEach((kk) => { for (let i = 0; i < (c[r][kk] || 0); i++) list.push(nRoutes > 1 ? { t: kk, r: r } : kk); });
      setList(list);
      refreshLimits();
    };
    order.forEach((k) => {
      const holder = el('div', 'veh-steppers');
      for (let r = 0; r < nRoutes; r++) {
        const s = makeStepper(counts(r)[k] || 0, 0, 5, 1, (v) => String(v), (v) => rebuild(r, k, v));
        if (nRoutes > 1) s.el.classList.add('route-' + r);
        steppers.push(s);
        holder.appendChild(s.el);
      }
      container.appendChild(paramRow(k, vehicleName(k), nRoutes > 1 ? 'rot · blau' : null, holder, 'veh-ic'));
    });
    refreshLimits();
  }

  // ===========================================================================
  // Help dialogs
  // ===========================================================================
  const ILL = {
    build: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><path d="M4 50h16v10H4z" fill="#a0764a"/><path d="M4 50h16" stroke="#5cb83c" stroke-width="4"/><path d="M14 48L46 22" stroke="#474e5b" stroke-width="7" stroke-linecap="round"/><path d="M14 48L46 22" stroke="#ffe066" stroke-width="1.6" stroke-dasharray="4 4"/><circle cx="14" cy="48" r="6" fill="#4d5566" stroke="#1f2533" stroke-width="2.5"/><circle cx="46" cy="22" r="5" fill="#fff" stroke="#233047" stroke-width="2.5"/><circle cx="52" cy="14" r="9" fill="#ffd9b8" stroke="#233047" stroke-width="2.5"/></svg>',
    erase: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><path d="M8 44L56 30" stroke="#a0673a" stroke-width="7" stroke-linecap="round"/><g transform="rotate(-30 36 28)"><rect x="24" y="14" width="26" height="16" rx="4" fill="#ff7f8a" stroke="#233047" stroke-width="2.5"/><rect x="24" y="14" width="10" height="16" rx="3" fill="#7fb3ff" stroke="#233047" stroke-width="2.5"/></g><path d="M18 52l6-6M28 54l3-7" stroke="#ec4c4c" stroke-width="3" stroke-linecap="round"/></svg>',
    pinch: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><circle cx="20" cy="40" r="9" fill="#ffd9b8" stroke="#233047" stroke-width="2.5"/><circle cx="44" cy="24" r="9" fill="#ffd9b8" stroke="#233047" stroke-width="2.5"/><path d="M12 52L4 60M52 12l8-8" stroke="#2f8ff0" stroke-width="3.5" stroke-linecap="round"/><path d="M4 53v7h7M53 4h7v7" fill="none" stroke="#2f8ff0" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    test: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="10" width="52" height="44" rx="14" fill="#3dbb4c"/><path d="M6 44h52v-4c0 8-6 14-14 14H20C12 54 6 48 6 40z" fill="#258a34"/><path d="M26 22v20l16-10z" fill="#fff"/></svg>',
    mats: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="10" width="52" height="9" rx="4.5" fill="#474e5b"/><path d="M12 14.5h40" stroke="#ffe066" stroke-width="2" stroke-dasharray="5 4"/><rect x="6" y="26" width="52" height="8" rx="4" fill="#a0673a"/><rect x="6" y="41" width="52" height="8" rx="2" fill="#d9532c"/><path d="M6 56q26 6 52 0" fill="none" stroke="#333" stroke-width="2.5"/></svg>',
    undo: '<svg class="ill" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#e1f0ff"/><path d="M24 38l-9-9 9-9" fill="none" stroke="#1b68b8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 29h18a10 10 0 0 1 0 20h-6" fill="none" stroke="#1b68b8" stroke-width="5" stroke-linecap="round"/></svg>',
  };
  const HELP_IC = { build: 'tools', erase: 'eraser', pinch: 'fit', test: 'play', mats: 'cable', undo: 'undo', view: 'view', lab: 'lab', sound: 'sound-on' };
  function helpItem(ill, title, text) {
    return '<div class="help-item">' + icon(HELP_IC[ill] || 'help') + '<div><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div></div>';
  }
  function showHelp(firstTime) {
    const lvl = (view === 'game' && G.level && G.level.description) ? '<p class="help-foot"><b>Dieses Level:</b> ' + esc(G.level.description) + '</p>' : '';
    openModal({
      cls: 'wide', title: "So geht's",
      html: '<div class="help-grid">' +
        helpItem('build', 'Balken bauen', 'Ziehe von einem Punkt (Anker oder Knoten) aus und lass dort los, wo der Balken enden soll.') +
        helpItem('erase', 'Löschen-Werkzeug', 'Mit dem Radierer tippst oder wischst du Balken weg.') +
        helpItem('pinch', 'Zoomen & Verschieben', 'Zwei Finger = Zoomen/Verschieben (auch mit dem Stift). Maus: Rad zum Zoomen, mittlere Taste oder Leertaste halten + ziehen zum Verschieben.') +
        helpItem('test', 'Testfahrt', 'Starte die Fahrzeuge und schau, ob die Brücke hält. Mit „Stopp“ baust du weiter.') +
        helpItem('mats', 'Materialien', 'Auf Straße fahren die Fahrzeuge. Holz und Stahl stützen, Seile halten nur auf Zug.') +
        helpItem('undo', 'Rückgängig', 'Fehler? Rückgängig und Wiederholen helfen – beliebig oft. Am PC: Strg+Z, Strg+Y. Leertaste antippen = Testfahrt.') +
        helpItem('build', 'Auswählen & bearbeiten', 'Werkzeug „Wählen“: Rahmen ziehen oder Teil antippen. Gezogen wird die Auswahl verschoben (grün = passt, rot = nicht). Unten: Kopieren, Ausschneiden, Einfügen, Drehen (Q/E, je 15°), Spiegeln (F, Umschalt+F), Löschen (Entf).') +
        helpItem('build', 'Linie & Bogen', 'Mit „Linie“ oder „Bogen“ zeichnest du eine Strecke nach: Die Gelenke verteilen sich gleichmäßig und werden mit dem gewählten Material verbunden. „Füllen“ ergänzt Streben. Beim Bogen ziehst du erst Anfang und Ende, dann die Wölbung.') +
        helpItem('test', 'Tastatur', '1–9, 0 = Material · B Bauen · S Wählen · X Löschen · L Linie · A Bogen · J Teilen · P Phasen · U Fundament · G Raster · T Belastungsvorschau · H Oberfläche ausblenden · I Level-Info · V Ansicht.') +
        helpItem('test', 'Zeitlupe, Pause, Wiederholung', 'Bei der Testfahrt: Pause (P), Zeitlupe, Zeitleiste zum Zurückspulen, „Wiederholen“ (R) und die Verfolgerkamera (C).') +
        helpItem('mats', 'Hydraulik & Phasen', 'Ein Kolben fährt in den eingestellten Phasen aus oder ein. Die nächste Phase startet an einem Kontrollpunkt – oder per Phasen-Knopf. Einstellen mit „Phasen“.') +
        helpItem('build', 'Feder, Kabel, Fundament', 'Federn geben nach, Kabel halten sehr viel – aber nur auf Zug. Ein Fundament setzt einen festen Punkt auf den Boden (teuer!).') +
        helpItem('mats', 'Schiffe, LKW & Züge', 'Unter der Brücke fahren sie durch den gestrichelten Rahmen (Durchfahrt). Hängt etwas hinein, bleiben sie stehen und das Level ist verloren. Sperrige Brücken müssen sich öffnen – das lösen Schiffe und Fahrzeuge mit ihren Kontrollpunkten aus.') +
        helpItem('build', 'Fundamente', 'Ein Fundament steht nur auf festem Boden: Beim Setzen zeigt die Vorschau grün (möglich) oder rot (mit Grund). In der Luft hängt es nie.') +
        helpItem('view', 'Zwei Ansichten', 'Architekt = Bauplan von vorn mit Gitter nur in der Bauzone. Szene = 3D-Welt. Wechsel mit dem Knopf oben oder mit V. Die Testfahrt zeigt automatisch die Szene.') +
        helpItem('lab', 'Testlabor & Tester-Modus', 'Im Menü findest du das Testlabor mit Kurztests für jede Mechanik. In den Einstellungen schaltet der Tester-Modus alle Welten frei – dein echter Fortschritt bleibt unverändert.') +
        helpItem('build', 'Fahrrouten & Fahnen', 'Jedes Fahrzeug hat Fahnen in seiner Farbe: erst die nummerierten Zwischenfahnen, dann das Ziel (Stern). Eine Fahne zählt nur, wenn das Fahrzeug in ihrer Höhe vorbeifährt – auf dem Boden oder auf dem Brückendeck. Manche Fahrzeuge warten, bis ein anderes eine Fahne erreicht hat; unten bei der Testfahrt steht, worauf. Die gestrichelte Linie in der Architektenansicht zeigt den Weg.') +
        helpItem('lab', 'Zwei Kampagnen', 'Im Menü wechselst du mit „Kampagne wechseln“ zwischen „Klassisch“ (13 Welten, alle Materialien) und der „Zeitreise“ (Steinzeit bis Moderne). Jede Kampagne hat ihren eigenen Fortschritt – nichts geht beim Wechseln verloren.') +
        helpItem('mats', 'Zeitreise: Epochen & Erfindungen', 'In der Zeitreise stehen dir nur die Materialien der Epoche zur Verfügung: Baumstamm, Ast, Liane und Felsblock in der Steinzeit, später Bohle, Steinbogen, Hanf, Eisen, Ketten, Winden, Gusseisen, Drahtseil und zuletzt Stahl, Beton und Kabel. Noch nicht erfundene Teile sind ausgegraut und zeigen, ab wann es sie gibt. Stein und Gusseisen tragen Druck, brechen aber bei Zug – darum baut man Bögen.') +
        helpItem('erase', 'Geteiltes Gelenk', 'Mit „Teilen“ trennst du Balken an einem Gelenk: Sie bleiben am selben Punkt, sind aber nicht verbunden – wichtig für Klappbrücken.') +
        helpItem('pinch', 'Bauzonen & Vorgebautes', 'Gebaut werden darf nur in den blauen Zonen. Graue Teile stehen schon im Level – gestreifte Balken sind feste Hindernisse.') +
        '</div><p class="help-foot">Ziel: Bring alle Fahrzeuge sicher zur Zielflagge – und bleib im Budget. Je günstiger die Brücke, desto mehr Sterne!</p>' + lvl +
        materialTablesHtml(),
      buttons: [{ label: firstTime ? "Los geht's" : 'Verstanden', kind: 'green' }],
      onClose: () => { if (!getSetting('helpSeen')) setSetting('helpSeen', true); },
    });
  }
  function showEditorHelp() {
    openModal({
      cls: 'wide', title: 'Level-Editor',
      html: '<div class="help-grid">' +
        '<div class="help-item">' + icon('terrain') + '<div><b>Gelände</b><span>Ziehe die runden Geländepunkte. Tippe auf die Bodenlinie, um einen neuen Punkt einzufügen.</span></div></div>' +
        '<div class="help-item">' + icon('anchor') + '<div><b>Anker</b><span>Tippe auf einen Gitterpunkt, um einen Anker zu setzen oder wieder zu entfernen.</span></div></div>' +
        '<div class="help-item">' + icon('point-x') + '<div><b>Punkt löschen</b><span>Tippe auf einen Anker oder Geländepunkt, um ihn zu löschen.</span></div></div>' +
        '<div class="help-item">' + icon('sandbox') + '<div><b>Grundform</b><span>Spannweite, Höhe, Wasser und Felsen erzeugen eine neue Grundform. Danach kannst du sie anpassen.</span></div></div>' +
        '</div><p class="help-foot">Mit „Testen“ probierst du dein Level sofort aus. Gespeicherte Level findest du unter „Eigene Level“.</p>',
      buttons: [{ label: 'Verstanden', kind: 'green' }],
    });
  }

  // ===========================================================================
  // Mute / settings application
  // ===========================================================================
  function isMuted() { return !!getSetting('muted'); }
  function applyMute() {
    const m = isMuted();
    try {
      if (BB.Audio) {
        if (BB.Audio.setVolume) BB.Audio.setVolume(getSetting('volume'));
        if (BB.Audio.setEffects) BB.Audio.setEffects(getSetting('sfx') !== false);
        if (BB.Audio.setMusic) BB.Audio.setMusic(!!getSetting('music'));
        if (BB.Audio.setMuted) BB.Audio.setMuted(m);
      }
    } catch (e) { warn('Audio.setMuted', e); }
    $$('.mute-btn').forEach((b) => {
      const u = b.querySelector('use');
      if (u) u.setAttribute('href', m ? '#i-sound-off' : '#i-sound-on');
      b.setAttribute('aria-pressed', String(m));
      b.title = m ? 'Ton einschalten' : 'Ton ausschalten';
    });
    const s = $('#set-sound');
    if (s) s.setAttribute('aria-checked', String(m));
  }
  function toggleMute() { setSetting('muted', !isMuted()); applyMute(); if (!isMuted()) sound('click'); }

  // ===========================================================================
  // Main menu (with a decorative running level in the background)
  // ===========================================================================
  const Menu = { idx: 0, level: null, bridge: null, sim: null, acc: 0, endT: 0 };

  function menuNextScene() {
    const candidates = LEVELS().filter((l) => l && l.solution && Array.isArray(l.solution.beams) && l.solution.beams.length).slice(0, 5);
    let lv = null;
    if (candidates.length) { lv = candidates[Menu.idx % candidates.length]; Menu.idx++; }
    else lv = generateLevel(Object.assign({}, SANDBOX_DEFAULT, { budget: null, name: 'Sandkasten', id: 'sandbox' }));
    Menu.level = lv;
    Menu.bridge = lv && lv.solution ? bridgeClone(lv.solution) : { beams: [] };
    Menu.sim = null; Menu.acc = 0; Menu.endT = 0;
    if (lv && lv.solution && hasPhysics()) {
      try { Menu.sim = BB.Physics.createSim(lv, bridgeClone(lv.solution)); } catch (e) { warn('Menü-Simulation', e); Menu.sim = null; }
    }
    if (lv && view === 'menu') fitView(false);
  }
  function updateMenu(dt) {
    const s = Menu.sim;
    if (!s) return;
    try { Menu.acc = stepSimulation(s, Menu.acc, dt, 1, false); } catch (e) { warn('Menü-Simulation', e); Menu.sim = null; return; }
    if (s.status === 'failed') Menu.sim = null;          // never show a collapse on the title screen
    else if (s.status === 'won') { Menu.endT += dt; if (Menu.endT > 2.5) menuNextScene(); }
  }
  screenHooks.menu = {
    show() {
      setViewKind('scene', true);
      setView('menu');
      if (!Menu.level || !Menu.sim) menuNextScene(); else fitView(false);
      $('#m-backup').hidden = sv('backupDue') !== true;
      applyMute();
      updateCampaignUi();
      updateContinue();
    },
  };
  /** Next level to play: the last opened one if it is still open, else the first unfinished level of an open world. */
  function continueTarget() {
    const all = LEVELS();
    const worlds = WORLDS().slice().sort((a, b) => a.unlockStars - b.unlockStars || a.mx - b.mx);
    const order = [];
    worlds.forEach((w) => { if (worldUnlocked(w.id)) levelsOfWorld(w.id).forEach((e) => order.push(e.i)); });
    if (!order.length) return -1;
    const lastId = campaignLast() || (isZeit() ? null : getSetting('lastLevel'));
    const lastIdx = lastId ? all.findIndex((l) => l.id === lastId) : -1;
    if (lastIdx >= 0 && order.indexOf(lastIdx) >= 0 && !sv('isCompleted', all[lastIdx].id)) return lastIdx;
    const start = lastIdx >= 0 && order.indexOf(lastIdx) >= 0 ? order.indexOf(lastIdx) + 1 : 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[(start + k) % order.length];
      if (!sv('isCompleted', all[i].id)) return i;
    }
    return -1;
  }
  function updateContinue() {
    const sub = $('#m-play-sub');
    if (!sub) return;
    const i = continueTarget();
    if (i < 0) { sub.textContent = LEVELS().length ? 'Alle offenen Level geschafft' : 'Noch keine Level'; return; }
    const lv = LEVELS()[i], w = worldGet(worldOfLevel(lv));
    const n = levelsOfWorld(worldOfLevel(lv)).findIndex((e) => e.i === i) + 1;
    sub.textContent = (w ? w.name + ' · ' : '') + 'Level ' + n + ' – ' + lv.name;
  }
  function doBackup(after) {
    Promise.resolve(sv('exportFile')).then((r) => {
      if (r && r.ok) toast('Spielstand gesichert', 'ok');
      else if (r && r.cancelled) toast('Sicherung abgebrochen');
      else toast('Sicherung fehlgeschlagen', 'warn');
      if (after) after(r);
    }, (e) => { warn('exportFile', e); toast('Sicherung fehlgeschlagen', 'warn'); if (after) after(null); });
  }

  // ===========================================================================
  // World map + level selection. Worlds open with stars (total stars of all worlds), in any order;
  // inside an open world every level can be played.
  // ===========================================================================
  let gridToken = null;
  let currentWorld = null;
  function getStarsFn() { return (id) => sv('getStars', id); }
  function worldOfLevel(lv) { return (lv && lv.world) || (WORLDS()[0] ? WORLDS()[0].id : null); }
  function worldUnlockedReal(worldId) { const ws = WORLDS(), i = ws.findIndex((w) => w.id === worldId); return i <= 0 || totalStarsAll() >= ws[i].unlockStars; }
  /** Tester mode only opens the doors – it never writes anything into the real progress. */
  function worldUnlocked(worldId) { return testerOn() || worldUnlockedReal(worldId); }
  function bestCostOf(id) { const st = saveState(); const v = st && st.progress && st.progress.bestCost && st.progress.bestCost[id]; return typeof v === 'number' ? v : null; }
  function levelsOfWorld(wid) { return LEVELS().map((lv, i) => ({ lv, i })).filter((e) => worldOfLevel(e.lv) === wid); }
  function starsOfLevel(lv) { return sv('isCompleted', lv.id) ? clamp(sv('getStars', lv.id) | 0, 0, 3) : 0; }
  function worldStarsOf(wid) { return levelsOfWorld(wid).reduce((n, e) => n + starsOfLevel(e.lv), 0); }
  function totalStarsAll() { return LEVELS().reduce((n, lv) => n + starsOfLevel(lv), 0); }
  function unlockedWorldIds() { return WORLDS().filter((w) => worldUnlocked(w.id)).map((w) => w.id); }

  /** Small line drawing for a world station (inline SVG, 160 × 90): ground, one landmark, one accent. */
  function worldArt(theme) {
    const L = '#cfe6ff', A = '#ffc247';
    const ground = (d) => '<path d="' + d + '" fill="rgba(120,175,235,0.16)" stroke="' + L + '" stroke-width="1.6" stroke-linejoin="round"/>';
    const line = (d, c, w) => '<path d="' + d + '" fill="none" stroke="' + (c || L) + '" stroke-width="' + (w || 1.6) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    const circ = (x, y, r, c, fill) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + (fill || 'none') + '" stroke="' + (c || L) + '" stroke-width="1.6"/>';
    const pine = (x, y, h) => line('M' + x + ' ' + y + 'l-' + h * 0.38 + ' ' + h + 'h' + h * 0.76 + 'zM' + x + ' ' + (y + h) + 'v5');
    const round = (x, y, r) => circ(x, y, r) + line('M' + x + ' ' + (y + r) + 'v8');
    const arch = (x0, x1, y) => line('M' + x0 + ' ' + y + 'Q' + (x0 + x1) / 2 + ' ' + (y - 20) + ' ' + x1 + ' ' + y + 'M' + x0 + ' ' + y + 'H' + x1, A, 1.8);
    let body = '';
    switch (theme) {
      case 'green': body = ground('M0 62Q30 54 52 62V90H0zM108 62Q132 54 160 60V90H108z') + arch(52, 108, 62) + round(24, 46, 7) + round(134, 44, 8) + line('M52 76q28 5 56 0', L, 1.2); break;
      case 'desert': body = ground('M0 64Q26 56 50 64V90H0zM110 64Q134 58 160 64V90H110z') + arch(50, 110, 64) + circ(128, 24, 9, A) + line('M28 62V40M22 50h6v-8M34 54h-6v-10'); break;
      case 'autumn': body = ground('M0 64H52V90H0zM108 64H160V90H108z') + arch(52, 108, 64) + pine(22, 38, 22) + pine(40, 44, 16) + pine(132, 40, 20) + pine(148, 46, 14); break;
      case 'harbor': body = ground('M0 62H46V90H0zM114 62H160V90H114z') + arch(46, 114, 62) + line('M0 78q10-4 20 0t20 0t20 0t20 0t20 0t20 0t20 0t20 0', L, 1.2) + line('M18 62V28h18M18 34h22', L) + line('M24 28v10', A); break;
      case 'winter': body = ground('M0 66L22 40l16 16 18-22 14 32V90H0zM104 66l16-30 14 22 10-12 16 24V90h-56z') + arch(70, 104, 66) + line('M14 20h.1M60 14h.1M96 24h.1M132 14h.1M148 28h.1', A, 2.6); break;
      case 'candy': body = ground('M0 64Q30 56 54 64V90H0zM106 64Q132 58 160 64V90H106z') + arch(54, 106, 64) + line('M30 62V42', L) + circ(30, 36, 8, A) + line('M134 62V44') + circ(134, 38, 7); break;
      case 'yard': body = ground('M0 66H160V90H0z') + line('M12 66V40h28v26M20 48h6M30 48h6') + line('M64 66V22h24M64 28h30', L) + line('M88 22v14', A) + line('M110 66v-14h14v14M126 66v-10h12v10') + arch(46, 100, 66); break;
      case 'volcano': body = ground('M0 66H34L62 28h22l32 38H160V90H0z') + line('M62 28l4 8h12l4-8', A) + line('M70 20q-4-8 2-12M80 22q4-8-1-14') + line('M0 80h160', A, 1.2); break;
      case 'rail': body = ground('M0 66H160V90H0z') + line('M0 72H160M0 78H160') + line('M14 66l-4 20M44 66l-4 20M74 66l-4 20M104 66l-4 20M134 66l-4 20', L, 1.1) + line('M34 62V44h60q8 0 12 8v10', L) + line('M44 48h12v8H44zM62 48h12v8H62z', A, 1.2) + circ(46, 62, 3.4) + circ(90, 62, 3.4); break;
      case 'sky': body = line('M16 32q4-8 14-6q4-8 14-4q10 0 10 10H16z') + line('M96 22q4-8 14-6q4-8 14-4q10 0 10 10H96z') + ground('M46 74Q80 66 114 74V90H46z') + arch(46, 114, 74) + line('M80 54V40', A) + circ(80, 36, 4, A); break;
      case 'tropic': body = ground('M0 66Q24 60 46 66V90H0zM114 66Q138 60 160 66V90H114z') + arch(46, 114, 66) + circ(132, 22, 8, A) + line('M20 64q2-18 6-24') + line('M26 40q-12-8-18 0M26 40q8-10 20-4M26 40q-6-12 6-16'); break;
      case 'city': body = ground('M0 66H160V90H0z') + line('M0 74H160', L, 1.2) + line('M10 74h8M34 74h8M58 74h8M82 74h8M106 74h8M130 74h8', A, 1.4) + line('M10 66V50h18v16M32 66V38h14v28M118 66V44h20v22M142 66V54h14v12') + line('M50 56Q80 36 112 56M50 56H112', A, 1.8) + line('M16 56h4M16 60h4M38 46h4M38 52h4M124 50h4M124 56h4'); break;
      case 'stone': body = ground('M0 66Q30 60 52 66V90H0zM108 66Q132 60 160 66V90H108z') + line('M46 60H114M44 54H116M48 48H112', '#d9b27a', 5) + line('M18 64q2-18 6-24M24 40q-10-6-14 0M24 40q8-8 16-2', L) + circ(134, 22, 8, A); break;
      case 'antique': body = ground('M0 70H160V90H0z') + line('M20 70V44Q44 20 68 44V70M20 70H68M24 44H64', A, 2) + line('M92 70V52H132V70M96 52V40M104 52V40M112 52V40M120 52V40M128 52V40M90 40H134', L, 1.8) + line('M0 76q10-4 20 0t20 0t20 0t20 0t20 0t20 0t20 0t20 0', L, 1.2); break;
      case 'medieval': body = ground('M0 68H160V90H0z') + line('M26 68V36H34V44H42V36H50V44H58V36H66V68M40 68V52H52V68', L, 2) + line('M84 68V22L112 46', A, 2) + line('M84 68H132M132 68V60', L, 1.6) + line('M0 76q10-4 20 0t20 0t20 0t20 0t20 0t20 0t20 0t20 0', L, 1.2); break;
      case 'industry': body = ground('M0 70H160V90H0z') + line('M14 70V40H46V70M22 40V22H32V40', L, 2) + '<path d="M28 18q-6-8 2-14q-4-6 4-10" fill="none" stroke="rgba(207,230,255,0.6)" stroke-width="2.2" stroke-linecap="round"/>' + line('M70 70H156M70 76H156', L, 1.2) + line('M82 66h14v-10h16v10h18', A, 2) + circ(88, 68, 3.2) + circ(104, 68, 3.2) + circ(122, 68, 3.2); break;
      case 'modern': body = ground('M0 70Q30 62 52 70V90H0zM108 70Q132 62 160 70V90H108z') + line('M52 70H108M60 70L80 36L100 70M80 36V70M80 36L52 70M80 36L108 70', A, 2) + circ(80, 34, 3.6, A, '#071a35'); break;
      case 'night': body = ground('M0 68H160V90H0z') + circ(126, 24, 9, A) + line('M20 20h.1M54 14h.1M86 26h.1M100 12h.1M40 34h.1', L, 2.6) + line('M14 68V46h22v22M46 68V34h12v34M70 68V50h26v18') + line('M20 52h4M28 52h4M76 56h4M86 56h4', A, 1.6); break;
      default: body = ground('M0 64Q40 54 80 62T160 62V90H0z');
    }
    return '<svg class="wnode-svg" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + body + '</svg>';
  }

  function renderWorldMap() {
    const map = $('#world-map');
    map.innerHTML = '';
    const zeit = isZeit();
    map.classList.toggle('timeline', zeit);
    updateCampaignUi();
    $('#worlds-hint').textContent = zeit ? 'Reise durch die Geschichte des Brückenbaus. Sammle Sterne, um die nächste Epoche zu öffnen.' : 'Sammle Sterne, um neue Welten zu öffnen. Du darfst die Welten in beliebiger Reihenfolge besuchen.';
    const worlds = WORLDS();
    const total = totalStarsAll(), max = LEVELS().length * 3;
    $('#worlds-stars').textContent = total + ' / ' + max;
    // paths between the worlds, in the recommended order (just a hint – the order is free)
    const sorted = worlds.slice().sort((x, y) => x.unlockStars - y.unlockStars || x.mx - y.mx);
    let d = '';
    sorted.forEach((w, i) => { d += (i ? ' L' : 'M') + w.mx + ' ' + (w.my / 2); });
    const svg = '<svg class="world-paths" viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" /></svg>';
    if (!zeit) map.insertAdjacentHTML('beforeend', svg);
    worlds.forEach((w) => {
      const lvls = levelsOfWorld(w.id);
      const soon = !lvls.length;
      if (soon && !zeit) return;
      const unlocked = !soon && worldUnlocked(w.id), ws = worldStarsOf(w.id), wmax = lvls.length * 3;
      const done = !soon && ws >= wmax;
      const node = el('button', 'wnode theme-' + w.theme + (unlocked ? ' open' : ' locked') + (done ? ' perfect' : '') + (soon ? ' soon' : ''));
      node.type = 'button';
      node.style.setProperty('--mx', w.mx + '%'); node.style.setProperty('--my', w.my + '%');
      const missing = Math.max(0, w.unlockStars - total);
      const period = zeit && w.period ? '<span class="wnode-period">' + esc(w.period) + '</span>' : '';
      node.innerHTML = '<span class="wnode-art">' + worldArt(w.theme) + (unlocked || soon ? '' : '<span class="wnode-lock">' + icon('lock') + '<b>' + w.unlockStars + '</b></span>') + '</span>' +
        '<span class="wnode-name">' + esc(w.name) + '</span><span class="wnode-sub">' + esc(w.subtitle || '') + '</span>' + period +
        (soon ? '<span class="wnode-need">' + icon('time') + ' bald verfügbar</span>'
          : unlocked
            ? '<span class="wnode-marks">' + lvls.map((e) => '<i class="s' + starsOfLevel(e.lv) + '"></i>').join('') + '</span><span class="wnode-stars">' + icon('star', 'star-ic') + ' ' + ws + ' / ' + wmax + ' · ' + lvls.length + ' Level</span>'
            : '<span class="wnode-marks">' + lvls.map(() => '<i class="off"></i>').join('') + '</span><span class="wnode-need">' + icon('lock') + ' Noch ' + missing + (missing === 1 ? ' Stern' : ' Sterne') + '</span>');
      node.setAttribute('aria-label', w.name + (soon ? ' (bald verfügbar)' : unlocked ? '' : ' (gesperrt, noch ' + missing + ' Sterne)'));
      node.addEventListener('click', () => {
        if (soon) { sound('error'); toast(w.name + ' kommt bald.', 'info'); return; }
        if (!unlocked) { sound('error'); toast(w.name + ' öffnet bei ' + w.unlockStars + ' Sternen – dir fehlen noch ' + missing + '.', 'warn'); return; }
        currentWorld = w.id; showScreen('levels');
      });
      map.appendChild(node);
    });
  }
  screenHooks.worlds = { show() { setView('none'); renderWorldMap(); } };

  const LEVEL_BADGES = [
    ['wind', 'wind', 'Wind'], ['ice', 'ice', 'Glatteis'], ['ships', 'ship', 'Schiff'], ['gates', 'ship', 'Durchfahrt'], ['pistons', 'hydraulic', 'Hydraulik'], ['checkpoints', 'checkpoint', 'Kontrollpunkt'],
    ['cargo', 'crate', 'Fracht'], ['routes', 'flag', 'Mehrere Ziele'], ['zones', 'zone', 'Bauzonen'], ['prebuilt', 'prebuilt', 'Vorgebautes'],
  ];
  function levelBadges(lv) {
    let h = '';
    LEVEL_BADGES.forEach((b) => { if (lv[b[0]] && (!Array.isArray(lv[b[0]]) || lv[b[0]].length) && (lv[b[0]] !== true || true)) h += '<span class="lvl-badge" title="' + b[2] + '">' + icon(b[1]) + '</span>'; });
    if ((lv.materials || []).some(isHydKey) && !lv.pistons) h += '<span class="lvl-badge" title="Hydraulik">' + icon('hydraulic') + '</span>';
    return h;
  }

  // ===========================================================================
  // Campaign choice screen + menu labels + epoch introduction
  // ===========================================================================
  /** small line drawings for the two campaign cards (inline SVG, 320 × 140) */
  function campArt(kind) {
    const L = '#cfe6ff', A = '#ffc247', B = '#e8b24a';
    const p = (d, c, w, f) => '<path d="' + d + '" fill="' + (f || 'none') + '" stroke="' + c + '" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    const c = (x, y, r, col, f) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + (f || 'none') + '" stroke="' + col + '" stroke-width="2"/>';
    if (kind === 'classic') {
      return '<svg viewBox="0 0 320 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
        '<rect width="320" height="140" fill="#0b2447"/>' +
        p('M0 20H320M0 50H320M0 80H320M0 110H320M40 0V140M80 0V140M120 0V140M160 0V140M200 0V140M240 0V140M280 0V140', 'rgba(160,205,255,0.07)', 1) +
        p('M0 92H78V108L70 140M320 92H242V108L250 140', L, 2.6, 'rgba(120,175,235,0.18)') +
        '<rect x="62" y="84" width="196" height="8" fill="' + A + '"/>' +
        p('M80 90L120 46H200L240 90M120 46V90M160 46V90M200 46V90M120 46L160 90M200 46L160 90', L, 2.4) +
        c(120, 46, 4.5, L, '#0b2447') + c(160, 46, 4.5, L, '#0b2447') + c(200, 46, 4.5, L, '#0b2447') + c(120, 90, 4, L, '#0b2447') + c(160, 90, 4, L, '#0b2447') + c(200, 90, 4, L, '#0b2447') +
        p('M78 128H242M78 122V134M242 122V134', 'rgba(223,240,255,0.4)', 1.5) +
        '</svg>';
    }
    // Zeitreise: a timeline with a symbol for every epoch
    const xs = [32, 96, 160, 224, 288];
    let s = '<svg viewBox="0 0 320 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="320" height="140" fill="#3a2a14"/>';
    s += p('M14 96H306', B, 3) + xs.map((x) => p('M' + x + ' 90V102', B, 2.4)).join('');
    s += p('M18 74H46M18 66H46M18 58H46', '#d9b27a', 5);                // logs (Steinzeit)
    s += p('M72 96V80Q96 52 120 80V96M72 96H120', L, 2.6) + p('M78 80H114', L, 2);        // arch (Antike)
    s += p('M138 96V64H146V72H152V64H160V72H166V64H174V96M150 96V82H162V96', L, 2.4);       // tower (Mittelalter)
    s += p('M212 96V70H236V96M218 70V48H228V70', L, 2.4) + '<path d="M223 44q-6-8 2-14q-4-8 4-12" fill="none" stroke="rgba(207,230,255,0.55)" stroke-width="2.2" stroke-linecap="round"/>';   // factory + smoke (Industrie)
    s += p('M262 96L276 68H302L316 96M276 68V96M289 68V96M302 68V96M276 68L289 96M302 68L289 96', A, 2.2);        // truss (Moderne)
    s += xs.map((x, i) => '<circle cx="' + x + '" cy="96" r="4.5" fill="' + (i === 4 ? A : '#3a2a14') + '" stroke="' + B + '" stroke-width="2"/>').join('');
    s += '</svg>';
    return s;
  }
  function renderCampaignScreen() {
    const grid = $('#camp-grid');
    grid.innerHTML = '';
    const cd = campaignData(), chosen = cd.chosen === true;
    $('#camp-back').hidden = !chosen;
    $('#camp-head-note').textContent = chosen ? '' : 'Erste Auswahl';
    const classic = campStats('classic'), zeit = campStats('zeit');
    const zeitAvail = !!(BB.TIME && BB.TIME.availableEpochs().length);
    const cards = [
      { id: 'classic', title: 'Klassisch', line: 'Die bekannte Kampagne: Schluchten, Flüsse, Autobahnen, Hubbrücken und Züge in ' + classic.epochs + ' Welten – mit Wochen-Challenge und Editor.', st: classic, current: 'Welt', avail: true },
      { id: 'zeit', title: 'Zeitreise', line: 'Von Baumstämmen bis zur Hubbrücke: Reise durch die Geschichte des Brückenbaus. Jede Epoche hat eigene Materialien, Fahrzeuge und ein eigenes Aussehen.', st: zeit, current: 'Epoche', avail: zeitAvail },
    ];
    cards.forEach((cd2) => {
      const active = CAMP.id === cd2.id && chosen;
      const b = el('button', 'camp-card ' + cd2.id + (active ? ' active' : '') + (cd2.avail ? '' : ' locked'));
      b.type = 'button';
      b.setAttribute('data-camp', cd2.id);
      const st = cd2.st;
      let meta = '<span>' + icon('star', 'star-ic') + ' ' + st.stars + ' / ' + st.max + '</span>';
      if (cd2.id === 'zeit') meta += '<span class="camp-chip' + (st.epochs === 5 ? ' on' : '') + '">' + (st.epochs ? st.epochs + ' von 5 Epochen verfügbar' : 'bald verfügbar') + '</span>';
      else meta += '<span class="camp-chip on">' + st.levels + ' Level</span>';
      if (cd2.avail && st.current) meta += '<span class="camp-chip">' + cd2.current + ': ' + esc(st.current) + '</span>';
      b.innerHTML = (active ? '<span class="camp-badge">aktiv</span>' : '') + '<span class="camp-art">' + campArt(cd2.id) + '</span>' +
        '<span class="camp-title">' + cd2.title + '</span><span class="camp-line">' + esc(cd2.line) + '</span>' +
        '<span class="camp-meta">' + meta + '</span>' +
        '<span class="camp-go">' + icon(cd2.avail ? 'play' : 'lock') + '<span>' + (cd2.avail ? (active ? 'Weiter in dieser Kampagne' : 'Diese Kampagne spielen') : 'Bald verfügbar') + '</span></span>';
      b.addEventListener('click', () => { if (!cd2.avail) { sound('error'); toast('Die Zeitreise ist noch nicht freigeschaltet – sie kommt bald.', 'info'); return; } sound('click'); switchCampaign(cd2.id, true); });
      grid.appendChild(b);
    });
  }
  screenHooks.campaign = { show() { setView('none'); renderCampaignScreen(); } };
  function updateCampaignUi() {
    const z = isZeit();
    const pill = $('#m-camp-pill');
    if (pill) { pill.classList.toggle('zeit', z); $('#m-camp-name').textContent = z ? 'Zeitreise' : 'Klassisch'; }
    const lab = $('#m-worlds-label'); if (lab) lab.textContent = z ? 'Zeitstrahl' : 'Weltkarte';
    const back = $('#screen-levels .btn-back span'); if (back) back.textContent = z ? 'Zeitstrahl' : 'Weltkarte';
    const h = $('#screen-worlds h1'); if (h) h.textContent = z ? 'Zeitstrahl' : 'Weltkarte';
  }
  /** the story card of an epoch: text and what is new (materials with colour and hint, vehicles, ships) */
  function openEpochIntro(w, after) {
    if (!w || !BB.TIME) { if (after) after(); return; }
    sv('markEpochSeen', w.id);
    const node = el('div', 'epoch-intro');
    node.appendChild(el('div', 'ei-period', esc(w.period || '')));
    node.appendChild(el('p', '', esc(w.intro || w.description || '')));
    const inv = BB.TIME.inventions(w.id);
    if (inv.length) {
      node.appendChild(el('div', 'ei-period', 'Neue Erfindungen'));
      const g = el('div', 'ei-inv');
      inv.forEach((k) => {
        const m = k === 'foundation' ? { name: 'Fundament', color: BB.FOUNDATION ? BB.FOUNDATION.color : '#9aa0a8', info: 'ein fester Punkt auf dem Grund – für Pfeiler im Fluss' } : (BB.TIME.MATS[k] || matDef(k) || { name: k });
        const info = m.info || (BB.MATERIAL_INFO && BB.MATERIAL_INFO[k]) || CLASSIC_NOTE[k] || '';
        g.appendChild(el('div', 'ei-item', '<span class="ei-sw" style="--sw:' + esc(m.color || '#888') + '"></span><b>' + esc(m.name) + '</b><span>' + esc(info) + '</span>'));
      });
      node.appendChild(g);
    }
    const veh = Object.keys(BB.TIME.VEHICLES).filter((k) => BB.TIME.VEHICLES[k].epoch === w.id).map((k) => BB.TIME.VEHICLES[k].name);
    const ships = Object.keys(BB.TIME.SHIPS).filter((k) => BB.TIME.SHIPS[k].epoch === w.id).map((k) => BB.TIME.SHIPS[k].name);
    if (veh.length || ships.length) node.appendChild(el('p', '', '<b>Unterwegs:</b> ' + esc(veh.concat(ships).join(', ')) + '.'));
    openModal({ title: 'Du bist ' + (w.inText || ('in der ' + w.name)) + ' angekommen', icon: 'time', node, cls: 'wide', buttons: [{ label: 'Los geht\'s', kind: 'green', icon: 'play', action: () => { if (after) after(); } }], onClose: () => {} });
  }
  const CLASSIC_NOTE = { steelroad: 'befahrbar und viel stärker als Holz', steel: 'sehr fest und steif', concrete: 'senkrechte Pfeiler, enorm druckfest', cable: 'nur auf Zug, extrem stark', spring: 'federt Stöße ab', hydraulic: 'fährt in Phasen aus und ein' };
  function maybeEpochIntro(w) { if (isZeit() && w && !sv('epochSeen', w.id)) setTimeout(() => { if (!modalStack.length) openEpochIntro(w); }, 200); }

  function renderLevelGrid() {
    const grid = $('#level-grid');
    grid.innerHTML = '';
    const worlds = WORLDS();
    let w = worlds.find((x) => x.id === currentWorld);
    if (!w) { w = worlds[0] || { id: null, name: 'Level', description: '' }; currentWorld = w.id; }
    const lvls = w.id ? levelsOfWorld(w.id) : LEVELS().map((lv, i) => ({ lv, i }));
    const token = {};
    gridToken = token;
    updateCampaignUi();
    maybeEpochIntro(w);
    $('#levels-title').textContent = w.name;
    $('#levels-desc').textContent = w.description || '';
    $('#levels-stars').textContent = worldStarsOf(w.id) + ' / ' + lvls.length * 3;
    $('#screen-levels').setAttribute('data-theme', w.theme || 'green');
    const jobs = [];
    lvls.forEach(({ lv, i }, n) => {
      const done = !!sv('isCompleted', lv.id);
      const stars = starsOfLevel(lv);
      const best = done ? bestCostOf(lv.id) : null;
      const card = el('button', 'lvl-card' + (done ? ' done' : ''));
      card.type = 'button';
      card.style.animationDelay = Math.min(n * 25, 400) + 'ms';
      card.setAttribute('aria-label', 'Level ' + (n + 1) + ': ' + lv.name);
      card.innerHTML = '<span class="lvl-num">' + (n + 1) + '</span>' +
        '<span class="lvl-thumb"></span>' +
        '<span class="lvl-badges">' + levelBadges(lv) + '</span>' +
        '<span class="lvl-name">' + esc(lv.name) + '</span>' +
        '<span class="lvl-meta">' + starsHtml(stars) + '<span class="lvl-best">' +
        (best != null ? 'Bestes: ' + fmtEuro(best) : (lv.budget != null ? 'Budget ' + fmtEuro(lv.budget) : '')) + '</span></span>';
      card.addEventListener('click', () => openLevelByIndex(i));
      grid.appendChild(card);
      jobs.push({ box: card.querySelector('.lvl-thumb'), level: lv });
    });
    if (!lvls.length) grid.innerHTML = '<div class="card empty-state">' + icon('warn', 'big-ic') + '<p>In dieser Welt gibt es noch keine Level.</p></div>';
    let k = 0;
    const next = () => {
      if (gridToken !== token || k >= jobs.length) return;
      const j = jobs[k++];
      const r = j.box.getBoundingClientRect();
      const wd = Math.round(r.width || 220), ht = Math.round(r.height || 138);
      const c = thumbFor(j.level, wd, ht);
      if (c) j.box.insertBefore(c, j.box.firstChild);
      setTimeout(next, 0);
    };
    setTimeout(next, 30);
  }
  screenHooks.levels = { show() { setView('none'); renderLevelGrid(); }, hide() { gridToken = null; } };
  function openLevelByIndex(i) {
    const lv = LEVELS()[i];
    if (!lv) return;
    const wid = worldOfLevel(lv);
    currentWorld = wid;
    const list = levelsOfWorld(wid);
    G.worldNum = Math.max(1, list.findIndex((e) => e.i === i) + 1);
    if (!isZeit()) setSetting('lastLevel', lv.id);
    rememberPosition(lv);
    const play = () => openGame(cloneLevel(lv), { kind: 'level', key: lv.id, returnTo: 'levels', index: i });
    const ep = isZeit() ? worldGet(wid) : null;
    if (ep && !sv('epochSeen', ep.id)) openEpochIntro(ep, play); else play();
  }

  // ===========================================================================
  // Weekly challenge – one level per calendar week, made offline from the date (BB.Weekly):
  // everybody gets the same level in the same week; its sample solution is checked automatically.
  // ===========================================================================
  function hashString(s) {
    let h = 2166136261 | 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 16;
    return h >>> 0;
  }
  function currentWeekKey() { try { return BB.Weekly.weekKey(new Date()); } catch (e) { warn('Weekly.weekKey', e); return isoDate(); } }
  function openWeeklyChallenge() {
    const wk = currentWeekKey();
    let L = null;
    try { L = BB.Weekly && BB.Weekly.POOL.length ? BB.Weekly.build(wk) : null; } catch (e) { warn('Weekly.build', e); }
    if (!L) { infoModal('Wöchentliche Herausforderung', 'Die Aufgabe dieser Woche konnte nicht erzeugt werden. Bitte lade die Seite neu.', 'fail'); return; }
    const rec = sv('getWeekly', wk);
    const open = () => openGame(L, { kind: 'weekly', key: 'weekly:' + wk, returnTo: 'menu', index: -1 });
    if (rec && rec.completed) {
      openModal({
        title: 'Diese Woche schon geschafft!', icon: 'star', cls: 'win',
        html: '<p>Du hast die Herausforderung dieser Woche mit ' + rec.stars + ' ' + (rec.stars === 1 ? 'Stern' : 'Sternen') +
          (rec.bestCost ? ' geschafft (' + fmtEuro(rec.bestCost) + ')' : ' geschafft') + '.</p><p class="muted-text">Nächste Woche kommt eine neue Aufgabe!</p>',
        buttons: [
          { label: 'Trotzdem nochmal bauen', kind: 'white', action: open },
          { label: 'Zurück', kind: 'blue' },
        ],
      });
      return;
    }
    open();
  }

  // ===========================================================================
  // Game (build & test)
  // ===========================================================================
  const G = {
    level: null, kind: 'level', key: null, returnTo: 'levels', index: -1,
    ed: null, mode: 'build', sim: null, simAcc: 0, speed: 1, showStress: true,
    endT: null, resultShown: false, resultModal: null,
    hoverNode: null, deleteHighlight: null, progressText: '',
    paused: false, chase: false, runLen: null, review: false, hoverFoundation: null, seeking: false,
    snapGrid: true, quickOn: false, quick: null, quickJob: null, quickWait: 0, trace: null, paste: null, moveGhost: null, fill: false, hudOff: false, spaceHeld: false, spaceUsed: false,
  };

  function openGame(level, opts) {
    closeAllModals();
    if (!BB.Editor || !level) { infoModal('Level kann nicht geöffnet werden', 'Ein Teil des Spiels fehlt. Bitte lade die Seite neu.', 'fail'); return; }
    G.level = level;
    G.kind = opts.kind; G.key = opts.key; G.returnTo = opts.returnTo;
    G.index = opts.index != null ? opts.index : -1;
    G.mode = 'build'; G.sim = null; G.endT = null; G.resultShown = false; G.resultModal = null; G.speed = 1;
    G.hoverNode = null; G.deleteHighlight = null; G.hoverFoundation = null; G.paused = false; G.chase = false; G.runLen = null; G.review = false;
    const saved = G.kind === 'lab' ? (opts.bridge || null) : sv('getBridge', G.key);
    let bridge = { beams: [] }, removed = 0;
    if (saved && Array.isArray(saved.beams)) {
      const s = BB.Editor.sanitize(level, saved);
      bridge = s.bridge; removed = s.removed;
    }
    G.snapGrid = getSetting('snapGrid') !== false; G.trace = null; G.paste = null; G.moveGhost = null; G.quick = null; G.quickJob = null; G.quickWait = 0.3; G.fill = false; G.quickOn = false;
    G.ed = BB.Editor.create(level, bridge, { onChange: onBridgeChange, onSelect: onSelectionChange });
    G.ed.snapGrid = G.snapGrid;
    if (removed && G.kind !== 'lab') { sv('setBridge', G.key, G.ed.bridge); toast(removed === 1 ? '1 ungültiger Balken wurde entfernt' : removed + ' ungültige Balken wurden entfernt', 'warn'); }
    if (!G.ed.allowedMaterials().length) warn('Keine Materialien verfügbar');

    // title
    const num = $('#g-num');
    if (G.kind === 'level') num.textContent = String(G.worldNum || G.index + 1);
    else num.innerHTML = icon(G.kind === 'sandbox' ? 'sandbox' : G.kind === 'weekly' ? 'calendar' : G.kind === 'lab' ? 'lab' : 'edit');
    $('#g-name').textContent = level.name || (G.kind === 'sandbox' ? 'Sandkasten' : 'Level');
    $('#g-back-label').textContent = ({ levels: 'Levels', editor: 'Editor', lab: 'Testlabor' })[G.returnTo] || 'Zurück';
    $('#screen-game').classList.remove('testing');
    if (G.hudOff) toggleHud();
    $('#s-grid').setAttribute('aria-pressed', String(G.snapGrid)); $('#o-fill').setAttribute('aria-pressed', 'false');

    buildMaterialBar();
    updateQuickPill();
    updateCost();
    updateHistoryButtons();
    showScreen('game');
    fitView(false);
    showLevelHint();
    if (!getSetting('helpSeen')) setTimeout(() => { if (view === 'game' && !modalStack.length) showHelp(true); }, 350);
  }
  screenHooks.game = { show() { setView('game'); applyMute(); setViewKind(G.mode === 'test' ? 'scene' : buildViewPref(), true); }, hide() { hideHint(true); } };

  function onBridgeChange(bridge) {
    if (G.kind !== 'lab') sv('setBridge', G.key, bridge);       // test lab results never touch the save game
    updateCost();
    updateHistoryButtons();
    updateToolButtons();
    hideHint();
    quickInvalidate();
  }

  function leaveGame() {
    if (G.mode === 'test') stopTest();
    if (G.ed) G.ed.cancelDrag();
    sv('flush');
    const r = G.returnTo;
    if (r === 'editor' && E.level) showScreen('editor');
    else if (r === 'sandbox') showScreen('sandbox');
    else if (r === 'lab') showScreen('lab');
    else if (r === 'custom') showScreen('custom');
    else if (r === 'menu') showScreen('menu');
    else showScreen('levels');
  }

  const MAT_ICON_HINT = { hydraulic: 'Fährt in den eingestellten Phasen aus oder ein', spring: 'Federt – gibt unter Last nach', cable: 'Sehr stark, aber nur auf Zug', rope: 'Nur auf Zug', concrete: 'Nur senkrecht, braucht festen Boden' };
  // All materials in the order of the keys 1 … 9, 0 (a material the level does not allow stays visible, greyed, with the reason).
  const MAT_KEYS = ['road', 'steelroad', 'wood', 'steel', 'rope', 'cable', 'spring', 'concrete', 'hydraulic', 'rail'];
  function matKeyLabel(i) { return i < 9 ? String(i + 1) : i === 9 ? '0' : ''; }
  function levelHasTrain(L) { return (L.vehicles || []).some((e) => vehKey(e) === 'train'); }
  /** Zeitreise: the materials of the epoch of the level; the new ones of the NEXT epoch stay visible, greyed, with the epoch name. */
  function matBarSpec(L) {
    if (!isZeitLevel(L)) return { keys: MAT_KEYS, future: [], zeit: false };
    const T = BB.TIME, ep = T.get(L.world), idx = T.epochIndex(ep.id), next = T.EPOCHS[idx + 1];
    const keys = T.techFor(ep.id);
    const future = next ? T.inventions(next.id).filter((k) => k !== 'foundation' && keys.indexOf(k) < 0).slice(0, 4) : [];
    return { keys: keys.concat(future), future, zeit: true, epoch: ep };
  }
  /** swatch kind of a material (for the Zeitreise materials that have no class of their own) */
  function swKind(m) { return m.drivable ? 'deck' : m.tensionOnly ? 'rope' : m.vertical ? 'block' : m.hyd ? 'winch' : 'strut'; }
  function buildMaterialBar() {
    const wrap = $('#mat-list');
    wrap.innerHTML = '';
    const allowed = G.ed.allowedMaterials();
    const allowedNames = allowed.map((k) => matDef(k).name).concat(G.ed.foundationAllowed() ? ['Fundament'] : []).join(', ');
    const spec = matBarSpec(G.level);
    G.matKeys = spec.keys;
    wrap.classList.toggle('zeit', spec.zeit);
    spec.keys.forEach((k, i) => {
      const m = matDef(k);
      if (!m) return;
      const future = spec.future.indexOf(k) >= 0;
      const ok = !future && allowed.indexOf(k) >= 0;
      if (!ok && !spec.zeit && k === 'rail' && !levelHasTrain(G.level)) return;      // rails only matter for trains
      const fromEpoch = future ? (BB.TIME.get(BB.TIME.epochOfMaterial(k)) || {}).name : '';
      const b = el('button', 'mat' + (ok ? '' : ' disabled') + (spec.zeit ? ' zeit' : ''));
      b.type = 'button';
      b.setAttribute('data-m', k);
      b.title = m.name + ' (' + matKeyLabel(i) + ')' + (m.info ? ' – ' + m.info : '') + (ok ? '' : future ? ' – erst ab: ' + fromEpoch : ' – in diesem Level nicht erlaubt');
      if (!ok) b.setAttribute('aria-disabled', 'true');
      b.innerHTML = '<span class="mat-sw ' + esc(spec.zeit ? 'sw-' + swKind(m) : k) + '" style="--sw:' + esc((BB.RenderBP && BB.RenderBP.MAT_COLOR && BB.RenderBP.MAT_COLOR[k]) || m.color || '#888') + '"></span>' +
        '<span class="mat-name">' + esc(m.name) + '</span>' +
        (ok ? '<span class="mat-info">' + fmtNum(m.price) + ' €/m · max ' + fmtDec(m.maxLength) + ' m</span>' + (spec.zeit && m.info ? '<span class="mat-note">' + esc(m.info) + '</span>' : '')
          : future ? '<span class="mat-info reason">erst ab</span><span class="mat-info reason">' + esc(fromEpoch) + '</span>'
          : '<span class="mat-info reason">gesperrt</span><span class="mat-info reason">in diesem Level</span>') +
        '<span class="mat-key">' + matKeyLabel(i) + '</span>';
      b.addEventListener('click', () => {
        if (ok) selectMaterial(k);
        else if (future) { sound('error'); toast(m.name + ' wird erst ' + ((BB.TIME.get(BB.TIME.epochOfMaterial(k)) || {}).inText || 'später') + ' erfunden.', 'info'); }
        else { sound('error'); toast(m.name + ' ist in diesem Level nicht erlaubt. Erlaubt sind: ' + allowedNames + '.', 'warn'); }
      });
      wrap.appendChild(b);
    });
    {
      const fOk = G.ed.foundationAllowed();
      const F = BB.FOUNDATION || { name: 'Fundament', price: 1500, color: '#9aa0a8' };
      const b = el('button', 'mat' + (fOk ? '' : ' disabled'));
      b.type = 'button';
      b.setAttribute('data-m', 'foundation');
      const fEarly = !fOk && spec.zeit && BB.TIME.epochIndex(G.level.world) < BB.TIME.epochIndex(BB.TIME.FOUNDATION_FROM);
      b.title = 'Fundament – fester Punkt auf dem Boden (U)' + (fOk ? '' : fEarly ? ' – erst ab ' + BB.TIME.get(BB.TIME.FOUNDATION_FROM).name : ' – in diesem Level nicht erlaubt');
      if (!fOk) b.setAttribute('aria-disabled', 'true');
      b.innerHTML = '<span class="mat-sw found"></span><span class="mat-name">' + esc(F.name) + '</span>' +
        (fOk ? '<span class="mat-info">' + fmtNum(F.price) + ' € je Stück</span><span class="mat-info" id="found-count"></span>'
          : fEarly ? '<span class="mat-info reason">erst ab</span><span class="mat-info reason">' + esc(BB.TIME.get(BB.TIME.FOUNDATION_FROM).name) + '</span>' : '<span class="mat-info reason">gesperrt</span><span class="mat-info reason">in diesem Level</span>') +
        '<span class="mat-key">U</span>';
      b.addEventListener('click', () => {
        if (fOk) selectMaterial('foundation');
        else { sound('error'); toast('Fundamente sind in diesem Level nicht erlaubt. Erlaubt sind: ' + allowedNames + '.', 'warn'); }
      });
      wrap.appendChild(b);
    }
    const hasHyd = G.ed.allowedMaterials().some(isHydKey);
    const splitOk = !!(G.level.splitJoints || G.level.sandbox || G.kind === 'sandbox' || G.kind === 'custom' || G.kind === 'test');
    $('#t-split').hidden = !splitOk;
    $('#t-phasetool').hidden = !hasHyd;
    updateToolButtons();
  }
  function selectMaterial(k) {
    if (!G.ed || G.mode !== 'build') return;
    cancelModes();
    if (k === 'foundation') {
      G.ed.clearSelection();
      G.ed.tool = 'foundation';
      toast('Fundament: Tippe auf den Boden, um es zu setzen. Mit „Löschen“ nimmst du es wieder weg.', 'info');
    } else {
      if (matDef(k)) toast(materialInfo(k) + (MAT_ICON_HINT[k] ? ' – ' + MAT_ICON_HINT[k] : ''), 'info');
      G.ed.material = k;
      if (G.ed.tool !== 'line' && G.ed.tool !== 'arc' && G.ed.tool !== 'select') { G.ed.tool = 'build'; }
      else if (G.ed.tool === 'select') G.ed.tool = 'build';
    }
    G.ed.cancelDrag();
    G.deleteHighlight = null; G.hoverFoundation = null;
    updateToolButtons();
    quickInvalidate();
  }
  /** Leaves unfinished modes: a traced line / arc, a floating paste, a selection box. */
  function cancelModes() {
    G.trace = null; G.paste = null; G.moveGhost = null;
    if (gesture && (gesture.type === 'trace' || gesture.type === 'arcb' || gesture.type === 'paste' || gesture.type === 'box' || gesture.type === 'selmove')) gesture = null;
    updateSelBar();
  }
  function setTool(t) {
    if (!G.ed || G.mode !== 'build') return;
    cancelModes();
    G.ed.tool = G.ed.tool === t && t !== 'build' ? 'build' : t;
    G.ed.cancelDrag();
    if (G.ed.tool !== 'select') G.ed.clearSelection();
    G.hoverNode = null; G.deleteHighlight = null; G.hoverFoundation = null;
    if (G.ed.tool === 'split') toast('Geteiltes Gelenk: Tippe auf ein Gelenk, in dem sich Balken treffen. Ein Tipp am Balkenende trennt diesen Balken ab.', 'info');
    if (G.ed.tool === 'phase') openPhaseEditor();
    if (G.ed.tool === 'select') toast('Auswählen: Ziehe einen Rahmen oder tippe ein Teil an. Auswahl verschieben: ziehen. Kopieren, Drehen, Spiegeln: Leiste unten.', 'info');
    if (G.ed.tool === 'line') toast('Linie: Ziehe von Punkt zu Punkt – die Gelenke werden gleichmäßig verteilt.', 'info');
    if (G.ed.tool === 'arc') toast('Bogen: Ziehe von Start zu Ende, dann ziehe oder tippe die Wölbung.', 'info');
    updateToolButtons();
  }
  function toggleDeleteTool() { setTool('delete'); }
  function updateToolButtons() {
    if (!G.ed) return;
    $$('#mat-list .mat').forEach((b) => {
      const k = b.getAttribute('data-m');
      const on = !b.classList.contains('disabled') && (k === 'foundation' ? G.ed.tool === 'foundation' : (G.ed.tool !== 'foundation' && k === G.ed.material && ['build', 'line', 'arc'].indexOf(G.ed.tool) >= 0));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const fc = $('#found-count');
    if (fc) { const max = BB.Bridge.foundationMax(G.level); fc.textContent = (G.ed.foundationCount()) + ' / ' + (max >= 99 ? '∞' : max); }
    $$('#tool-rail .tool[data-tool]').forEach((d) => {
      const on = G.ed.tool === d.getAttribute('data-tool');
      d.classList.toggle('on', on);
      d.setAttribute('aria-pressed', String(on));
    });
    const to = $('#trace-opts'); if (to) to.hidden = !(G.mode === 'build' && (G.ed.tool === 'line' || G.ed.tool === 'arc'));
    updateSelBar();
  }
  function updateSelBar() {
    const bar = $('#sel-bar'), pb = $('#paste-bar');
    if (!bar || !G.ed) return;
    const n = G.ed.selectionCount(), selTool = G.ed.tool === 'select' && G.mode === 'build';
    bar.hidden = !(selTool || n > 0) || !!G.paste || G.mode !== 'build';
    pb.hidden = !G.paste;
    $('#sel-count').textContent = n ? n + (n === 1 ? ' Teil · ' : ' Teile · ') + fmtEuro(G.ed.selectionCost()) : 'Nichts ausgewählt';
    ['#a-copy', '#a-cut', '#a-rotl', '#a-rotr', '#a-mirh', '#a-mirv', '#a-del'].forEach((id) => { const b = $(id); if (b) b.disabled = !n; });
    const pa = $('#a-paste'); if (pa) pa.disabled = !G.ed.canPaste();
    if (G.paste) $('#paste-text').textContent = 'Einfügen: ' + (G.ed.clipboardInfo() ? G.ed.clipboardInfo().count : 0) + ' Teile';
  }
  function onSelectionChange() { updateSelBar(); }
  /** Result of a selection action: sound + a short reason when it did not fit. */
  function selResult(r, okText) {
    if (r && r.ok) { sound('place'); if (okText) toast(okText, 'info'); updateCost(); }
    else { sound('error'); toast((r && r.reason) || 'Das passt hier nicht.', 'warn'); }
  }
  function selCopy() { const n = G.ed.copy(); if (n) toast(n + (n === 1 ? ' Teil kopiert' : ' Teile kopiert') + ' – Einfügen: Strg+V', 'info'); updateSelBar(); return n; }
  function selCut() { const n = G.ed.cut(); if (n) { sound('delete'); toast(n + (n === 1 ? ' Teil ausgeschnitten' : ' Teile ausgeschnitten'), 'info'); updateCost(); } updateSelBar(); }
  function selDelete() { if (G.ed.deleteSelection()) { sound('delete'); updateCost(); } updateSelBar(); }
  function selRotate(deg) { if (!G.ed.selectionCount()) return; selResult(G.ed.rotateSelection(deg)); }
  function selMirror(axis) { if (!G.ed.selectionCount()) return; selResult(G.ed.mirrorSelection(axis)); }
  function selNudge(dx, dy) { if (!G.ed.selectionCount()) return; selResult(G.ed.moveSelection(dx, dy)); }
  /** Starts the floating paste: the copied parts follow the pointer (mouse) or the finger and are set with "Setzen" / a click. */
  function startPaste() {
    if (!G.ed || G.mode !== 'build') return;
    if (!G.ed.canPaste()) { sound('error'); toast('Nichts zum Einfügen – erst etwas kopieren (Strg+C).', 'warn'); return; }
    const ci = G.ed.clipboardInfo(), c = s2w(cam, canvas.clientWidth / 2, canvas.clientHeight / 2);
    G.ed.cancelDrag(); G.trace = null; G.moveGhost = null;
    G.paste = { ox: Math.round(c[0] - ci.w / 2), oy: Math.round(c[1] - ci.h / 2) };
    if (G.ed.tool !== 'select') G.ed.tool = 'select';
    updateToolButtons();
    toast('Einfügen: Ziehe die Teile an die richtige Stelle (grün = passt) und tippe auf „Setzen“.', 'info');
  }
  function pasteTo(w) {
    if (!G.paste) return;
    const ci = G.ed.clipboardInfo();
    if (!ci) return;
    G.paste.ox = Math.round(w[0] - ci.w / 2); G.paste.oy = Math.round(w[1] - ci.h / 2);
  }
  function commitPaste() {
    if (!G.paste) return;
    const r = G.ed.paste(G.paste.ox, G.paste.oy);
    if (r.ok) { G.paste = null; sound('place'); toast(r.count + (r.count === 1 ? ' Teil eingefügt' : ' Teile eingefügt'), 'info'); updateCost(); updateToolButtons(); }
    else { sound('error'); toast(r.reason || 'Hier passt es nicht.', 'warn'); }
  }
  function cancelPaste() { G.paste = null; updateSelBar(); }
  // --- line / arc tracing ---
  function tracePlan() {
    const t = G.trace;
    if (!t || !G.ed) return null;
    const fill = !!G.fill;
    if (t.kind === 'line' || t.phase === 1) return (t.p1[0] === t.p2[0] && t.p1[1] === t.p2[1]) ? null : G.ed.planLine(t.p1[0], t.p1[1], t.p2[0], t.p2[1], { fill: fill && t.kind === 'line' });
    return G.ed.planArc(t.p1[0], t.p1[1], t.p2[0], t.p2[1], t.b[0], t.b[1], { fill: fill });
  }
  function defaultBulge(t) {
    const mx = (t.p1[0] + t.p2[0]) / 2, my = (t.p1[1] + t.p2[1]) / 2, dx = t.p2[0] - t.p1[0], dy = t.p2[1] - t.p1[1], l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l;
    if (ny < 0) { nx = -nx; ny = -ny; }
    const h = Math.max(2, Math.round(l * 0.3));
    return [Math.round(mx + nx * h), Math.round(my + ny * h)];
  }
  function commitTrace() {
    const plan = tracePlan();
    const t = G.trace;
    G.trace = null;
    if (!plan) return;
    const r = G.ed.commitPlan(plan);
    if (r.ok) { sound('place'); toast(r.count + (r.count === 1 ? ' Balken gesetzt' : ' Balken gesetzt'), 'info'); updateCost(); }
    else { sound('error'); toast(r.reason || 'Hier geht das nicht.', 'warn'); }
    if (t) G.hoverNode = null;
  }
  // --- quick test (stress preview in the build mode) ---
  function quickInvalidate() {
    G.quick = null; G.quickJob = null; G.quickWait = 0.45;
    updateQuickPill();
  }
  function tickQuick(dt) {
    if (!G.quickOn || !G.ed || G.mode !== 'build' || G.quick) return;
    if (!G.ed.bridge.beams.length) return;
    if (gesture && (gesture.type === 'build' || gesture.type === 'trace' || gesture.type === 'selmove')) return;
    if (G.quickWait > 0) { G.quickWait -= dt; return; }
    if (!G.quickJob) {
      try { G.quickJob = BB.Physics.quickTest(G.level, bridgeClone(G.ed.bridge)); } catch (e) { warn('Schnelltest', e); G.quickOn = false; updateQuickPill(); return; }
      updateQuickPill();
    }
    let done = false;
    try { done = G.quickJob.advance(9); } catch (e) { warn('Schnelltest', e); G.quickOn = false; G.quickJob = null; updateQuickPill(); return; }
    if (done) {
      const r = G.quickJob.result;
      G.quick = { stress: r.stress, broken: r.broken, status: r.status, reason: r.reason, max: r.maxStress };
      G.quickJob = null;
      updateQuickPill();
    }
  }
  function updateQuickPill() {
    const pill = $('#quick-pill');
    if (!pill) return;
    const sw = $('#s-stress'); if (sw) sw.setAttribute('aria-pressed', String(!!G.quickOn));
    if (!G.quickOn || G.mode !== 'build' || !G.ed || !G.ed.bridge.beams.length) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.className = 'quick-pill';
    if (!G.quick) { pill.classList.add('busy'); pill.innerHTML = icon('stress') + '<span>Schnelltest läuft …</span>'; return; }
    const q = G.quick, pct = Math.round(q.max * 100);
    if (q.status === 'won') {
      pill.classList.add(q.max > 0.85 ? 'bad' : 'ok');
      pill.innerHTML = icon(q.max > 0.85 ? 'warn' : 'check') + '<span>Schnelltest: hält · Spitzenlast ' + pct + ' %' + (q.max > 0.85 ? ' (zu knapp)' : '') + '</span>';
    } else {
      pill.classList.add('bad');
      pill.innerHTML = icon('warn') + '<span>Schnelltest: ' + esc(resultText(q.reason)) + '</span>';
    }
  }
  function toggleQuick() {
    if (!G.ed || G.mode !== 'build') return;
    G.quickOn = !G.quickOn;
    quickInvalidate();
    toast(G.quickOn ? 'Belastungsvorschau an: Die Farben zeigen die höchste Last jedes Balkens bei einer Probefahrt im Schnelldurchlauf.' : 'Belastungsvorschau aus', 'info');
  }
  function toggleGrid() {
    G.snapGrid = !G.snapGrid;
    setSetting('snapGrid', G.snapGrid);
    if (G.ed) G.ed.snapGrid = G.snapGrid;
    const b = $('#s-grid'); if (b) b.setAttribute('aria-pressed', String(G.snapGrid));
    toast(G.snapGrid ? 'Raster an: Balken rasten an jedem Rasterpunkt ein.' : 'Raster aus: Balken rasten nur an vorhandenen Gelenken und genau getroffenen Rasterpunkten ein.', 'info');
  }
  function toggleHud() {
    G.hudOff = !G.hudOff;
    $('#screen-game').classList.toggle('hud-off', G.hudOff);
    $('#hud-restore').hidden = !G.hudOff;
    if (G.hudOff) toast('Oberfläche ausgeblendet – H oder „Einblenden“ bringt sie zurück.', 'info');
  }
  /** Level info: task, vehicles, budget, allowed materials, star conditions. */
  function showLevelInfo() {
    const L = G.level;
    if (!L) return;
    const node = el('div', 'info-grid');
    const budget = L.budget;
    const t = (BB.Levels && BB.Levels.STAR_THRESHOLDS) || [0.75, 0.9];
    const allowed = G.ed ? G.ed.allowedMaterials() : [];
    const gap = BB.Levels && BB.Levels.gapOf ? BB.Levels.gapOf(L) : 'canyon';
    const GAPN = { water: 'Wasser', road: 'Autobahn', rail: 'Bahnstrecke', canyon: 'Schlucht', ravine: 'Nebelschlucht', lava: 'Lava' };
    let h = '<div><h3>Aufgabe</h3><p>' + esc(L.description || 'Bring alle Fahrzeuge sicher zur Zielflagge!') + '</p>' + (L.intro ? '<p class="muted-text" style="margin-top:6px">' + esc(L.intro) + '</p>' : '') + '</div>';
    h += '<div><h3>Unter der Brücke: ' + esc(GAPN[gap] || '') + '</h3>';
    const gs = BB.Gates ? BB.Gates.of(L) : [];
    if (gs.length) {
      const KN = { ship: 'Schiff', truck: 'LKW', train: 'Zug' };
      h += '<ul>' + gs.map((g) => { const wl = typeof L.water === 'number' ? L.water : g.y0; const clear = Math.round((g.y1 - (g.kind === 'ship' ? wl : g.y0)) * 2) / 2; return '<li>' + KN[g.kind] + ': Durchfahrt ' + String(clear).replace('.', ',') + ' m hoch, ' + String(Math.round((g.x1 - g.x0) * 10) / 10).replace('.', ',') + ' m breit' + (g.openPhase !== null ? ' – die Brücke muss sich öffnen (Phase ' + (g.openPhase + 1) + ')' : '') + '</li>'; }).join('') + '</ul>';
    } else h += '<p>Nichts fährt unter der Brücke durch.</p>';
    h += '</div>';
    h += '<div><h3>Fahrzeuge</h3><p>' + esc(summarizeVehicles(L.vehicles, true) || '–') + '</p></div>';
    h += '<div><h3>Budget</h3><p>' + (budget == null ? 'unbegrenzt' : fmtEuro(budget)) + '</p>';
    if (budget != null) h += '<div class="star-rules"><div>' + icon('star') + icon('star') + icon('star') + '<span>bis ' + fmtEuro(Math.round(budget * t[0])) + ' (' + Math.round(t[0] * 100) + ' %)</span></div><div>' + icon('star') + icon('star') + '<span>bis ' + fmtEuro(Math.round(budget * t[1])) + ' (' + Math.round(t[1] * 100) + ' %)</span></div><div>' + icon('star') + '<span>bis ' + fmtEuro(budget) + '</span></div><div class="muted-text">Über dem Budget kannst du bauen und testen, das Level zählt dann aber nicht.</div></div>';
    h += '</div>';
    const needs = Array.isArray(L.needs) ? L.needs : [];
    const NAMES = { foundation: 'Fundament' };
    h += '<div><h3>Bauteile</h3><div class="info-chips">' + (G.matKeys || MAT_KEYS).filter((k) => !isZeitLevel(L) || (matBarSpec(L).future.indexOf(k) < 0)).concat(['foundation']).map((k) => {
      const ok = k === 'foundation' ? (G.ed && G.ed.foundationAllowed()) : allowed.indexOf(k) >= 0;
      if (!ok && k === 'rail' && !levelHasTrain(L)) return '';
      const nm = k === 'foundation' ? 'Fundament' : matDef(k).name;
      return '<span class="info-chip' + (ok ? '' : ' off') + (needs.indexOf(k) >= 0 ? ' need' : '') + '">' + esc(nm) + (needs.indexOf(k) >= 0 ? ' · nötig' : '') + '</span>';
    }).join('') + '</div></div>';
    if (L.checkpoints && L.checkpoints.length || (L.pistons && L.pistons.length) || allowed.some(isHydKey)) {
      h += '<div><h3>Hydraulik</h3><p>Die Phasen werden von Schiffen oder Fahrzeugen an Kontrollpunkten ausgelöst. Im Phasen-Editor (Werkzeug „Phasen“) stellst du ein, was jeder Kolben in jeder Phase tut.</p></div>';
    }
    node.innerHTML = h;
    openModal({ title: 'Level-Info', icon: 'info', node, buttons: [{ label: 'Schließen', kind: 'green', icon: 'check' }] });
  }
  /** Phase editor: one row per hydraulic beam, one column per phase – tap a cell to cycle hold / out / in. */
  function openPhaseEditor() {
    if (!G.ed) return;
    const beams = G.ed.bridge.beams, idx = [];
    beams.forEach((b, i) => { if (isHydKey(b.m)) idx.push(i); });
    const nPh = Math.max(2, Math.min(BB.HYD_PHASES || 4, Math.max.apply(null, [2].concat(idx.map((i) => (beams[i].ph || []).length)).concat([4]))));
    const node = el('div', 'phase-editor');
    const trig = [];
    const S = G.level;
    (BB.Gates ? BB.Gates.of(S) : []).forEach((g) => {
      const KN = { ship: 'Schiff', truck: 'LKW', train: 'Zug' };
      if (g.openPhase !== null) trig.push('Phase ' + (g.openPhase + 1) + ': beginnt, wenn das ' + KN[g.kind] + ' kommt (Brücke öffnet)');
      if (g.closePhase !== null) trig.push('Phase ' + (g.closePhase + 1) + ': beginnt, wenn das ' + KN[g.kind] + ' durch ist (Brücke schließt)');
    });
    (S.checkpoints || []).forEach((cp, i) => { if (!cp.hidden || true) trig.push('Phase ' + (cp.phase + 1) + ': beginnt, wenn ein Fahrzeug den Kontrollpunkt bei x = ' + cp.x + ' m überfährt'); });
    node.appendChild(el('p', 'help-note', idx.length ? 'Phase 1 gilt beim Start. Tippe auf ein Feld: <b>–</b> halten, <b>↑</b> ausfahren, <b>↓</b> einfahren.' : 'Noch kein Hydraulik-Kolben gebaut. Wähle „Hydraulik“ und ziehe einen Kolben zwischen zwei Gelenke.'));
    if (idx.length) {
      const table = el('div', 'phase-table');
      table.style.setProperty('--np', String(nPh));
      const head = el('div', 'ph-head');
      head.appendChild(el('span', '', 'Kolben'));
      for (let p = 0; p < nPh; p++) head.appendChild(el('span', '', 'Phase ' + (p + 1)));
      table.appendChild(head);
      const work = idx.map((i) => { const cur = (Array.isArray(beams[i].ph) ? beams[i].ph : ['hold', 'out']).slice(); while (cur.length < nPh) cur.push('hold'); return cur; });
      const SYM = { hold: '–', out: '↑', in: '↓' }, NEXT = { hold: 'out', out: 'in', in: 'hold' };
      idx.forEach((bi, r) => {
        const b = beams[bi], row = el('div', 'ph-row');
        row.appendChild(el('span', 'ph-name', 'Kolben ' + (r + 1) + ' · x ' + Math.round((b.x1 + b.x2) / 2)));
        for (let p = 0; p < nPh; p++) {
          const c = el('button', 'ph-cell', SYM[work[r][p]]);
          c.type = 'button'; c.setAttribute('data-a', work[r][p]); c.setAttribute('aria-label', 'Kolben ' + (r + 1) + ', Phase ' + (p + 1));
          c.addEventListener('click', () => { work[r][p] = NEXT[work[r][p]]; c.textContent = SYM[work[r][p]]; c.setAttribute('data-a', work[r][p]); });
          row.appendChild(c);
        }
        table.appendChild(row);
      });
      node.appendChild(table);
      if (trig.length) node.appendChild(el('p', 'ph-trig', '<b>Wann beginnt welche Phase?</b><br>' + trig.map(esc).join('<br>')));
      openModal({
        title: 'Phasen-Editor', icon: 'hydraulic', node,
        buttons: [
          { label: 'Fertig', kind: 'green', icon: 'check', action: () => { G.ed.setPhases(idx.map((bi, r) => { let last = work[r].length; while (last > 2 && work[r][last - 1] === 'hold') last--; return { i: bi, ph: work[r].slice(0, last) }; })); sound('place'); G.ed.tool = 'build'; updateToolButtons(); } },
          { label: 'Abbrechen', kind: 'white', action: () => { G.ed.tool = 'build'; updateToolButtons(); } },
        ],
      });
    } else openModal({ title: 'Phasen-Editor', icon: 'hydraulic', node, buttons: [{ label: 'OK', kind: 'green', icon: 'check', action: () => { G.ed.tool = 'build'; updateToolButtons(); } }] });
  }
  function updateHistoryButtons() {
    if (!G.ed) return;
    $('#t-undo').disabled = !G.ed.canUndo();
    $('#t-redo').disabled = !G.ed.canRedo();
    $('#t-clear').disabled = !G.ed.bridge.beams.length && !G.ed.foundationCount();
  }
  function previewDelta() {
    const p = G.ed && G.ed.preview;
    if (!p || !p.valid) return 0;
    const m = matDef(p.m);
    if (!m) return 0;
    let d = m.price * p.length;
    const beams = G.ed.bridge.beams;
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if ((b.x1 === p.x1 && b.y1 === p.y1 && b.x2 === p.x2 && b.y2 === p.y2) || (b.x1 === p.x2 && b.y1 === p.y2 && b.x2 === p.x1 && b.y2 === p.y1)) {
        const om = matDef(b.m);
        if (om) d -= om.price * p.length;
        break;
      }
    }
    return Math.round(d);
  }
  let lastCostKey = '';
  function updateCost() {
    if (!G.ed || !G.level) return;
    const cost = G.ed.cost(), budget = G.level.budget, delta = G.ed.preview ? previewDelta() : 0;
    const key = cost + '|' + budget + '|' + delta;
    if (key === lastCostKey) return;
    lastCostKey = key;
    $('#g-cost-val').textContent = fmtEuro(cost);
    const pill = $('#g-cost');
    const dEl = $('#g-cost-delta');
    dEl.textContent = delta ? (delta > 0 ? '+' : '') + fmtEuro(delta) : (budget != null && cost > budget ? fmtEuro(cost - budget) + ' über Budget' : '');
    if (budget == null) {
      $('#g-budget').textContent = 'unbegrenzt';
      pill.classList.add('unlimited');
      pill.classList.remove('over', 'warn');
    } else {
      $('#g-budget').textContent = fmtEuro(budget);
      pill.classList.remove('unlimited');
      pill.classList.toggle('over', cost > budget);
      pill.classList.toggle('warn', cost > budget * 0.75 && cost <= budget);
      $('#g-cost-bar i').style.width = clamp(budget > 0 ? cost / budget * 100 : 100, 0, 100) + '%';
      dEl.style.color = cost + delta > budget ? 'var(--red)' : '';
    }
    pill.title = budget == null ? 'Kosten der Brücke (Sandkasten: ohne Budget)' : 'Kosten / Budget – bis 75 % gibt es 3 Sterne, bis 90 % 2 Sterne';
  }

  function showLevelHint() {
    const L = G.level;
    const text = String(L.description || '').trim();
    const veh = summarizeVehicles(L.vehicles, true);
    const h = $('#g-hint');
    $('#g-hint-text').textContent = text || 'Bring alle Fahrzeuge sicher zur Zielflagge!';
    $('#g-hint-intro').textContent = L.intro || '';
    $('#g-hint-sub').textContent = veh ? 'Fahrzeuge: ' + veh : '';
    h.classList.remove('out');
    h.hidden = false;
  }
  function hideHint(immediate) {
    const h = $('#g-hint');
    if (!h || h.hidden) return;
    if (immediate) { h.hidden = true; h.classList.remove('out'); return; }
    if (h.classList.contains('out')) return;
    h.classList.add('out');
    setTimeout(() => { if (h.classList.contains('out')) { h.hidden = true; h.classList.remove('out'); } }, 260);
  }

  function doUndo() { if (G.ed && G.mode === 'build') { endGesture(); if (G.ed.undo()) sound('click'); } }
  function doRedo() { if (G.ed && G.mode === 'build') { endGesture(); if (G.ed.redo()) sound('click'); } }
  function askClear() {
    if (!G.ed || G.mode !== 'build' || !G.ed.bridge.beams.length) return;
    endGesture();
    confirmModal({
      title: 'Alles löschen?', icon: 'trash', cls: 'warn',
      text: 'Alle Balken dieser Brücke werden entfernt. Mit „Rückgängig“ kannst du sie zurückholen.',
      okLabel: 'Alles löschen', okKind: 'red', okIcon: 'trash',
      onOk: () => { if (G.ed.clear()) sound('delete'); },
    });
  }

  // --- test drive -------------------------------------------------------------
  function startTest() {
    if (!G.ed || G.mode !== 'build') return;
    if (!hasPhysics()) { infoModal('Testfahrt nicht möglich', 'Die Physik-Simulation konnte nicht geladen werden. Bitte lade die Seite neu.', 'fail'); return; }
    endGesture();
    G.ed.cancelDrag();
    cancelModes(); G.ed.clearSelection();
    const v = validateBridge(G.level, G.ed.bridge);
    if (!v.ok) {
      sound('error');
      openModal({ title: 'Die Brücke hat Fehler', icon: 'warn', cls: 'warn', html: '<p>Bitte korrigiere zuerst:</p>' + errorsHtml(v.errors), buttons: [{ label: 'OK', kind: 'blue' }] });
      return;
    }
    let sim = null;
    try { sim = BB.Physics.createSim(G.level, bridgeClone(G.ed.bridge)); } catch (e) { warn('Physics.createSim', e); }
    if (!sim) { infoModal('Testfahrt nicht möglich', 'Die Simulation konnte nicht gestartet werden.', 'fail'); return; }
    G.sim = sim; G.simAcc = 0; G.mode = 'test'; G.endT = null; G.resultShown = false; G.speed = 1;
    G.paused = false; G.runLen = null; G.review = false; G.chase = !!getSetting('chaseCam');
    G.showStress = getSetting('showStress') !== false;
    G.hoverNode = null; G.deleteHighlight = null; G.progressText = ''; G.hoverFoundation = null;
    try { if (R && R.clearEffects) R.clearEffects(); } catch (e) { /* ignore */ }
    $('#screen-game').classList.add('testing');
    setViewKind('scene');                       // test drive: scene view (the building view comes back afterwards)
    updateSpeedButtons(); updateStressButton(); updateProgress(); updatePhaseButton(); updatePauseButton(); updateCamButton(); updateScrub(true);
    hideHint();
    sound('start');
  }
  /** Hydraulics HUD button: shown only for levels with more than one phase, shows the current one. */
  function updatePhaseButton() {
    const btn = $('#t-phase'), sim = G.sim;
    const s = sim && sim._s;
    if (!s || !(s.numPhases > 1)) { btn.hidden = true; updateStatusPill(); return; }
    btn.hidden = false;
    const auto = !!((G.level.checkpoints && G.level.checkpoints.length) || (s.gates && s.gates.length));
    btn.classList.toggle('static', auto);                       // phases start by themselves (gates / checkpoints): the chip only shows them
    btn.title = auto ? 'Aktuelle Hydraulik-Phase (wird von Schiffen / Fahrzeugen ausgelöst)' : 'Nächste Phase';
    $('#t-phase-text').textContent = 'Phase ' + (s.phase + 1) + ' / ' + s.numPhases;
    updateStatusPill();
  }
  /** Plain-language line about the gates: who is coming, whether the bridge is open, who is waiting. */
  function gateStatusText(sim) {
    const S = sim && sim._s;
    if (!S || !S.gates || !S.gates.length) return '';
    const t = sim.t, KN = { ship: 'Schiff', truck: 'LKW', train: 'Zug' };
    for (const g of S.gates) if (g.state === 'blocked') return KN[g.kind] + ' blockiert – die Brücke ragt in die Durchfahrt!';
    for (const g of S.gates) if (g.state === 'passing') return KN[g.kind] + ' fährt unter der Brücke durch';
    let next = null;
    for (const g of S.gates) if (g.state === 'idle' && (!next || g.t < next.t)) next = g;
    if (next && t >= next.t - next.lead) return KN[next.kind] + ' nähert sich' + (S.holdActive ? ' · Fahrzeuge warten' : '');
    if (S.holdActive) return 'Fahrzeuge warten' + (next ? ' · ' + KN[next.kind] + ' kommt gleich' : ' · Brücke bewegt sich');
    return '';
  }
  function updateStatusPill() {
    const pill = $('#t-status');
    if (!pill) return;
    const txt = G.mode === 'test' && G.sim ? gateStatusText(G.sim) : '';
    if (!txt) { pill.hidden = true; return; }
    pill.hidden = false;
    $('#t-status-text').textContent = txt;
    pill.classList.toggle('bad', /blockiert/.test(txt));
  }
  function stopTest() {
    if (G.mode !== 'test') return;
    endGesture();
    if (G.resultModal) { const m = G.resultModal; G.resultModal = null; m.close(); }
    G.sim = null; G.mode = 'build'; G.endT = null; G.resultShown = false; G.paused = false; G.review = false; G.runLen = null;
    $('#screen-game').classList.remove('testing');
    setViewKind(buildViewPref());
    lastCostKey = '';
    updateCost(); updateHistoryButtons(); updateToolButtons();
  }
  function updateSpeedButtons() {
    $$('#speed-seg button').forEach((b) => {
      const on = parseFloat(b.getAttribute('data-speed')) === G.speed;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function updatePauseButton() {
    const b = $('#t-pause');
    if (!b) return;
    $('#t-pause-text').textContent = G.paused ? 'Weiter' : 'Pause';
    $('#t-pause-ic').innerHTML = '<use href="#i-' + (G.paused ? 'play' : 'pause') + '"></use>';
    b.classList.toggle('on', G.paused);
  }
  function updateCamButton() { const b = $('#t-cam'); if (b) b.setAttribute('aria-pressed', String(!!G.chase)); }
  function togglePause() {
    if (G.mode !== 'test' || !G.sim) return;
    if (G.sim.status !== 'running' && G.review) {          // review at the end: "Weiter" plays again from the start
      replayTest(); return;
    }
    G.paused = !G.paused;
    updatePauseButton();
  }
  /** Restarts the same test drive from the beginning (the physics is deterministic). */
  function replayTest() {
    if (G.mode !== 'test' || !G.ed) return;
    if (G.resultModal) { const m = G.resultModal; G.resultModal = null; m.close(); }
    let sim = null;
    try { sim = BB.Physics.createSim(G.level, bridgeClone(G.ed.bridge)); } catch (e) { warn('Physics.createSim', e); }
    if (!sim) return;
    G.sim = sim; G.simAcc = 0; G.endT = null; G.resultShown = false; G.paused = false; G.review = false; G.runLen = null;
    try { if (R && R.clearEffects) R.clearEffects(); } catch (e) { /* ignore */ }
    updatePauseButton(); updateProgress(); updateScrub(true);
    sound('start');
  }
  /** Jumps to time t of the (deterministic) run: re-simulates from the start and pauses there. */
  function seekTo(t) {
    if (G.mode !== 'test' || !G.sim || !G.ed) return;
    const FD = (BB.Physics && BB.Physics.FRAME_DT) || 1 / 60;
    const target = Math.max(0, Math.round(t / FD));
    let sim = G.sim;
    if (target < sim._s.frame) {
      try { sim = BB.Physics.createSim(G.level, bridgeClone(G.ed.bridge)); } catch (e) { warn('Physics.createSim', e); return; }
      G.sim = sim;
    }
    while (sim._s.frame < target && sim.status === 'running') { BB.Physics.step(sim); sim.events.length = 0; }
    G.simAcc = 0; G.paused = true; G.endT = null; G.resultShown = true;
    if (sim.status !== 'running') G.review = true;
    try { if (R && R.clearEffects) R.clearEffects(); } catch (e) { /* ignore */ }
    updatePauseButton(); updateProgress(); updateScrub(true);
  }
  function fmtTime(t) { return fmtDec(Math.round(t * 10) / 10) + ' s'; }
  function updateScrub(force) {
    const seek = $('#t-seek');
    if (!seek || !G.sim) return;
    if (G.seeking && !force) return;
    const t = G.sim.t, total = Math.max(G.runLen || 0, t, 1);
    seek.value = String(Math.round(1000 * t / total));
    $('#t-time').textContent = fmtTime(t);
    $('#t-endtime').textContent = G.runLen ? fmtTime(G.runLen) : '';
  }
  function updateStressButton() { $('#t-stress').setAttribute('aria-pressed', String(!!G.showStress)); }
  function updateProgress() {
    const sim = G.sim;
    if (!sim) return;
    const vs = sim.vehicles || [];
    const total = vs.length || (G.level.vehicles || []).length;
    const fin = vs.filter((v) => v.state === 'finished').length;
    const t = fin + ' / ' + total;
    if (t !== G.progressText) { G.progressText = t; $('#t-progress-text').textContent = t; $('#t-progress').title = 'Fahrzeuge im Ziel: ' + t; }
    updatePhaseButton();
    updateRouteHud();
  }
  /** v3.4: per vehicle "Flagge k/n" and what it waits for – only for levels with several stations / routes / dependencies */
  function updateRouteHud() {
    const el = $('#t-routes'), sim = G.sim;
    if (!el || !sim || !sim.routes) return;
    const routes = sim.routes, vs = sim.vehicles || [];
    const rich = routes.length > 1 || routes.some((r) => r.stations && r.stations.length > 1) || vs.some((v) => v.after);
    if (!rich || vs.length > 6) { if (!el.hidden) el.hidden = true; return; }
    const colorOf = (v) => (v && v.color) || routes[v.route].color;
    const html = vs.map((v) => {
      const n = routes[v.route].stations.length, k = Math.min(n, v.stIdx || 0);
      const nm = vehicleName(v.def ? v.def.key : v.type || 'car');
      let txt = nm + ': Flagge ' + Math.min(n, k + (v.state === 'finished' ? 0 : 1)) + '/' + n, cls = '';
      if (v.state === 'finished') { txt = nm + ': Ziel erreicht'; cls = ' done'; }
      else if (v.state === 'waiting' && v.waitFor) { const o = vs[v.waitFor.v]; txt = nm + ' wartet auf ' + (o ? vehicleName(o.def ? o.def.key : o.key || 'car') : 'Fahrzeug') + ' (Flagge ' + v.waitFor.n + ')'; cls = ' wait'; }
      else if (v.state === 'waiting') txt = nm + ' wartet am Start';
      return '<span class="rv' + cls + '"><i style="background:' + esc(colorOf(v)) + '"></i>' + esc(txt) + '</span>';
    }).join('');
    if (html !== G.routeHtml) { G.routeHtml = html; el.innerHTML = html; }
    if (el.hidden) el.hidden = false;
  }

  /** Advances a simulation with the fixed timestep (SPEC §9). Returns the new accumulator. */
  function stepSimulation(sim, acc, dt, speed, withSound) {
    const FD = (BB.Physics && BB.Physics.FRAME_DT) || 1 / 60;
    acc += dt * speed;
    let n = 0;
    while (acc >= FD && n < 8) {
      BB.Physics.step(sim);
      acc -= FD;
      n++;
      handleSimEvents(sim, withSound);
    }
    if (n >= 8 && acc > FD) acc = 0;     // device too slow: drop the backlog instead of spiralling
    return acc;
  }
  function handleSimEvents(sim, withSound) {
    const evs = sim.events;
    if (!evs || !evs.length) return;
    const list = evs.slice();
    evs.length = 0;
    try { if (R && R.addEvents) R.addEvents(list); } catch (e) { warn('Render.addEvents', e); }
    if (!withSound) return;
    let brk = false, spl = false, horn = false, flg = false;
    list.forEach((ev) => { if (ev.type === 'break') brk = true; else if (ev.type === 'splash') spl = true; else if (ev.type === 'horn') horn = true; else if (ev.type === 'station') flg = true; });
    if (flg) sound('flag');
    if (brk) sound('break');
    if (spl) sound('splash');
    if (horn) sound('horn');
  }

  function updateGame(dt) {
    if (G.mode === 'build') tickQuick(dt);
    if (G.mode !== 'test' || !G.sim) return;
    if (G.paused) { updateScrub(); return; }
    try {
      G.simAcc = stepSimulation(G.sim, G.simAcc, dt, G.speed, true);
    } catch (e) {
      warn('Physik-Fehler', e);
      stopTest();
      infoModal('Fehler in der Simulation', 'Die Testfahrt musste abgebrochen werden. Deine Brücke ist unverändert.', 'fail');
      return;
    }
    const st = G.sim.status;
    if (st !== 'running' && G.endT === null) { G.endT = 0; G.runLen = G.sim.t; if (st === 'failed') sound('fail'); }
    updateScrub();
    if (G.endT !== null && !G.resultShown) {
      G.endT += dt;
      if (G.endT >= (st === 'won' ? 0.7 : 2.5)) showResult();
    }
    updateProgress();
  }

  function showResult() {
    G.resultShown = true;
    const sim = G.sim, L = G.level;
    const cost = G.ed.cost(), budget = L.budget;
    let nextIdx = (G.kind === 'level' && G.index >= 0 && G.index + 1 < LEVELS().length && worldOfLevel(LEVELS()[G.index + 1]) === worldOfLevel(G.level)) ? G.index + 1 : -1;
    const unlockedBefore = (G.kind === 'level' || G.kind === 'custom') ? unlockedWorldIds() : [];
    const backLabel = ({ levels: 'Levelauswahl', custom: 'Eigene Level', editor: 'Zum Editor', sandbox: 'Sandkasten', menu: 'Menü', lab: 'Testlabor' })[G.returnTo] || 'Levelauswahl';
    const backBtn = { label: backLabel, kind: 'white', icon: G.returnTo === 'levels' ? 'levels' : 'back', action: () => { G.resultModal = null; leaveGame(); } };
    const buildBtn = (kind) => ({ label: 'Zurück zum Bauen', kind: kind, icon: 'edit', action: () => { G.resultModal = null; stopTest(); } });
    const watchBtn = { label: 'Wiederholung ansehen', kind: 'white', icon: 'replay', action: () => { G.resultModal = null; G.review = true; G.paused = true; updatePauseButton(); seekTo(Math.max(0, (G.runLen || sim.t) - 4)); } };
    const stats = (over) => '<dl class="result-stats"><dt>Kosten</dt><dd' + (over ? ' class="over"' : '') + '>' + fmtEuro(cost) + '</dd>' +
      '<dt>Budget</dt><dd>' + (budget == null ? 'unbegrenzt' : fmtEuro(budget)) + '</dd></dl>';
    const common = { dismissable: false, onEscape: () => { const m = G.resultModal; G.resultModal = null; if (m) m.close(); stopTest(); } };

    if (sim.status === 'won' && (budget == null || cost <= budget)) {
      const stars = budget == null ? 3 : starsFor(cost, budget);
      if ((G.kind === 'level' && testerOn() && !worldUnlockedReal(worldOfLevel(L))) || G.kind === 'lab') toast(G.kind === 'lab' ? 'Testlabor: Ergebnis wird nicht gespeichert' : 'Tester-Modus: Ergebnis wird nicht gespeichert', 'info');
      else if (G.kind === 'level' || G.kind === 'custom') { sv('completeLevel', L.id, cost, stars); sv('flush'); }
      else if (G.kind === 'weekly') { sv('completeWeekly', currentWeekKey(), L.seed, cost, stars); sv('flush'); }
      if (G.kind === 'level') {
        const fresh = unlockedWorldIds().filter((id) => unlockedBefore.indexOf(id) < 0);
        if (fresh.length) setTimeout(() => toast((isZeit() ? 'Neue Epoche freigeschaltet: ' : 'Neue Welt freigeschaltet: ') + fresh.map((id) => (worldGet(id) || { name: id }).name).join(', ') + '!', 'ok'), 1600);
      }
      const buttons = [];
      if (nextIdx >= 0) buttons.push({ label: 'Nächstes Level', kind: 'green', icon: 'play', action: () => { G.resultModal = null; openLevelByIndex(nextIdx); } });
      buttons.push(buildBtn(nextIdx >= 0 ? 'white' : 'blue'));
      buttons.push(watchBtn);
      buttons.push(backBtn);
      const showStars = budget != null;
      const allDone = G.kind === 'level' && nextIdx < 0;
      const lastText = 'Diese Welt hast du durchgespielt – zurück zur Weltkarte!';
      G.resultModal = openModal(Object.assign({
        cls: 'win', title: 'Geschafft!',
        html: (showStars ? '<div class="result-stars">' + [0, 1, 2].map(() => icon('star', 'rstar')).join('') + '</div>' : '') +
          '<p>' + (allDone ? lastText : 'Alle Fahrzeuge sind sicher angekommen.') + '</p>' + stats(false),
        buttons: buttons,
      }, common));
      sound('win');
      if (showStars) {
        const els = $$('.rstar', G.resultModal.el);
        for (let i = 0; i < stars; i++) setTimeout(() => { if (els[i]) { els[i].classList.add('on'); sound('star'); } }, 450 + i * 380);
      }
    } else if (sim.status === 'won') {
      G.resultModal = openModal(Object.assign({
        cls: 'warn', icon: 'warn', title: 'Geschafft – aber über dem Budget!',
        html: '<p>Die Brücke hält, ist aber ' + fmtEuro(cost - budget) + ' zu teuer. Baue sparsamer, damit das Level zählt.</p>' + stats(true),
        buttons: [buildBtn('blue'), watchBtn, backBtn],
      }, common));
      sound('fail');
    } else {
      G.resultModal = openModal(Object.assign({
        cls: 'fail', icon: 'warn', title: 'Leider nicht geschafft',
        html: '<p>' + esc(resultText(sim.reason)) + '</p><p class="muted-text">Verstärke die Brücke und versuche es noch einmal.</p>',
        buttons: [buildBtn('blue'), watchBtn, backBtn],
      }, common));
    }
  }

  // ===========================================================================
  // Sandbox
  // ===========================================================================
  function sandboxParams() {
    const st = saveState();
    let p = st && st.sandbox;
    if (!p || typeof p !== 'object') { p = jsonClone(SANDBOX_DEFAULT); if (st) st.sandbox = p; }
    normalizeShape(p);
    p.vehicles = normalizeVehicles(p.vehicles);
    return p;
  }
  function sandboxLevel(p) {
    const L = generateLevel({
      span: p.span, heightDiff: p.heightDiff, water: p.water, rocks: p.rocks, lowAnchors: p.lowAnchors, highAnchors: p.highAnchors,
      vehicles: p.vehicles.slice(), budget: null, name: 'Sandkasten', id: 'sandbox', wind: p.wind, ice: p.ice,
    });
    if (L) {
      L.sandbox = true;            // every material, foundations and split joints without limits
      if (p.world && BB.Worlds && BB.Worlds.get(p.world)) L.world = p.world;
    }
    return L;
  }
  let sbPreviewTimer = null;
  function scheduleSandboxPreview() { clearTimeout(sbPreviewTimer); sbPreviewTimer = setTimeout(updateSandboxPreview, 90); }
  function updateSandboxPreview() {
    const p = sandboxParams();
    const box = $('#sb-preview');
    const lvl = sandboxLevel(p);
    box.innerHTML = '';
    if (lvl) {
      const r = box.getBoundingClientRect();
      box.appendChild(makeThumb(lvl, r.width || 560, r.height || 350));
    }
    $('#sb-caption').textContent = 'Spannweite ' + p.span + ' m · Höhe ' + fmtSigned(p.heightDiff) + ' m · ' + summarizeVehicles(p.vehicles);
  }
  function renderSandboxScreen() {
    const p = sandboxParams();
    const wrap = $('#sb-params');
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'prow-head', 'Gelände'));
    const shape = el('div');
    wrap.appendChild(shape);
    buildShapeRows(shape, p, () => { sv('change'); scheduleSandboxPreview(); });
    const worlds = BB.Worlds ? BB.Worlds.LIST : [];
    if (worlds.length) {
      const wi = Math.max(0, worlds.findIndex((w) => w.id === p.world));
      const st = makeStepper(wi, 0, worlds.length - 1, 1, (v) => worlds[v].name, (v) => { p.world = worlds[v].id; sv('change'); scheduleSandboxPreview(); });
      shape.appendChild(paramRow('world', 'Aussehen', 'Welt-Look: Farben, Bäume, Wetter', st.el));
    }
    wrap.appendChild(el('div', 'prow-head', 'Fahrzeuge'));
    const veh = el('div');
    wrap.appendChild(veh);
    buildVehicleRows(veh, () => p.vehicles, (list) => { p.vehicles = list; sv('change'); scheduleSandboxPreview(); });
    updateSandboxPreview();
  }
  function startSandbox() {
    const p = sandboxParams();
    const lvl = sandboxLevel(p);
    if (!lvl) { infoModal('Sandkasten nicht verfügbar', 'Das Gelände konnte nicht erzeugt werden.', 'fail'); return; }
    // the saved sandbox bridge belongs to one terrain – start empty when the terrain changed
    const key = JSON.stringify([p.span, p.heightDiff, p.water, p.rocks, p.lowAnchors, p.highAnchors]);
    if (getSetting('sandboxBridgeFor') !== key) { sv('setBridge', 'sandbox', { beams: [] }); setSetting('sandboxBridgeFor', key); }
    openGame(lvl, { kind: 'sandbox', key: 'sandbox', returnTo: 'sandbox' });
  }
  screenHooks.sandbox = { show() { setView('none'); renderSandboxScreen(); } };

  // ===========================================================================
  // Custom levels list
  // ===========================================================================
  function customLevels() { const l = sv('getCustomLevels'); return Array.isArray(l) ? l.filter((x) => x && x.id) : []; }
  function renderCustomList() {
    const wrap = $('#custom-list');
    wrap.innerHTML = '';
    const list = customLevels();
    if (!list.length) {
      const empty = el('div', 'card empty-state', icon('edit', 'big-ic') + '<p>Du hast noch keine eigenen Level.<br>Baue dein erstes im Level-Editor!</p>');
      const b = el('button', 'btn btn-teal', icon('plus') + '<span>Neues Level</span>');
      b.type = 'button';
      b.addEventListener('click', () => openEditorNew('custom'));
      empty.appendChild(b);
      wrap.appendChild(empty);
      return;
    }
    list.forEach((lv, i) => {
      const item = el('div', 'card custom-item');
      item.style.animationDelay = Math.min(i * 30, 300) + 'ms';
      const thumb = el('div', 'lvl-thumb');
      item.appendChild(thumb);
      const done = !!sv('isCompleted', lv.id);
      const stars = done ? clamp(sv('getStars', lv.id) | 0, 0, 3) : 0;
      const info = el('div', 'custom-info',
        '<div class="custom-name">' + esc(lv.name || 'Ohne Namen') + '</div>' +
        '<div class="custom-meta">' + (lv.budget != null ? 'Budget ' + fmtEuro(lv.budget) : 'ohne Budget') + ' · ' + esc(summarizeVehicles(lv.vehicles) || '–') + (done ? ' ' + starsHtml(stars) : '') + '</div>');
      const actions = el('div', 'custom-actions');
      const mk = (label, kind, ic, fn) => { const b = el('button', 'btn btn-' + kind, icon(ic) + '<span>' + label + '</span>'); b.type = 'button'; b.addEventListener('click', fn); actions.appendChild(b); };
      mk('Spielen', 'green', 'play', () => playCustom(lv));
      mk('Bearbeiten', 'blue', 'edit', () => openEditorFor(lv, 'custom'));
      mk('Löschen', 'white', 'trash', () => confirmModal({
        title: 'Level löschen?', icon: 'trash', cls: 'warn',
        text: '„' + (lv.name || 'Ohne Namen') + '“ wird endgültig gelöscht.',
        okLabel: 'Löschen', okKind: 'red', okIcon: 'trash',
        onOk: () => { sv('deleteCustomLevel', lv.id); sv('flush'); toast('Level gelöscht'); renderCustomList(); },
      }));
      info.appendChild(actions);
      item.appendChild(info);
      wrap.appendChild(item);
      setTimeout(() => {
        const r = thumb.getBoundingClientRect();
        thumb.appendChild(thumbFor(lv, Math.round(r.width || 190), Math.round(r.height || 119)));
      }, 20 + i * 10);
    });
  }
  function playCustom(lv) {
    const v = validateLevel(lv);
    if (!v.ok) {
      openModal({
        title: 'Level noch nicht spielbar', icon: 'warn', cls: 'warn', html: errorsHtml(v.errors),
        buttons: [{ label: 'Abbrechen', kind: 'white' }, { label: 'Bearbeiten', kind: 'blue', icon: 'edit', action: () => openEditorFor(lv, 'custom') }],
      });
      return;
    }
    openGame(cloneLevel(lv), { kind: 'custom', key: 'custom:' + lv.id, returnTo: 'custom' });
  }
  screenHooks.custom = { show() { setView('none'); renderCustomList(); } };

  // ===========================================================================
  // Level editor
  // ===========================================================================
  const E = {
    level: null, params: null, tool: 'terrain', dirty: false, manual: false,
    history: [], hoverVertex: null, hoverAnchor: null, returnTo: 'menu', pendingRegen: false,
  };
  const EDITOR_SHAPE_DEFAULT = { span: 16, heightDiff: 0, water: true, rocks: 0, lowAnchors: true, highAnchors: false, wind: 0, ice: false };
  const EMPTY_BRIDGE = { beams: [] };
  const TOOL_TIPS = {
    anchor: 'Tippe auf einen Gitterpunkt: Anker setzen oder entfernen.',
    terrain: 'Ziehe die Geländepunkte. Tippe auf die Bodenlinie für einen neuen Punkt.',
    erase: 'Tippe auf einen Anker oder Geländepunkt, um ihn zu löschen.',
    zone: 'Ziehe ein Rechteck auf: Dort darf gebaut werden (ohne Zone überall im Baubereich). Tippe in eine Zone, um sie zu löschen.',
    prebuilt: 'Ziehe von Punkt zu Punkt: ein Teil, das schon im Level steht (hilft oder steht im Weg). Tippe auf ein Teil, um es zu löschen.',
    piston: 'Ziehe vom Drehpunkt zur Kolbenspitze. Tippe auf einen Kolben, um Hub, Tempo und Phasen einzustellen.',
    ship: 'Ziehe über dem Wasser entlang: So weit fährt das Boot. Tippe auf ein Boot, um es einzustellen.',
    checkpoint: 'Tippe auf den Boden: Ein Fahrzeug, das dort vorbeifährt, löst die nächste Hydraulik-Phase aus. Tippe auf einen Kontrollpunkt zum Ändern.',
  };
  const PB_KINDS = { road: ['road', 0], steelroad: ['steelroad', 0], wood: ['wood', 0], steel: ['steel', 0], concrete: ['concrete', 0], obstacle: ['steel', 1] };
  E.pbKind = 'road'; E.drag = null;

  function suggestBudget(span) { return Math.max(2000, Math.round((span * 450 + 2000) / 500) * 500); }
  function openEditorNew(returnTo) {
    const p = jsonClone(EDITOR_SHAPE_DEFAULT);
    const id = 'C' + Date.now().toString(36);
    const lvl = generateLevel(Object.assign({}, p, { vehicles: ['car'], budget: suggestBudget(p.span), name: 'Mein Level', id: id }));
    if (!lvl) { infoModal('Editor nicht verfügbar', 'Das Gelände konnte nicht erzeugt werden. Bitte lade die Seite neu.', 'fail'); return; }
    lvl.editorParams = jsonClone(p);
    E.level = lvl; E.params = p; E.dirty = true; E.manual = false; E.history = []; E.pendingRegen = false;
    E.returnTo = returnTo || 'menu';
    enterEditor();
  }
  function openEditorFor(level, returnTo) {
    E.level = cloneLevel(level);
    E.params = normalizeShape(Object.assign(jsonClone(EDITOR_SHAPE_DEFAULT), level.editorParams || {}));
    E.dirty = false; E.manual = true; E.history = []; E.pendingRegen = false;
    E.returnTo = returnTo || 'custom';
    enterEditor();
  }
  function enterEditor() {
    closeAllModals();
    E.level.vehicles = normalizeVehicles(E.level.vehicles);
    if (E.level.budget == null || !isFinite(E.level.budget)) E.level.budget = suggestBudget(E.params.span);
    buildEditorPanel();
    setEditorTool(E.tool || 'terrain');
    showScreen('editor');
    fitView(false);
  }
  screenHooks.editor = { show() { setView('editor'); setViewKind(buildViewPref(), true); fitView(false); updateEditorStatus(); } };

  function buildEditorPanel() {
    $('#e-name').value = E.level.name || '';
    $('#e-budget').value = fmtNum(E.level.budget);
    buildVehicleRows($('#e-vehicles'), () => E.level.vehicles, (list) => { E.level.vehicles = list; markEditorDirty(); }, Array.isArray(E.level.routes) ? E.level.routes.length : 1);
    buildShapeRows($('#e-params'), E.params, onShapeParamChange);
    buildEditorExtras();
    $('#e-regen').classList.toggle('pending', E.pendingRegen);
    updateEditorStatus();
  }
  /** Routes (several flags) and the list of allowed building parts. */
  function buildEditorExtras() {
    const L = E.level;
    const rbox = $('#e-routes');
    rbox.innerHTML = '';
    const multi = Array.isArray(L.routes) && L.routes.length > 1;
    const sw = makeSwitch(multi, (v) => {
      const before = editorSnapshot();
      if (v) {
        const sx = L.startX, fx = L.flagX;
        L.routes = [{ startX: sx, flagX: fx, color: '#e8453c' }, { startX: sx - 20, flagX: fx - 4, color: '#2e86de' }];
        L.vehicles = L.vehicles.map((e) => (typeof e === 'string' ? { t: e, r: 0 } : e));
      } else {
        delete L.routes;
        L.vehicles = L.vehicles.map(vehKey);
      }
      commitEditorChange(before);
      buildEditorPanel();
    }, 'Zweites Ziel (blaue Flagge)');
    rbox.appendChild(paramRow('flag', 'Zweites Ziel', 'Blaue Fahrzeuge fahren zur blauen Flagge', sw.el));
    if (multi) {
      const r2 = L.routes[1];
      const mk = (field, title, sub) => {
        const s2 = makeStepper(r2[field], -200, 400, 1, (v) => v + ' m', (v) => { const before = editorSnapshot(); r2[field] = v; commitEditorChange(before); });
        rbox.appendChild(paramRow('anchor', title, sub, s2.el));
      };
      mk('startX', 'Start der blauen Route', 'Der Boden links davon muss eben sein');
      mk('flagX', 'Blaue Flagge', 'Der Boden um die Flagge muss eben sein');
    }
    const mbox = $('#e-mats');
    mbox.innerHTML = '';
    const all = (BB.MATERIAL_ORDER || []).concat(['foundation']);
    const allowed = Array.isArray(L.materials) && L.materials.length ? L.materials : all;
    all.forEach((k) => {
      const nm = k === 'foundation' ? 'Fundament' : (matDef(k) && matDef(k).name) || k;
      const b = el('button', 'chip' + (allowed.indexOf(k) >= 0 ? ' on' : ''), esc(nm));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(allowed.indexOf(k) >= 0));
      b.addEventListener('click', () => {
        const before = editorSnapshot();
        const cur = (Array.isArray(L.materials) && L.materials.length ? L.materials : all).slice();
        const i = cur.indexOf(k);
        if (i >= 0) cur.splice(i, 1); else cur.push(k);
        const ordered = all.filter((x) => cur.indexOf(x) >= 0);
        if (!ordered.some((x) => matDef(x) && matDef(x).drivable)) { sound('error'); toast('Mindestens eine befahrbare Straße muss erlaubt bleiben.', 'warn'); return; }
        if (ordered.length === all.length) delete L.materials; else L.materials = ordered;
        commitEditorChange(before);
        buildEditorExtras();
      });
      mbox.appendChild(b);
    });
    $$('#e-pbkind button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-k') === E.pbKind);
      b.onclick = () => { E.pbKind = b.getAttribute('data-k'); $$('#e-pbkind button').forEach((x) => x.classList.toggle('on', x === b)); };
    });
  }
  function setEditorTool(t) {
    E.tool = t;
    $$('#e-tools button').forEach((b) => {
      const on = b.getAttribute('data-tool') === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#e-tip').textContent = TOOL_TIPS[t] || '';
    $('#e-pbrow').hidden = t !== 'prebuilt';
    E.hoverVertex = null; E.hoverAnchor = null; E.drag = null;
  }
  function editorSnapshot() { return JSON.stringify({ level: E.level, manual: E.manual, params: E.params }); }
  function pushEditorHistory(snap) {
    E.history.push(snap);
    if (E.history.length > 100) E.history.shift();
  }
  function commitEditorChange(before) {
    pushEditorHistory(before);
    E.manual = true;
    markEditorDirty();
  }
  function markEditorDirty() { E.dirty = true; updateEditorStatus(); }
  function editorUndo() {
    if (!E.history.length) return;
    endGesture();
    const s = JSON.parse(E.history.pop());
    E.level = s.level; E.manual = s.manual; E.params = normalizeShape(s.params);
    E.dirty = true;
    buildEditorPanel();
    sound('click');
  }
  function onShapeParamChange() {
    if (!E.manual) regenerateLevel(true);
    else { E.pendingRegen = true; $('#e-regen').classList.add('pending'); markEditorDirty(); }
  }
  function regenerateLevel(keepCameraSmooth) {
    const L = E.level;
    const lvl = generateLevel(Object.assign({}, E.params, { vehicles: L.vehicles.slice(), budget: L.budget, name: L.name, id: L.id }));
    if (!lvl) { toast('Die Grundform konnte nicht erzeugt werden', 'warn'); return; }
    pushEditorHistory(editorSnapshot());
    lvl.editorParams = jsonClone(E.params);
    E.level = lvl; E.manual = false; E.pendingRegen = false;
    $('#e-regen').classList.remove('pending');
    markEditorDirty();
    fitView(!!keepCameraSmooth);
  }
  function askRegenerate() {
    if (!E.manual) { regenerateLevel(true); return; }
    confirmModal({
      title: 'Grundform neu erzeugen?', icon: 'reset', cls: 'warn',
      text: 'Deine Änderungen an Gelände und Ankern gehen dabei verloren. (Du kannst sie mit „Zurück“ wiederholen.)',
      okLabel: 'Neu erzeugen', okKind: 'blue', okIcon: 'reset',
      onOk: () => regenerateLevel(true),
    });
  }
  function updateEditorStatus() {
    if (!E.level) return;
    const v = validateLevel(E.level);
    const box = $('#e-status');
    if (v.ok) {
      box.className = 'ed-status ok';
      box.innerHTML = icon('check') + '<span>Das Level ist spielbereit.</span>';
    } else {
      box.className = 'ed-status bad';
      box.innerHTML = icon('warn') + '<div><b>Noch nicht spielbar:</b><ul>' + v.errors.slice(0, 4).map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
    }
    $('#e-title').textContent = 'Level-Editor · ' + (E.level.name || 'Ohne Namen');
    $('#e-undo').disabled = !E.history.length;
  }
  function parseBudget(text) {
    const n = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
    return isFinite(n) ? clamp(n, 500, 10000000) : null;
  }
  function setEditorBudget(v) {
    E.level.budget = clamp(Math.round(v), 500, 10000000);
    $('#e-budget').value = fmtNum(E.level.budget);
    markEditorDirty();
  }
  function editorSave(after, quiet) {
    const doSave = () => {
      const lvl = cloneLevel(E.level);
      lvl.name = String(lvl.name || '').trim() || 'Mein Level';
      lvl.editorParams = jsonClone(E.params);
      sv('saveCustomLevel', lvl);
      sv('flush');
      E.dirty = false;
      if (!quiet) toast('Level gespeichert', 'ok');
      if (after) after();
    };
    const v = validateLevel(E.level);
    if (!v.ok && !quiet) {
      openModal({
        title: 'Das Level hat noch Fehler', icon: 'warn', cls: 'warn',
        html: '<p>So kann es noch nicht gespielt werden:</p>' + errorsHtml(v.errors),
        buttons: [{ label: 'Trotzdem speichern', kind: 'white', action: doSave }, { label: 'Weiter bearbeiten', kind: 'blue' }],
      });
      return;
    }
    doSave();
  }
  function editorTest() {
    const v = validateLevel(E.level);
    if (!v.ok) {
      sound('error');
      openModal({ title: 'Noch nicht spielbar', icon: 'warn', cls: 'warn', html: errorsHtml(v.errors), buttons: [{ label: 'OK', kind: 'blue' }] });
      return;
    }
    editorSave(() => {
      toast('Level gespeichert', 'ok');
      openGame(cloneLevel(E.level), { kind: 'custom', key: 'custom:' + E.level.id, returnTo: 'editor' });
    }, true);
  }
  function editorBack() {
    const go = () => { const r = E.returnTo; E.dirty = false; showScreen(r === 'custom' ? 'custom' : 'menu'); };
    if (!E.dirty) { go(); return; }
    openModal({
      title: 'Änderungen speichern?', icon: 'save',
      html: '<p>Dein Level hat ungespeicherte Änderungen.</p>',
      buttons: [
        { label: 'Verwerfen', kind: 'white', action: go },
        { label: 'Speichern', kind: 'blue', icon: 'save', action: () => editorSave(go) },
      ],
    });
  }

  // ===========================================================================
  // Settings
  // ===========================================================================
  let selfTest = null;
  function currentQuality() { return (R3D && R3D.quality) || readGfx().quality || 'mid'; }
  function refreshSettings() {
    applyMute();
    const vol = $('#set-volume'); if (vol) vol.value = String(Math.round((+getSetting('volume') || 0) * 100));
    $('#set-sfx').setAttribute('aria-checked', String(getSetting('sfx') !== false));
    $('#set-music').setAttribute('aria-checked', String(!!getSetting('music')));
    $('#set-tester').setAttribute('aria-checked', String(!!getSetting('testerMode')));
    const tz = $('#set-tester-zeit'); if (tz) tz.setAttribute('aria-checked', String(!!getSetting('testerModeZeit')));
    $('#set-debug').setAttribute('aria-checked', String(!!getSetting('debugInfo')));
    $$('#set-view button').forEach((b) => { const on = b.getAttribute('data-v') === buildViewPref(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('#set-stress').setAttribute('aria-checked', String(getSetting('showStress') !== false));
    $('#set-chase').setAttribute('aria-checked', String(!!getSetting('chaseCam')));
    const can3d = !!(BB.Render3D && BB.Render3D.supported());
    $('#set-3d').setAttribute('aria-checked', String(using3d));
    $('#set-3d').disabled = !can3d;
    $('#set-3d-info').textContent = can3d ? 'Ruhige Low-Poly-Welt (aus = klassische 2D-Grafik)' : 'Dieses Gerät kann kein WebGL – es wird die 2D-Grafik benutzt.';
    $$('#set-quality button').forEach((b) => { const on = b.getAttribute('data-q') === currentQuality(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !using3d; });
    const gs = $('#set-gfx-status span');
    if (gs) gs.textContent = using3d ? 'Aktiv: 3D · ' + ({ low: 'Niedrig', mid: 'Mittel', high: 'Hoch' })[currentQuality()] + (R3D && R3D.resScale && R3D.resScale < 0.99 ? ' · Auflösung automatisch auf ' + Math.round(R3D.resScale * 100) + ' % gesenkt' : '') : 'Aktiv: 2D (klassisch)';
    const t = sv('lastBackupAt');
    $('#set-lastbackup').textContent = 'Letzte Sicherung: ' + (t ? fmtDateTime(t) : 'noch nie');
    const info = $('#set-storage');
    const row = info.parentNode;
    let text, bad = false;
    const ok = Save && Save.storageOk;
    if (saveIsMemory || (ok && !ok.local && !ok.idb)) { text = 'Speichern ist nicht möglich – der Fortschritt geht beim Schließen verloren. Bitte exportieren!'; bad = true; }
    else if (Save.persisted === true) text = 'Speicher: dauerhaft – der Browser löscht den Spielstand nicht von selbst.';
    else if (Save.persisted === false) { text = 'Speicher: nicht dauerhaft – der Browser darf Daten löschen. Sichere regelmäßig!'; bad = true; }
    else text = 'Speicher: Status unbekannt – sichere zur Vorsicht ab und zu.';
    info.textContent = text;
    row.classList.toggle('warn', bad);
    $('#set-version').textContent = 'Brückenbauer Version ' + BB.VERSION;
    $('#set-version-head').textContent = 'Version ' + BB.VERSION;
  }
  screenHooks.settings = { show() { setView('none'); refreshSettings(); }, hide() { cancelSelfTest(); } };

  function readFileText(file) {
    if (file.text) return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }
  function onImportFile(input) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    readFileText(f).then((text) => {
      const r = sv('parseImport', text);
      if (!r || !r.ok || !r.state) { sound('error'); infoModal('Import fehlgeschlagen', (r && r.error) || 'Die Datei ist kein gültiger Spielstand.', 'fail'); return; }
      const st = r.state;
      const done = st.progress && st.progress.completed ? Object.keys(st.progress.completed).filter((k) => st.progress.completed[k]).length : 0;
      const customs = Array.isArray(st.customLevels) ? st.customLevels.length : 0;
      openModal({
        title: 'Spielstand importieren?', icon: 'upload',
        html: '<p>Die Datei enthält <b>' + done + '</b> geschaffte Level und <b>' + customs + '</b> eigene Level' +
          (st.savedAt ? ' (Stand: ' + esc(fmtDateTime(st.savedAt)) + ')' : '') + '.</p><p>Dein aktueller Spielstand wird dabei ersetzt.</p>',
        buttons: [
          { label: 'Abbrechen', kind: 'white' },
          {
            label: 'Importieren', kind: 'blue', icon: 'upload',
            action: () => {
              sv('applyImport', st);
              thumbCache = Object.create(null);
              Menu.level = null; Menu.sim = null;
              applyMute(); refreshSettings();
              toast('Spielstand importiert', 'ok');
            },
          },
        ],
      });
    }, (e) => { warn('Datei lesen', e); infoModal('Import fehlgeschlagen', 'Die Datei konnte nicht gelesen werden.', 'fail'); });
  }
  function resetFlow() {
    let keep = true;
    const step2 = () => {
      openModal({
        title: 'Wirklich zurücksetzen?', icon: 'warn', cls: 'fail',
        html: '<p>Das kann nicht rückgängig gemacht werden. ' + (keep ? 'Deine eigenen Level bleiben erhalten.' : 'Auch deine eigenen Level werden gelöscht.') +
          '</p><p class="muted-text">Tipp: Exportiere vorher deinen Spielstand.</p>',
        buttons: [
          { label: 'Abbrechen', kind: 'white' },
          {
            label: 'Ja, zurücksetzen', kind: 'red', icon: 'reset',
            action: () => {
              sv('resetProgress', { keepCustom: keep });
              sv('flush');
              thumbCache = Object.create(null);
              applyMute(); refreshSettings();
              toast('Fortschritt wurde zurückgesetzt', 'ok');
            },
          },
        ],
      });
    };
    openModal({
      title: 'Fortschritt zurücksetzen?', icon: 'reset', cls: 'warn',
      html: '<p>Sterne, freigeschaltete Level und deine gebauten Brücken werden gelöscht.</p>' +
        '<label class="check-row"><input type="checkbox" id="reset-keep" checked> Eigene Level behalten</label>',
      buttons: [
        { label: 'Abbrechen', kind: 'white' },
        { label: 'Weiter', kind: 'red', action: (h) => { const cb = $('#reset-keep', h.el); keep = !cb || cb.checked; setTimeout(step2, 60); } },
      ],
    });
  }

  function runSelfTest() {
    if (selfTest) return;
    const list = $('#selftest-list'), summary = $('#selftest-summary'), btn = $('#set-selftest');
    list.innerHTML = '';
    summary.textContent = '';
    const levels = ALL_LEVELS();
    if (!levels.length || !hasPhysics()) { summary.textContent = 'Selbsttest nicht möglich: Level oder Physik fehlen.'; return; }
    const items = levels.map((L, i) => {
      const li = el('li', '', '<span class="st-ic"></span><span class="st-name">' + (i + 1) + '. ' + esc(L.name) + '</span><span class="st-res">wartet …</span>');
      list.appendChild(li);
      return li;
    });
    const run = { cancelled: false, passed: 0 };
    selfTest = run;
    btn.disabled = true;
    summary.textContent = 'Prüfe ' + levels.length + ' Level …';
    // Per level, two checks run (SPEC §4): (1) the sample solution wins with 3 Sternen and no
    // beam over 85 % Belastung, (2) the SAME level fails with an empty bridge (no shortcut).
    let i = 0, sim = null, stage = 'solution', solutionOk = false;
    const mark = (li, ok, text) => {
      li.className = ok ? 'ok' : 'bad';
      li.querySelector('.st-ic').innerHTML = icon(ok ? 'check' : 'close');
      li.querySelector('.st-res').textContent = text;
    };
    const advance = () => { sim = null; stage = 'solution'; solutionOk = false; i++; setTimeout(next, 0); };
    const runToEnd = (s, cb) => {
      const t0 = nowMs();
      try {
        while (s.status === 'running' && s.t < 300 && nowMs() - t0 < 25) {
          BB.Physics.step(s);
          if (s.events) s.events.length = 0;
        }
      } catch (e) { warn('Selbsttest', e); cb('error'); return; }
      if (s.status === 'running' && s.t < 300) { setTimeout(next, 0); return; }
      cb('done');
    };
    const next = () => {
      if (run.cancelled) return;
      if (i >= levels.length) {
        selfTest = null;
        btn.disabled = false;
        summary.textContent = run.passed + ' von ' + levels.length + ' Level bestanden' + (run.passed === levels.length ? ' – alles in Ordnung!' : '.');
        return;
      }
      const L = levels[i], li = items[i];
      if (stage === 'solution') {
        if (!sim) {
          li.className = 'run';
          li.querySelector('.st-res').textContent = 'läuft …';
          const v = validateBridge(L, L.solution || { beams: [] });
          if (!L.solution || !v.ok) { mark(li, false, 'Musterlösung ungültig'); advance(); return; }
          try { sim = BB.Physics.createSim(L, bridgeClone(L.solution)); } catch (e) { warn('Selbsttest', e); mark(li, false, 'Fehler beim Start'); advance(); return; }
        }
        runToEnd(sim, (r) => {
          if (r === 'error') { mark(li, false, 'Fehler in der Simulation'); advance(); return; }
          const cost = bridgeCost(L, L.solution), budget = L.budget;
          const stars = starsFor(cost, budget);
          const s = BB.Physics.summary(sim);
          const stressOk = s.maxStress <= 0.85 + 1e-6;
          const ok = sim.status === 'won' && stars === 3 && stressOk;
          let res = fmtEuro(cost) + ' / ' + (budget == null ? 'unbegrenzt' : fmtEuro(budget)) + ' · ' + Math.round(s.maxStress * 100) + '% Belastung';
          if (!ok) {
            res = (sim.status !== 'won' ? resultText(sim.reason) : (!stressOk ? 'Balken über 85 % Belastung' : 'nur ' + stars + ' Sterne')) + ' · ' + res;
            mark(li, false, res); advance(); return;
          }
          solutionOk = true;
          li.querySelector('.st-res').textContent = res + ' · prüfe ohne Brücke …';
          sim = null; stage = 'empty';
          setTimeout(next, 0);
        });
        return;
      }
      // stage === 'empty': the level must NOT be winnable without building anything
      if (!sim) {
        try { sim = BB.Physics.createSim(L, { beams: [] }); } catch (e) { warn('Selbsttest', e); mark(li, false, 'Fehler beim Start (ohne Brücke)'); advance(); return; }
      }
      runToEnd(sim, (r) => {
        if (r === 'error') { mark(li, true, 'Musterlösung OK (Fehler bei Leerlauf-Test ignoriert)'); if (solutionOk) run.passed++; advance(); return; }
        const failsWithoutBridge = sim.status !== 'won';
        const ok = solutionOk && failsWithoutBridge;
        if (ok) run.passed++;
        mark(li, ok, ok ? '3 Sterne, Belastung OK, scheitert ohne Brücke' : 'Level ist ohne Brücke lösbar!');
        advance();
      });
    };
    setTimeout(next, 30);
  }
  function cancelSelfTest() {
    if (!selfTest) return;
    selfTest.cancelled = true;
    selfTest = null;
    $('#set-selftest').disabled = false;
    $('#selftest-summary').textContent = 'Selbsttest abgebrochen.';
  }

  // ===========================================================================
  // Canvas input (Pointer Events): build / erase / pan / pinch / level editor
  // ===========================================================================
  const pointers = new Map();     // pointerId → { x, y, x0, y0, type, moved }
  let gesture = null;             // { type: 'build'|'erase'|'pan'|'pinch'|'tap'|'vertex', id, ... }

  function resetPointers() {
    endGesture();
    pointers.clear();
  }
  /** Ends the current gesture cleanly (used when a modal opens, view changes, test starts …). */
  function endGesture() {
    if (gesture) {
      if (gesture.type === 'build' && G.ed) G.ed.cancelDrag();
      if (gesture.type === 'erase' && G.ed) G.ed.endErase();
      if (gesture.type === 'vertex') finishVertexDrag();
      if (gesture.type === 'selmove') G.moveGhost = null;
      if (gesture.type === 'trace') G.trace = null;
    }
    gesture = null;
    if (G.ed && G.ed.drag) G.ed.cancelDrag();
  }
  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function tolFor(type) { return (type === 'mouse' ? 14 : 28) / cam.zoom; }
  /** Grid / node point under the pointer for the trace tools (null when the grid snap is off and nothing is close). */
  function snapPointFor(w, tol) { return G.ed ? G.ed.snapPoint(w[0], w[1], Math.max(0.7, tol)) : null; }
  function canvasActive() { return (view === 'game' || view === 'editor') && !modalStack.length; }

  function onPointerDown(e) {
    if (!canvasActive()) return;
    e.preventDefault();
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur) doc.activeElement.blur();
    // a new primary pointer means no other pointer is down – drop stale ones (lost pointerup)
    if (e.isPrimary && pointers.size) resetPointers();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    const p = localPos(e);
    pointers.set(e.pointerId, { x: p[0], y: p[1], x0: p[0], y0: p[1], type: e.pointerType, moved: false });
    camTween = null;
    if (pointers.size === 1) beginSingle(e, p);
    else if (pointers.size === 2) beginPinch();
  }
  function beginSingle(e, p) {
    const id = e.pointerId;
    if (e.pointerType === 'mouse' && e.button !== 0) { gesture = { type: 'pan', id: id }; canvas.style.cursor = 'grabbing'; return; }
    if (G.spaceHeld && view === 'game') { G.spaceUsed = true; gesture = { type: 'pan', id: id }; canvas.style.cursor = 'grabbing'; return; }
    const w = s2w(cam, p[0], p[1]);
    const tol = tolFor(e.pointerType);
    if (view === 'game' && G.ed && G.mode === 'build') {
      const addSel = !!(e.shiftKey || e.ctrlKey || e.metaKey);
      if (G.paste) { pasteTo(w); gesture = { type: 'paste', id: id, mouse: e.pointerType === 'mouse' }; return; }
      if (G.trace && G.trace.kind === 'arc' && G.trace.phase === 2) { G.trace.b = snapPointFor(w, tol) || G.trace.b; gesture = { type: 'arcb', id: id }; return; }
      if (G.ed.tool === 'select') {
        const bi = G.ed.beamAt(w[0], w[1], tol);
        if (bi >= 0) {
          if (addSel) G.ed.selectAt(w[0], w[1], tol, 'toggle'); else if (!G.ed.isSelected(bi)) G.ed.selectAt(w[0], w[1], tol, 'replace');
          if (G.ed.selectionCount()) { gesture = { type: 'selmove', id: id, w0: w, dx: 0, dy: 0, moved: false }; G.moveGhost = null; return; }
        } else { gesture = { type: 'box', id: id, x0: w[0], y0: w[1], x1: w[0], y1: w[1], add: addSel }; return; }
        return;
      }
      if (G.ed.tool === 'line' || G.ed.tool === 'arc') {
        const sp = snapPointFor(w, tol);
        if (sp) { G.trace = { kind: G.ed.tool, p1: sp, p2: sp, b: null, phase: 1 }; gesture = { type: 'trace', id: id }; return; }
      }
      if (G.ed.tool === 'build' && G.ed.startDrag(w[0], w[1], tol)) { gesture = { type: 'build', id: id }; return; }
      if (G.ed.tool === 'delete' && G.ed.beamAt(w[0], w[1], tol) >= 0) {
        G.ed.beginErase();
        if (G.ed.eraseAt(w[0], w[1], tol)) sound('delete');
        gesture = { type: 'erase', id: id };
        return;
      }
      if (G.ed.tool === 'foundation') { gesture = { type: 'found', id: id }; updateFoundationGhost(w); return; }     // drag the ghost, release to plant
      if (G.ed.tool !== 'build') { gesture = { type: 'gtap', id: id }; return; }       // split / phases / delete foundation
    } else if (view === 'editor' && E.level) {
      if (editorPointerDown(id, w, tol)) return;
      gesture = { type: 'tap', id: id };
      return;
    }
    gesture = { type: 'pan', id: id };
  }
  function beginPinch() {
    if (gesture) {
      if (gesture.type === 'build' && G.ed) G.ed.cancelDrag();
      else if (gesture.type === 'erase' && G.ed) G.ed.endErase();
      else if (gesture.type === 'vertex') finishVertexDrag();
      else if (gesture.type === 'selmove') G.moveGhost = null;
      else if (gesture.type === 'trace') G.trace = null;
    }
    const ids = Array.from(pointers.keys()).slice(0, 2);
    const a = pointers.get(ids[0]), b = pointers.get(ids[1]);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    gesture = { type: 'pinch', ids: ids, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: cam.zoom, w0: s2w(cam, mid[0], mid[1]) };
    G.hoverNode = null;
  }
  function onPointerMove(e) {
    if (!canvasActive()) { pointers.clear(); gesture = null; return; }
    const p = localPos(e);
    const pt = pointers.get(e.pointerId);
    if (!pt) { if (e.pointerType === 'mouse') hover(p); return; }
    const dx = p[0] - pt.x, dy = p[1] - pt.y;
    pt.x = p[0]; pt.y = p[1];
    if (!pt.moved && Math.hypot(p[0] - pt.x0, p[1] - pt.y0) > (pt.type === 'mouse' ? 4 : 8)) pt.moved = true;
    if (!gesture) return;
    const w = s2w(cam, p[0], p[1]);
    switch (gesture.type) {
      case 'build':
        if (gesture.id === e.pointerId && G.ed) { G.ed.moveDrag(w[0], w[1]); updateCost(); }
        break;
      case 'erase':
        if (gesture.id === e.pointerId && G.ed && G.ed.eraseAt(w[0], w[1], tolFor(pt.type))) sound('delete');
        break;
      case 'pan':
        if (gesture.id === e.pointerId) {
          const wa = s2w(cam, p[0] - dx, p[1] - dy), wb = s2w(cam, p[0], p[1]);
          cam.x += wa[0] - wb[0]; cam.y += wa[1] - wb[1];
          clampCam();
          camIsFit = false;
        }
        break;
      case 'pinch': {
        const a = pointers.get(gesture.ids[0]), b = pointers.get(gesture.ids[1]);
        if (!a || !b) break;
        const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        cam.zoom = camLim ? clamp(gesture.z0 * d / gesture.d0, camLim.zMin, camLim.zMax) : gesture.z0 * d / gesture.d0;
        for (let it = 0; it < 3; it++) {
          const wm = s2w(cam, mid[0], mid[1]);
          cam.x += gesture.w0[0] - wm[0]; cam.y += gesture.w0[1] - wm[1];
        }
        clampCam();
        camIsFit = false;
        break;
      }
      case 'tap':
        if (gesture.id === e.pointerId && pt.moved) {
          gesture = { type: 'pan', id: e.pointerId };
          const wa = s2w(cam, pt.x0, pt.y0), wb = s2w(cam, p[0], p[1]);
          cam.x += wa[0] - wb[0]; cam.y += wa[1] - wb[1]; clampCam(); camIsFit = false;
        }
      break;
      case 'found':
        if (gesture.id === e.pointerId) updateFoundationGhost(w);
        break;
      case 'box':
        if (gesture.id === e.pointerId) { gesture.x1 = w[0]; gesture.y1 = w[1]; }
        break;
      case 'selmove':
        if (gesture.id === e.pointerId && G.ed) {
          const dx = Math.round(w[0] - gesture.w0[0]), dy = Math.round(w[1] - gesture.w0[1]);
          gesture.dx = dx; gesture.dy = dy; if (dx || dy) gesture.moved = true;
          G.moveGhost = (dx || dy) ? G.ed.previewMove(dx, dy) : null;
        }
        break;
      case 'trace':
        if (gesture.id === e.pointerId && G.trace) { const sp = snapPointFor(w, tolFor(pt.type)); if (sp) G.trace.p2 = sp; }
        break;
      case 'arcb':
        if (gesture.id === e.pointerId && G.trace) { const sp = snapPointFor(w, tolFor(pt.type)); if (sp) G.trace.b = sp; }
        break;
      case 'paste':
        if (gesture.id === e.pointerId) pasteTo(w);
        break;
      case 'gtap':
        if (gesture.id === e.pointerId && pt.moved) {
          gesture = { type: 'pan', id: e.pointerId };
          const wa = s2w(cam, pt.x0, pt.y0), wb = s2w(cam, p[0], p[1]);
          cam.x += wa[0] - wb[0]; cam.y += wa[1] - wb[1]; clampCam(); camIsFit = false;
        }
        break;
      case 'vertex':
        if (gesture.id === e.pointerId) moveVertexDrag(w);
        break;
      case 'edrag':
        if (gesture.id === e.pointerId) { gesture.x1 = Math.round(w[0]); gesture.y1 = Math.round(w[1]); }
        break;
      default: break;
    }
  }
  function onPointerUp(e) {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    const cancelled = e.type === 'pointercancel';
    if (!gesture) return;
    const g = gesture;
    switch (g.type) {
      case 'build':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (cancelled || !G.ed) { if (G.ed) G.ed.cancelDrag(); break; }
        if (G.ed.endDrag()) sound('place');
        else if (G.ed.lastError) { sound('error'); toast(G.ed.lastError, 'warn'); }
        updateCost();
        break;
      case 'erase':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (G.ed) G.ed.endErase();
        break;
      case 'pan':
        if (g.id === e.pointerId) { gesture = null; canvas.style.cursor = ''; }
        break;
      case 'pinch': {
        // continue panning with the finger that is still down (no accidental building)
        const rest = Array.from(pointers.keys());
        gesture = rest.length ? { type: 'pan', id: rest[0] } : null;
        break;
      }
      case 'tap':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && !pt.moved && view === 'editor') editorTap(s2w(cam, pt.x, pt.y), tolFor(pt.type));
        break;
      case 'box':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && G.ed && G.mode === 'build') {
          if (!pt.moved) { if (!g.add) G.ed.clearSelection(); }
          else { const n = G.ed.selectBox(g.x0, g.y0, g.x1, g.y1, g.add ? 'add' : 'replace'); if (!n && !g.add) toast('Im Rahmen liegt kein ganzes Teil – ziehe ihn größer.', 'info'); }
        }
        break;
      case 'selmove':
        if (g.id !== e.pointerId) break;
        gesture = null;
        G.moveGhost = null;
        if (!cancelled && G.ed && G.mode === 'build' && g.moved && (g.dx || g.dy)) selResult(G.ed.moveSelection(g.dx, g.dy));
        break;
      case 'trace':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (cancelled || !G.trace) { G.trace = null; break; }
        if (G.trace.p1[0] === G.trace.p2[0] && G.trace.p1[1] === G.trace.p2[1]) { G.trace = null; break; }
        if (G.trace.kind === 'line') commitTrace();
        else { G.trace.phase = 2; G.trace.b = defaultBulge(G.trace); toast('Bogen: Ziehe oder tippe die Wölbung. Mit Loslassen wird der Bogen gesetzt.', 'info'); }
        break;
      case 'arcb':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && G.trace) commitTrace(); else G.trace = null;
        break;
      case 'paste':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && g.mouse && !pt.moved) commitPaste();
        break;
      case 'found':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && G.ed && G.mode === 'build' && view === 'game') {
          const spot = G.ed.foundationSpot(s2w(cam, pt.x, pt.y)[0]);
          if (spot.ok) { const r = G.ed.placeFoundation(spot.x); if (r.ok) { sound('place'); updateCost(); } else { sound('error'); toast(r.reason, 'warn'); } }
          else { sound('error'); toast(spot.reason || 'Hier geht kein Fundament.', 'warn'); }
        }
        G.hoverFoundation = null;
        break;
      case 'gtap':
        if (g.id !== e.pointerId) break;
        gesture = null;
        if (!cancelled && !pt.moved && view === 'game' && G.ed && G.mode === 'build') gameTap(s2w(cam, pt.x, pt.y), tolFor(pt.type));
        break;
      case 'vertex':
        if (g.id !== e.pointerId) break;
        finishVertexDrag();
        gesture = null;
        break;
      case 'edrag':
        if (g.id !== e.pointerId) break;
        gesture = null; E.drag = null;
        if (!cancelled) finishEditorDrag(g, pt, s2w(cam, pt.x, pt.y), tolFor(pt.type));
        break;
      default: gesture = null;
    }
  }
  function hover(p) {
    if (gesture) return;
    const w = s2w(cam, p[0], p[1]);
    const tol = tolFor('mouse');
    let cursor = '';
    if (view === 'game' && G.ed && G.mode === 'build') {
      if (G.paste) { pasteTo(w); canvas.style.cursor = 'copy'; return; }
      if (G.trace && G.trace.kind === 'arc' && G.trace.phase === 2) { const sp = snapPointFor(w, tol); if (sp) G.trace.b = sp; canvas.style.cursor = 'crosshair'; return; }
      if (G.ed.tool === 'select') { const bi = G.ed.beamAt(w[0], w[1], tol); cursor = bi >= 0 ? (G.ed.isSelected(bi) ? 'move' : 'pointer') : 'crosshair'; G.hoverNode = null; G.deleteHighlight = null; }
      else if (G.ed.tool === 'line' || G.ed.tool === 'arc') { const sp = snapPointFor(w, tol); G.hoverNode = sp ? [sp[0], sp[1]] : null; G.deleteHighlight = null; cursor = 'crosshair'; }
      else if (G.ed.tool === 'build') {
        const n = G.ed.nodeAt(w[0], w[1], tol);
        G.hoverNode = n ? [n.x, n.y] : null;
        G.deleteHighlight = null;
        if (n) cursor = 'crosshair';
      } else if (G.ed.tool === 'foundation') {
        updateFoundationGhost(w);
        G.hoverNode = null; G.deleteHighlight = null;
        cursor = 'crosshair';
      } else if (G.ed.tool === 'split' || G.ed.tool === 'phase') {
        const n = G.ed.nodeAt(w[0], w[1], tol);
        G.hoverNode = G.ed.tool === 'split' && n && !n.anchor ? [n.x, n.y] : null;
        const i = G.ed.tool === 'phase' ? G.ed.beamAt(w[0], w[1], tol) : -1;
        G.deleteHighlight = null;
        if (G.hoverNode || (i >= 0 && isHydKey(G.ed.bridge.beams[i].m))) cursor = 'pointer';
      } else {
        const i = G.ed.beamAt(w[0], w[1], tol);
        G.deleteHighlight = i >= 0 ? i : null;
        G.hoverNode = null;
        if (i >= 0) cursor = 'pointer';
      }
    } else if (view === 'editor' && E.level) {
      const LT = BB.Editor.levelTools;
      E.hoverVertex = null; E.hoverAnchor = null;
      if (E.tool === 'terrain' || E.tool === 'erase') {
        const vi = LT.vertexAt(E.level, w[0], w[1], tol);
        if (vi >= 0) { E.hoverVertex = vi; cursor = 'pointer'; }
        else if (E.tool === 'terrain' && LT.edgeAt(E.level, w[0], w[1], tol) >= 0) cursor = 'copy';
      }
      if (E.tool === 'anchor' || E.tool === 'erase') {
        const ai = LT.anchorAt(E.level, w[0], w[1], tol);
        if (ai >= 0) { E.hoverAnchor = E.level.anchors[ai]; cursor = 'pointer'; }
        else if (E.tool === 'anchor') { E.hoverAnchor = [Math.round(w[0]), Math.round(w[1])]; cursor = 'crosshair'; }
      }
    }
    canvas.style.cursor = cursor;
  }
  function onWheel(e) {
    if (!canvasActive()) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
    dy = clamp(dy, -300, 300);
    const p = localPos(e);
    zoomAt(p[0], p[1], Math.exp(-dy * 0.0016));
  }

  /** Ghost of the foundation under the pointer: snapped to the grid in x and to the ground in y; green when valid, red when not. */
  function updateFoundationGhost(w) {
    if (!G.ed || G.ed.tool !== 'foundation') { G.hoverFoundation = null; return; }
    const sp = G.ed.foundationSpot(w[0]);
    G.hoverFoundation = sp.y === null ? null : [sp.x, sp.y, sp.ok, sp.reason, sp.surf];
  }
  // --- taps of the building tools (foundation, split joint, hydraulic phases, remove foundation) ---
  function gameTap(w, tol) {
    const tool = G.ed.tool;
    if (tool === 'split') {
      const r = G.ed.toggleSplit(w[0], w[1], tol * 1.3);
      if (r.ok) sound('place'); else { sound('error'); toast(r.reason, 'warn'); }
    } else if (tool === 'phase') {
      const i = G.ed.beamAt(w[0], w[1], tol * 1.2);
      if (i >= 0 && isHydKey(G.ed.bridge.beams[i].m)) openPhaseModal(i);
      else { sound('error'); toast('Tippe auf einen Hydraulik-Kolben.', 'warn'); }
    } else if (tool === 'delete') {
      const fi = G.ed.foundationAt(w[0], w[1], tol * 1.4);
      if (fi >= 0 && G.ed.removeFoundation(fi)) { sound('delete'); updateCost(); }
    }
  }
  const PHASE_LABELS = [['hold', 'Halten'], ['out', 'Ausfahren'], ['in', 'Einfahren']];
  /** Dialog for the phases of one hydraulic beam: what it does in phase 1, 2, 3, 4. */
  function openPhaseModal(i) {
    const bm = G.ed.bridge.beams[i];
    const nPh = BB.HYD_PHASES || 4;
    const cur = (Array.isArray(bm.ph) ? bm.ph : ['hold', 'out']).slice();
    while (cur.length < nPh) cur.push('hold');
    const node = el('div', 'phase-editor');
    node.appendChild(el('p', 'help-note', 'Phase 1 gilt beim Start. Die nächste Phase beginnt, wenn ein Fahrzeug einen <b>Kontrollpunkt</b> überfährt – oder du tippst während der Testfahrt auf den Phasen-Knopf.'));
    const rows = [];
    for (let ph = 0; ph < nPh; ph++) {
      const row = el('div', 'phase-row');
      row.appendChild(el('span', 'phase-name', 'Phase ' + (ph + 1)));
      const seg = el('div', 'seg');
      PHASE_LABELS.forEach((pl) => {
        const b = el('button', pl[0] === cur[ph] ? 'on' : '', pl[1]);
        b.type = 'button';
        b.addEventListener('click', () => { cur[ph] = pl[0]; $$('button', seg).forEach((x) => x.classList.toggle('on', x === b)); });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      node.appendChild(row); rows.push(seg);
    }
    openModal({
      title: 'Hydraulik-Phasen', icon: 'hydraulic', node,
      buttons: [
        { label: 'Fertig', kind: 'green', icon: 'check', action: () => { let last = cur.length; while (last > 2 && cur[last - 1] === 'hold') last--; G.ed.setBeamPhases(i, cur.slice(0, last)); sound('place'); } },
        { label: 'Abbrechen', kind: 'white' },
      ],
    });
  }

  // --- level editor pointer handling --------------------------------------------
  function editorPointerDown(id, w, tol) {
    if (['zone', 'prebuilt', 'piston', 'ship'].indexOf(E.tool) >= 0) {
      const gx = Math.round(w[0]), gy = Math.round(w[1]);
      gesture = { type: 'edrag', id: id, tool: E.tool, x0: gx, y0: gy, x1: gx, y1: gy, before: editorSnapshot() };
      E.drag = gesture;
      return true;
    }
    if (E.tool !== 'terrain') return false;
    const LT = BB.Editor.levelTools;
    const before = editorSnapshot();
    let vi = LT.vertexAt(E.level, w[0], w[1], tol);
    if (vi < 0) {
      const ins = LT.insertVertex(E.level, w[0], w[1], tol * 0.8);
      if (ins) vi = ins.index;
    }
    if (vi < 0) return false;
    gesture = { type: 'vertex', id: id, index: vi, before: before };
    E.hoverVertex = vi;
    return true;
  }
  function moveVertexDrag(w) {
    if (!gesture || gesture.type !== 'vertex') return;
    BB.Editor.levelTools.moveVertex(E.level, gesture.index, w[0], w[1], true);
  }
  function finishVertexDrag() {
    if (!gesture || gesture.type !== 'vertex') return;
    const before = gesture.before;
    E.hoverVertex = null;
    if (editorSnapshot() !== before) { commitEditorChange(before); sound('place'); }
  }
  // ---- new level elements: build zones, prebuilt parts, pistons, ships, checkpoints
  function lvlList(name) { if (!Array.isArray(E.level[name])) E.level[name] = []; return E.level[name]; }
  function groundY(x) { return BB.Terrain.surfaceY(E.level.ground, x); }
  function addAnchorIfMissing(x, y) {
    const a = lvlList('anchors');
    if (!a.some((p) => p[0] === x && p[1] === y)) a.push([x, y]);
  }
  function finishEditorDrag(g, pt, w, tol) {
    const L = E.level, before = g.before, tool = g.tool;
    const moved = pt.moved && (g.x0 !== g.x1 || g.y0 !== g.y1);
    let changed = false, msg = null;
    if (tool === 'zone') {
      if (!moved) {                                   // tap: remove the zone under the finger
        const zs = L.zones || [], i = zs.findIndex((z) => w[0] >= z.x0 && w[0] <= z.x1 && w[1] >= z.y0 && w[1] <= z.y1);
        if (i >= 0) { zs.splice(i, 1); if (!zs.length) delete L.zones; changed = true; sound('delete'); }
      } else {
        const x0 = Math.min(g.x0, g.x1), x1 = Math.max(g.x0, g.x1), y0 = Math.min(g.y0, g.y1), y1 = Math.max(g.y0, g.y1);
        if (x1 - x0 < 1 || y1 - y0 < 1) msg = 'Die Zone ist zu klein.';
        else if (lvlList('zones').length >= 12) msg = 'Mehr als 12 Zonen sind nicht möglich.';
        else { L.zones.push({ x0: x0, y0: y0, x1: x1, y1: y1 }); changed = true; sound('place'); }
      }
    } else if (tool === 'prebuilt') {
      const list = (L.prebuilt && L.prebuilt.beams) || [];
      if (!moved) {
        let best = -1, bd = tol * 1.3;
        list.forEach((b, i) => { const d = distSeg(w[0], w[1], b.x1, b.y1, b.x2, b.y2); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { list.splice(best, 1); if (!list.length) delete L.prebuilt; changed = true; sound('delete'); }
      } else {
        const kind = PB_KINDS[E.pbKind] || PB_KINDS.road, m = kind[0], len = Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
        const md = matDef(m);
        if (md && len > md.maxLength + 1e-9) msg = 'Zu lang für dieses Teil (höchstens ' + fmtDec(md.maxLength) + ' m).';
        else if (list.length >= 80) msg = 'Mehr als 80 vorgebaute Teile sind nicht möglich.';
        else {
          if (!L.prebuilt) L.prebuilt = { beams: [] };
          const nb = { x1: g.x0, y1: g.y0, x2: g.x1, y2: g.y1, m: m };
          if (kind[1]) { nb.o = 1; addAnchorIfMissing(g.x0, g.y0); addAnchorIfMissing(g.x1, g.y1); }
          L.prebuilt.beams.push(nb); changed = true; sound('place');
        }
      }
    } else if (tool === 'piston') {
      const ps = lvlList('pistons');
      if (!moved) {
        const i = ps.findIndex((p) => { const rad = (p.angleDeg || 0) * Math.PI / 180, len = isFinite(p.startLen) ? p.startLen : p.minLen; return distSeg(w[0], w[1], p.pivotX, p.pivotY, p.pivotX + Math.cos(rad) * len, p.pivotY + Math.sin(rad) * len) < tol * 1.4; });
        if (i >= 0) { openPistonModal(i); return; }
      } else {
        const dx = g.x1 - g.x0, dy = g.y1 - g.y0, len = Math.hypot(dx, dy);
        if (len < 1) msg = 'Der Kolben ist zu kurz.';
        else if (len > 12) msg = 'Der Kolben ist zu lang (höchstens 12 m).';
        else if (ps.length >= 8) msg = 'Mehr als 8 Kolben sind nicht möglich.';
        else {
          const id = 'P' + (ps.length + 1) + '-' + Date.now().toString(36).slice(-3);
          ps.push({ id: id, pivotX: g.x0, pivotY: g.y0, angleDeg: Math.atan2(dy, dx) * 180 / Math.PI, minLen: Math.max(1, Math.round(len * 0.5)), maxLen: len, startLen: len, speed: 1.5, phaseActions: ['hold', 'in', 'out'] });
          addAnchorIfMissing(g.x0, g.y0); addAnchorIfMissing(g.x1, g.y1);
          changed = true; sound('place');
        }
      }
    } else if (tool === 'ship') {
      const gs = gateList();
      const wy = isFinite(L.water) ? L.water : null;
      if (!moved) {
        const i = gs.findIndex((gt) => w[0] >= gt.x0 && w[0] <= gt.x1 && w[1] >= gt.y0 - 1 && w[1] <= gt.y1 + 1);
        if (i >= 0) { openGateModal(i); return; }
      } else if (Math.abs(g.x1 - g.x0) < 2) msg = 'Die Durchfahrt ist zu schmal.';
      else if (gs.length >= 6) msg = 'Mehr als 6 Durchfahrten sind nicht möglich.';
      else {
        const x0 = Math.min(g.x0, g.x1), x1 = Math.max(g.x0, g.x1);
        if (wy !== null) gs.push({ kind: 'ship', x0: x0, x1: x1, y0: wy - 0.5, y1: wy + 5, t: 6, openPhase: 1, closePhase: 2 });
        else { const gy = groundY((x0 + x1) / 2); gs.push({ kind: 'truck', x0: x0, x1: x1, y0: gy, y1: gy + 4.5, t: 6 }); }
        changed = true; sound('place');
      }
    }
    if (msg) { sound('error'); toast(msg, 'warn'); }
    if (changed) { commitEditorChange(before); buildEditorPanel(); }
  }
  function distSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }
  function stepRow(container, title, sub, value, min, max, step, fmt, onChange) {
    const s2 = makeStepper(value, min, max, step, fmt, onChange);
    container.appendChild(paramRow('gear', title, sub, s2.el));
  }
  function openPistonModal(i) {
    const p = E.level.pistons[i];
    const node = el('div', 'phase-editor');
    const cur = p.phaseActions.slice();
    while (cur.length < 4) cur.push('hold');
    stepRow(node, 'Hub', 'Wie weit der Kolben ausfährt', Math.round((p.maxLen - p.minLen) * 10) / 10, 1, 8, 0.5, (v) => fmtDec(v) + ' m', (v) => { p.maxLen = p.minLen + v; p.startLen = Math.min(p.maxLen, Math.max(p.minLen, p.startLen)); });
    stepRow(node, 'Tempo', 'Meter pro Sekunde', p.speed, 0.5, 4, 0.5, (v) => fmtDec(v) + ' m/s', (v) => { p.speed = v; });
    const startOut = el('div', 'phase-row');
    startOut.appendChild(el('span', 'phase-name', 'Start'));
    const seg0 = el('div', 'seg');
    [['in', 'Eingefahren'], ['out', 'Ausgefahren']].forEach((pl) => {
      const b = el('button', ((pl[0] === 'in') === (p.startLen <= p.minLen + 1e-6)) ? 'on' : '', pl[1]); b.type = 'button';
      b.addEventListener('click', () => { p.startLen = pl[0] === 'in' ? p.minLen : p.maxLen; $$('button', seg0).forEach((x) => x.classList.toggle('on', x === b)); });
      seg0.appendChild(b);
    });
    startOut.appendChild(seg0); node.appendChild(startOut);
    for (let ph = 0; ph < 4; ph++) {
      const row = el('div', 'phase-row');
      row.appendChild(el('span', 'phase-name', 'Phase ' + (ph + 1)));
      const seg = el('div', 'seg');
      PHASE_LABELS.forEach((pl) => {
        const b = el('button', pl[0] === cur[ph] ? 'on' : '', pl[1]); b.type = 'button';
        b.addEventListener('click', () => { cur[ph] = pl[0]; $$('button', seg).forEach((x) => x.classList.toggle('on', x === b)); });
        seg.appendChild(b);
      });
      row.appendChild(seg); node.appendChild(row);
    }
    const before = editorSnapshot();
    openModal({
      title: 'Kolben', icon: 'hydraulic', node,
      buttons: [
        { label: 'Fertig', kind: 'green', icon: 'check', action: () => {
          let last = cur.length; while (last > 1 && cur[last - 1] === 'hold') last--;
          p.phaseActions = cur.slice(0, Math.max(1, last));
          const rad = p.angleDeg * Math.PI / 180, hx = Math.round(p.pivotX + Math.cos(rad) * p.startLen), hy = Math.round(p.pivotY + Math.sin(rad) * p.startLen);
          addAnchorIfMissing(hx, hy);
          commitEditorChange(before); buildEditorPanel();
        } },
        { label: 'Löschen', kind: 'red', icon: 'trash', action: () => { E.level.pistons.splice(i, 1); if (!E.level.pistons.length) delete E.level.pistons; commitEditorChange(before); buildEditorPanel(); } },
        { label: 'Abbrechen', kind: 'white', action: () => { E.level.pistons[i] = JSON.parse(JSON.stringify(JSON.parse(before).level.pistons[i])); } },
      ],
    });
  }
  /** The level's gate list; old levels with sideways `ships` are converted once when they are edited. */
  function gateList() {
    const L = E.level;
    if (!Array.isArray(L.gates)) {
      L.gates = (L.ships && BB.Gates ? BB.Gates.of(L) : []).map((g) => ({ kind: g.kind, x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, t: Math.round(g.t * 10) / 10 }));
      delete L.ships;
    }
    return L.gates;
  }
  function openGateModal(i) {
    const L = E.level, gt = L.gates[i];
    const before = editorSnapshot();
    const node = el('div', 'phase-editor');
    const base = () => (gt.kind === 'ship' && isFinite(L.water) ? L.water : gt.y0);
    const kindRow = el('div', 'phase-row'); kindRow.appendChild(el('span', 'phase-name', 'Art'));
    const kseg = el('div', 'seg');
    [['ship', 'Schiff'], ['truck', 'LKW'], ['train', 'Zug']].forEach((pl) => {
      const b = el('button', pl[0] === gt.kind ? 'on' : '', pl[1]); b.type = 'button';
      b.addEventListener('click', () => { const h = gt.y1 - base(); gt.kind = pl[0]; gt.y1 = base() + h; $$('button', kseg).forEach((x) => x.classList.toggle('on', x === b)); });
      kseg.appendChild(b);
    });
    kindRow.appendChild(kseg); node.appendChild(kindRow);
    stepRow(node, 'Durchfahrtshöhe', 'Wie hoch das Fahrzeug über Wasser bzw. Straße ist', Math.round((gt.y1 - base()) * 2) / 2, 2, 12, 0.5, (v) => fmtDec(v) + ' m', (v) => { gt.y1 = base() + v; });
    stepRow(node, 'Ankunft', 'Sekunden, bis es die Brücke erreicht', Math.round(gt.t || 0), 2, 40, 1, (v) => v + ' s', (v) => { gt.t = v; });
    const ph = (v) => (v === 0 ? 'keine' : 'Phase ' + v);
    stepRow(node, 'Öffnet Phase', 'Die Hydraulik wechselt zu dieser Phase, sobald es in Sicht kommt', gt.openPhase === undefined || gt.openPhase === null ? 0 : gt.openPhase + 1, 0, 4, 1, ph, (v) => { if (v === 0) { delete gt.openPhase; } else gt.openPhase = v - 1; });
    stepRow(node, 'Schließt Phase', 'Die Hydraulik wechselt dazu, wenn es vorbei ist', gt.closePhase === undefined || gt.closePhase === null ? 0 : gt.closePhase + 1, 0, 4, 1, ph, (v) => { if (v === 0) { delete gt.closePhase; } else gt.closePhase = v - 1; });
    const hrow = el('div', 'phase-row'); hrow.appendChild(el('span', 'phase-name', 'Verkehr wartet'));
    const hseg = el('div', 'seg');
    [[false, 'Nein'], [true, 'Ja']].forEach((pl) => {
      const on = pl[0] === (gt.hold === undefined ? (gt.openPhase !== undefined && gt.openPhase !== null) : !!gt.hold);
      const b = el('button', on ? 'on' : '', pl[1]); b.type = 'button';
      b.addEventListener('click', () => { gt.hold = pl[0]; $$('button', hseg).forEach((x) => x.classList.toggle('on', x === b)); });
      hseg.appendChild(b);
    });
    hrow.appendChild(hseg); node.appendChild(hrow);
    openModal({
      title: 'Durchfahrt', icon: 'ship', node,
      buttons: [
        { label: 'Fertig', kind: 'green', icon: 'check', action: () => { commitEditorChange(before); buildEditorPanel(); } },
        { label: 'Löschen', kind: 'red', icon: 'trash', action: () => { L.gates.splice(i, 1); if (!L.gates.length) delete L.gates; commitEditorChange(before); buildEditorPanel(); } },
        { label: 'Abbrechen', kind: 'white', action: () => { L.gates[i] = JSON.parse(before).level.gates[i]; } },
      ],
    });
  }
  function openCheckpointModal(i) {
    const cp = E.level.checkpoints[i];
    const before = editorSnapshot();
    const node = el('div', 'phase-editor');
    stepRow(node, 'Löst Phase aus', 'Die Hydraulik wechselt zu dieser Phase', cp.phase + 1, 1, 4, 1, (v) => 'Phase ' + v, (v) => { cp.phase = v - 1; });
    const nv = (E.level.vehicles || []).length;
    stepRow(node, 'Nur für Fahrzeug', '0 = das erste Fahrzeug, das vorbeikommt', cp.v === undefined ? 0 : cp.v + 1, 0, Math.max(1, nv), 1, (v) => (v === 0 ? 'beliebig' : 'Nr. ' + v), (v) => { if (v === 0) delete cp.v; else cp.v = v - 1; });
    openModal({
      title: 'Kontrollpunkt', icon: 'checkpoint', node,
      buttons: [
        { label: 'Fertig', kind: 'green', icon: 'check', action: () => { commitEditorChange(before); } },
        { label: 'Löschen', kind: 'red', icon: 'trash', action: () => { E.level.checkpoints.splice(i, 1); if (!E.level.checkpoints.length) delete E.level.checkpoints; commitEditorChange(before); } },
        { label: 'Abbrechen', kind: 'white', action: () => { E.level.checkpoints[i] = JSON.parse(before).level.checkpoints[i]; } },
      ],
    });
  }

  function editorTap(w, tol) {
    const LT = BB.Editor.levelTools, L = E.level;
    const before = editorSnapshot();
    let changed = false, msg = null;
    if (E.tool === 'anchor') {
      const ai = LT.anchorAt(L, w[0], w[1], tol);
      if (ai >= 0) { LT.deleteAnchor(L, ai); changed = true; sound('delete'); }
      else {
        const r = LT.toggleAnchor(L, w[0], w[1]);
        if (r.ok) { changed = true; sound(r.added ? 'place' : 'delete'); } else msg = r.reason;
      }
    } else if (E.tool === 'checkpoint') {
      const cps = L.checkpoints || [];
      const i = cps.findIndex((c) => Math.abs(c.x - w[0]) < tol * 1.4);
      if (i >= 0) { openCheckpointModal(i); return; }
      cps.length || (L.checkpoints = cps);
      if (cps.length >= 8) msg = 'Mehr als 8 Kontrollpunkte sind nicht möglich.';
      else { cps.push({ x: Math.round(w[0]), phase: Math.min(3, cps.length + 1) }); changed = true; sound('place'); }
    } else if (E.tool === 'erase') {
      const ai = LT.anchorAt(L, w[0], w[1], tol);
      if (ai >= 0) { LT.deleteAnchor(L, ai); changed = true; }
      else {
        const vi = LT.vertexAt(L, w[0], w[1], tol);
        if (vi >= 0) { if (LT.deleteVertex(L, vi)) changed = true; else msg = 'Dieser Geländepunkt kann nicht gelöscht werden'; }
      }
      if (changed) sound('delete');
    }
    if (msg) { sound('error'); toast(msg, 'warn'); }
    if (changed) { E.hoverVertex = null; E.hoverAnchor = null; commitEditorChange(before); }
  }


  // ===========================================================================
  // Test lab: short test levels per mechanic (BB.LAB). Nothing here ever touches the save game.
  // ===========================================================================
  const labResults = Object.create(null);     // key → { ok, status, maxStress } (this session only)
  let labRun = null;
  function labItems() { return Array.isArray(BB.LAB) ? BB.LAB : []; }
  function labTags(it) {
    let h = '<span class="lab-tag">' + esc(summarizeVehicles(it.level.vehicles, true) || '–') + '</span>';
    const r = labResults[it.key];
    if (it.known) h += '<span class="lab-tag known">bekannter Fehler: ' + esc(it.known) + '</span>';
    if (r) h += r.ok ? '<span class="lab-tag ok">Prüfung bestanden · ' + Math.round(r.maxStress * 100) + ' % Belastung</span>'
      : '<span class="lab-tag ' + (it.known ? 'known' : 'bad') + '">Prüfung: ' + esc(r.text || r.status) + '</span>';
    return h;
  }
  function renderLab() {
    const wrap = $('#lab-groups');
    if (!wrap) return;
    wrap.innerHTML = '';
    const groups = [];
    labItems().forEach((it) => { let g = groups.find((x) => x.name === it.group); if (!g) { g = { name: it.group, items: [] }; groups.push(g); } g.items.push(it); });
    if (!groups.length) { wrap.innerHTML = '<div class="card empty-state">' + icon('warn', 'big-ic') + '<p>Die Testlevel fehlen. Bitte lade die Seite neu.</p></div>'; return; }
    // v3.4: the model gallery – every model on a turntable (one row per model)
    if (BB.Gallery && BB.Gallery.items) {
      const gal = el('section', 'lab-group', '<h2>Modellgalerie</h2>');
      const gl = el('div', 'lab-list');
      BB.Gallery.items().forEach((it) => {
        const row = el('div', 'lab-item');
        row.innerHTML = '<div><h3>' + esc(it.name) + '</h3><p><b>Prüft:</b> Aussehen von der Seite und schräg, Räder, Beine und Ruder in Bewegung. Drehen mit dem Finger.</p><p><b>Epoche:</b> ' + esc(BB.Gallery.EPOCH_NAME[it.epoch] || it.epoch) + ' · ' + esc(it.group) + '</p></div>' +
          '<div class="lab-actions"><button type="button" class="btn btn-yellow btn-sm">' + icon('view') + '<span>Ansehen</span></button></div>';
        row.querySelector('button').addEventListener('click', () => BB.Gallery.open({ focus: it.key }));
        gl.appendChild(row);
      });
      gal.appendChild(gl);
      groups.push({ name: '__gallery', items: [], node: gal });
    }
    groups.forEach((g) => {
      if (g.node) { wrap.appendChild(g.node); return; }
      const sec = el('section', 'lab-group', '<h2>' + esc(g.name) + '</h2>');
      const list = el('div', 'lab-list');
      g.items.forEach((it) => {
        const row = el('div', 'lab-item');
        row.setAttribute('data-key', it.key);
        row.innerHTML = '<div><h3>' + esc(it.name) + '</h3><p><b>Prüft:</b> ' + esc(it.tests) + '</p><p><b>Erwartet:</b> ' + esc(it.expect) + '</p><div class="lab-flags">' + labTags(it) + '</div></div>' +
          '<div class="lab-actions"><button type="button" class="btn btn-yellow btn-sm">' + icon('play') + '<span>Öffnen</span></button></div>';
        row.querySelector('button').addEventListener('click', () => openLabTest(it));
        list.appendChild(row);
      });
      sec.appendChild(list);
      wrap.appendChild(sec);
    });
  }
  function updateLabRow(it) {
    const row = $('.lab-item[data-key="' + it.key + '"] .lab-flags');
    if (row) row.innerHTML = labTags(it);
  }
  function openLabTest(it) {
    openGame(jsonClone(it.level), { kind: 'lab', key: 'lab:' + it.key, returnTo: 'lab', index: -1, bridge: jsonClone(it.bridge) });
  }
  function cancelLabRun() { if (labRun) { labRun.cancelled = true; labRun = null; const b = $('#lab-check'); if (b) b.disabled = false; } }
  screenHooks.lab = { show() { setView('none'); renderLab(); }, hide() { cancelLabRun(); } };
  /** Runs every prebuilt test bridge through the physics (time-sliced) and reports which ones behave as stated. */
  function runLabCheck() {
    if (labRun) return;
    const items = labItems(), btn = $('#lab-check'), sum = $('#lab-summary');
    if (!items.length || !hasPhysics()) { sum.hidden = false; sum.textContent = 'Prüfung nicht möglich: Testlevel oder Physik fehlen.'; return; }
    const run = { cancelled: false };
    labRun = run; btn.disabled = true; sum.hidden = false; sum.textContent = 'Prüfe ' + items.length + ' Tests …';
    let i = 0, sim = null, pass = 0, bad = 0, known = 0;
    const next = () => {
      if (run.cancelled) return;
      if (i >= items.length) {
        labRun = null; btn.disabled = false;
        sum.textContent = pass + ' von ' + items.length + ' Tests bestanden' + (known ? ' · ' + known + ' bekannte Fehler' : '') + (bad ? ' · ' + bad + ' fehlgeschlagen' : ' – alles wie erwartet') + '.';
        return;
      }
      const it = items[i];
      if (!sim) {
        try { sim = BB.Physics.createSim(it.level, bridgeClone(it.bridge)); } catch (e) {
          warn('Testlabor', e); labResults[it.key] = { ok: false, status: 'error', text: 'Fehler beim Start', maxStress: 0 }; bad++; updateLabRow(it); i++; setTimeout(next, 0); return;
        }
      }
      const t0 = nowMs();
      try {
        while (sim.status === 'running' && sim.t < 300 && nowMs() - t0 < 25) { BB.Physics.step(sim); if (sim.events) sim.events.length = 0; }
      } catch (e) { warn('Testlabor', e); labResults[it.key] = { ok: false, status: 'error', text: 'Fehler in der Simulation', maxStress: 0 }; bad++; updateLabRow(it); sim = null; i++; setTimeout(next, 0); return; }
      if (sim.status === 'running' && sim.t < 300) { setTimeout(next, 0); return; }
      const sm = BB.Physics.summary(sim);
      const want = it.check || 'win';
      const ok = want === 'run' ? true : want === 'win' ? sim.status === 'won' : sim.status !== 'won';
      labResults[it.key] = { ok, status: sim.status, maxStress: sm.maxStress, text: ok ? '' : resultText(sim.reason) };
      if (ok) pass++; else if (it.known) known++; else bad++;
      updateLabRow(it);
      sim = null; i++;
      sum.textContent = 'Prüfe … ' + i + ' / ' + items.length;
      setTimeout(next, 0);
    };
    next();
  }

  // ===========================================================================
  // Debug display (settings → Debug-Anzeige): FPS, speed, stress numbers (also drawn on the beams)
  // ===========================================================================
  let dbgFps = 60;
  function updateDebugBox(dt) {
    const box = $('#g-debug');
    if (!box) return;
    const on = view === 'game' && !!getSetting('debugInfo');
    if (!on) { if (!box.hidden) box.hidden = true; return; }
    if (dt > 0) dbgFps += (1 / dt - dbgFps) * 0.08;
    box.hidden = false;
    let t = 'FPS ' + Math.round(dbgFps) + (R3D && R && R.is3d && R3D.resScale && R3D.resScale < 0.99 ? ' · Auflösung ' + Math.round(R3D.resScale * 100) + ' %' : '') + '\nAnsicht ' + (viewKind === 'blueprint' ? 'Architekt' : 'Szene');
    if (G.mode === 'test' && G.sim) {
      const sm = G.sim;
      let maxS = 0, broken = 0;
      (sm.beams || []).forEach((b) => { if (b.broken) broken++; else if (!b.debris && b.stress > maxS) maxS = b.stress; });
      t += '\nZeit ' + sm.t.toFixed(1) + ' s · Balken ' + (sm.beams || []).length + ' (gebrochen ' + broken + ')\nMax. Belastung ' + Math.round(maxS * 100) + ' %';
      (sm.vehicles || []).filter((v) => v && v.state !== 'waiting' && v.visible !== false && !v.removed && v.pose).forEach((v) => { t += '\n' + v.type + '  x ' + v.pose.x.toFixed(1) + ' m · ' + (v.speed || 0).toFixed(1) + ' m/s'; });
    } else if (G.ed) t += '\nBalken ' + G.ed.bridge.beams.length + ' · Kosten ' + fmtEuro(G.ed.cost());
    box.textContent = t;
  }

  // ===========================================================================
  // Frame loop
  // ===========================================================================
  let lastTs = 0, animTime = 0, loopErrors = 0;

  function buildScene() {
    if (view === 'game' && G.level && G.ed) {
      let hoverNode = G.hoverNode;
      if (G.ed.drag) {
        const p = G.ed.preview;
        const endNode = p ? G.ed.nodeAt(p.x2, p.y2, 0.01) : null;
        hoverNode = endNode ? [endNode.x, endNode.y] : [G.ed.drag.x, G.ed.drag.y];
      }
      const testing = G.mode === 'test' && !!G.sim;
      return {
        mode: testing ? 'test' : 'build', level: G.level, camera: cam, time: animTime,
        bridge: G.ed.bridge, sim: testing ? G.sim : null, showStress: !!G.showStress, showGrid: !testing && G.snapGrid, debug: !!getSetting('debugInfo'),
        chase: testing && G.chase, hoverFoundation: testing || G.ed.tool !== 'foundation' ? null : G.hoverFoundation,
        overlay: testing ? null : buildOverlay(), quick: testing || !G.quickOn ? null : G.quick,
        preview: testing ? null : G.ed.preview, hoverNode: testing ? null : hoverNode,
        deleteHighlight: testing || G.ed.tool !== 'delete' ? null : G.deleteHighlight, leveledit: null,
      };
    }
    if (view === 'editor' && E.level) {
      return {
        mode: 'leveledit', level: E.level, camera: cam, time: animTime, bridge: EMPTY_BRIDGE, sim: null,
        showStress: false, showGrid: true, preview: editorPreview(), hoverNode: E.hoverAnchor, deleteHighlight: null,
        leveledit: { hoverVertex: gesture && gesture.type === 'vertex' ? gesture.index : E.hoverVertex, tool: E.tool, rect: editorRect() },
      };
    }
    if (view === 'menu' && Menu.level) {
      return {
        mode: Menu.sim ? 'test' : 'build', level: Menu.level, camera: cam, time: animTime,
        bridge: Menu.bridge, sim: Menu.sim, showStress: false, showGrid: false,
        preview: null, hoverNode: null, deleteHighlight: null, leveledit: null,
      };
    }
    return null;
  }
  /** Selection, box, ghost of moved / pasted / traced parts for the renderers (see overlay.js). */
  function buildOverlay() {
    const ed = G.ed;
    if (!ed || G.mode !== 'build') return null;
    const ov = {}, bs = ed.bridge.beams;
    if (ed.sel.length) ov.sel = ed.sel.map((i) => { const b = bs[i]; return [b.x1, b.y1, b.x2, b.y2]; });
    if (gesture && gesture.type === 'box') ov.box = { x0: Math.min(gesture.x0, gesture.x1), x1: Math.max(gesture.x0, gesture.x1), y0: Math.min(gesture.y0, gesture.y1), y1: Math.max(gesture.y0, gesture.y1) };
    if (gesture && gesture.type === 'selmove' && G.moveGhost) {
      const gh = G.moveGhost;
      ov.ghost = { items: gh.items, label: gh.ok ? 'Δ ' + (gesture.dx >= 0 ? '+' : '') + gesture.dx + ' | ' + (gesture.dy >= 0 ? '+' : '') + gesture.dy + ' m' : (gh.reason || 'Passt nicht') };
    } else if (G.paste) {
      const pv = ed.previewPaste(G.paste.ox, G.paste.oy);
      ov.ghost = { items: pv.items, label: pv.ok ? 'Einfügen' : (pv.reason || 'Passt nicht') };
    } else if (G.trace) {
      const plan = tracePlan();
      if (plan && plan.items && plan.items.length) {
        let cost = 0;
        plan.items.forEach((it) => { if (it.valid && !it.skip) { const m = matDef(it.m); if (m) cost += m.price * Math.hypot(it.x2 - it.x1, it.y2 - it.y1); } });
        ov.ghost = { items: plan.items, label: plan.ok ? plan.count + ' Balken · ' + fmtEuro(Math.round(cost)) : (plan.reason || 'Passt nicht') };
        if (plan.center && plan.radius) {
          const g = [], a0 = Math.atan2(G.trace.p1[1] - plan.center[1], G.trace.p1[0] - plan.center[0]);
          for (let k = 0; k <= 72; k++) { const a = a0 + k * Math.PI * 2 / 72; g.push([plan.center[0] + plan.radius * Math.cos(a), plan.center[1] + plan.radius * Math.sin(a)]); }
          ov.guide = g;
        }
      }
      if (G.trace.kind === 'arc' && G.trace.phase === 2 && G.trace.b) ov.labels = [{ x: G.trace.b[0], y: G.trace.b[1] - 1.6, text: 'Wölbung', kind: 'info' }];
    }
    return Object.keys(ov).length ? ov : null;
  }
  function editorPreview() {
    const g = gesture && gesture.type === 'edrag' ? gesture : null;
    if (!g || g.tool === 'zone' || (g.x0 === g.x1 && g.y0 === g.y1)) return null;
    if (g.tool === 'ship') return { x1: g.x0, y1: g.y0, x2: g.x1, y2: g.y0, m: 'rope', valid: true, length: Math.abs(g.x1 - g.x0) };
    const m = g.tool === 'piston' ? 'hydraulic' : (PB_KINDS[E.pbKind] || PB_KINDS.road)[0];
    const len = Math.hypot(g.x1 - g.x0, g.y1 - g.y0), md = matDef(m);
    return { x1: g.x0, y1: g.y0, x2: g.x1, y2: g.y1, m: m, valid: !(md && g.tool === 'prebuilt' && len > md.maxLength), length: len };
  }
  function editorRect() {
    const g = gesture && gesture.type === 'edrag' && gesture.tool === 'zone' ? gesture : null;
    return g ? { x0: Math.min(g.x0, g.x1), y0: Math.min(g.y0, g.y1), x1: Math.max(g.x0, g.x1), y1: Math.max(g.y0, g.y1) } : null;
  }
  function drawScene() {
    const scene = buildScene();
    if (!scene) return;
    try {
      R.draw(scene);
      drawFailures = 0;
    } catch (e) {
      drawFailures++;
      warn('Zeichnen fehlgeschlagen', e);
      if (drawFailures > 5 && !usingFallbackRenderer) {
        warn('Wechsle auf die einfache Grafik');
        R = createFallbackRenderer(canvas);
        usingFallbackRenderer = true;
        drawFailures = 0;
      }
    }
  }
  function frame(ts) {
    requestAnimationFrame(frame);
    let dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    animTime += dt;
    try {
      updateCamTween(dt);
      if (view === 'game') updateGame(dt);
      else if (view === 'menu') updateMenu(dt);
      updateDebugBox(dt);
      if (view !== 'none') drawScene();
      loopErrors = 0;
    } catch (e) {
      loopErrors++;
      warn('Fehler in der Spielschleife', e);
    }
  }

  // ===========================================================================
  // Wiring of all static UI
  // ===========================================================================
  function on(sel, type, fn) { const e = $(sel); if (e) e.addEventListener(type, fn); }

  function wireUi() {
    // global button feedback: click sound (unless data-snd="none"), drop focus after pointer clicks
    doc.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      if (b.getAttribute('data-snd') !== 'none') sound('click');
      if (e.detail !== 0 && b.blur) b.blur();
    });
    $$('[data-go]').forEach((b) => b.addEventListener('click', () => showScreen(b.getAttribute('data-go'))));
    $$('.mute-btn').forEach((b) => b.addEventListener('click', toggleMute));

    // main menu
    on('#m-play', 'click', () => { const i = continueTarget(); if (i >= 0) openLevelByIndex(i); else showScreen('worlds'); });
    on('#m-worlds', 'click', () => showScreen('worlds'));
    on('#m-camp', 'click', () => showScreen('campaign'));
    on('#m-camp-pill', 'click', () => showScreen('campaign'));
    on('#m-lab', 'click', () => showScreen('lab'));
    on('#lab-sandbox', 'click', () => showScreen('sandbox'));
    on('#lab-check', 'click', runLabCheck);
    on('#m-editor', 'click', () => showScreen('custom'));
    on('#m-daily', 'click', () => openWeeklyChallenge());
    on('#m-settings', 'click', () => showScreen('settings'));
    on('#m-backup-now', 'click', () => doBackup((r) => { if (r && r.ok) $('#m-backup').hidden = true; }));

    // game HUD
    on('#g-back', 'click', leaveGame);
    on('#g-fit', 'click', () => fitView(true));
    on('#g-help', 'click', () => { closeMore(); showHelp(false); });
    on('#g-more', 'click', (e) => { e.stopPropagation(); const pop = $('#g-more-pop'); if (pop.hidden) openMore(); else closeMore(); });
    on('#g-more-sound', 'click', () => closeMore());
    on('#g-more-settings', 'click', () => { closeMore(); leaveToSettings(); });
    doc.addEventListener('pointerdown', (e) => { const pop = $('#g-more-pop'); if (pop && !pop.hidden && !(e.target.closest && (e.target.closest('#g-more-pop') || e.target.closest('#g-more')))) closeMore(); }, true);
    on('#g-hint-close', 'click', () => hideHint());
    on('#t-delete', 'click', toggleDeleteTool);
    on('#r-build', 'click', () => setTool('build'));
    on('#r-select', 'click', () => setTool('select'));
    on('#r-line', 'click', () => setTool('line'));
    on('#r-arc', 'click', () => setTool('arc'));
    on('#a-copy', 'click', selCopy); on('#a-cut', 'click', selCut); on('#a-paste', 'click', startPaste); on('#a-del', 'click', selDelete);
    on('#a-rotl', 'click', () => selRotate(15)); on('#a-rotr', 'click', () => selRotate(-15));
    on('#a-mirh', 'click', () => selMirror('h')); on('#a-mirv', 'click', () => selMirror('v'));
    on('#p-ok', 'click', commitPaste); on('#p-cancel', 'click', cancelPaste);
    on('#s-grid', 'click', toggleGrid); on('#s-stress', 'click', toggleQuick); on('#s-info', 'click', showLevelInfo); on('#s-hud', 'click', toggleHud); on('#hud-restore', 'click', toggleHud);
    on('#o-fill', 'click', () => { G.fill = !G.fill; $('#o-fill').setAttribute('aria-pressed', String(G.fill)); });
    if (window.ResizeObserver) { const bb = $('#bar-build'), gs = $('#screen-game'); if (bb && gs) new ResizeObserver(() => { gs.style.setProperty('--barh', Math.round(bb.getBoundingClientRect().height || 96) + 'px'); }).observe(bb); }
    $$('.view-btn').forEach((b) => b.addEventListener('click', toggleViewKind));
    on('#t-split', 'click', () => setTool('split'));
    on('#t-phasetool', 'click', () => setTool('phase'));
    on('#t-pause', 'click', togglePause);
    on('#t-replay', 'click', () => { if (G.mode === 'test') replayTest(); });
    on('#t-cam', 'click', () => { G.chase = !G.chase; setSetting('chaseCam', G.chase); updateCamButton(); });
    const seekEl = $('#t-seek');
    if (seekEl) {
      seekEl.addEventListener('input', () => {
        G.seeking = true;
        const total = Math.max(G.runLen || 0, G.sim ? G.sim.t : 0, 1);
        $('#t-time').textContent = fmtTime(total * seekEl.value / 1000);
      });
      seekEl.addEventListener('change', () => {
        const total = Math.max(G.runLen || 0, G.sim ? G.sim.t : 0, 1);
        G.seeking = false;
        seekTo(total * seekEl.value / 1000);
      });
    }
    on('#t-undo', 'click', doUndo);
    on('#t-redo', 'click', doRedo);
    on('#t-clear', 'click', askClear);
    on('#t-test', 'click', startTest);
    on('#t-stop', 'click', stopTest);
    on('#t-phase', 'click', () => { if (G.sim && BB.Physics && BB.Physics.nextPhase && !$('#t-phase').classList.contains('static')) { BB.Physics.nextPhase(G.sim); updatePhaseButton(); sound('click'); } });
    $$('#speed-seg button').forEach((b) => b.addEventListener('click', () => { G.speed = parseFloat(b.getAttribute('data-speed')) || 1; updateSpeedButtons(); }));
    on('#t-stress', 'click', () => { G.showStress = !G.showStress; setSetting('showStress', G.showStress); updateStressButton(); });

    // sandbox & custom
    on('#sb-go', 'click', startSandbox);
    on('#c-new', 'click', () => openEditorNew('custom'));

    // level editor
    on('#e-back', 'click', editorBack);
    on('#e-fit', 'click', () => fitView(true));
    on('#e-help', 'click', showEditorHelp);
    on('#e-undo', 'click', editorUndo);
    on('#e-regen', 'click', askRegenerate);
    on('#e-save', 'click', () => editorSave());
    on('#e-test', 'click', editorTest);
    $$('#e-tools button').forEach((b) => b.addEventListener('click', () => setEditorTool(b.getAttribute('data-tool'))));
    const nameIn = $('#e-name');
    nameIn.addEventListener('input', () => { if (!E.level) return; E.level.name = nameIn.value.slice(0, 40); markEditorDirty(); });
    nameIn.addEventListener('change', () => { if (!E.level) return; E.level.name = nameIn.value.trim().slice(0, 40); nameIn.value = E.level.name; markEditorDirty(); });
    const budIn = $('#e-budget');
    const commitBudget = () => { if (!E.level) return; const v = parseBudget(budIn.value); if (v == null) budIn.value = fmtNum(E.level.budget); else setEditorBudget(v); };
    budIn.addEventListener('change', commitBudget);
    budIn.addEventListener('blur', commitBudget);
    budIn.addEventListener('focus', () => { budIn.value = String(E.level ? E.level.budget : ''); });
    holdRepeat($('#e-budget-minus'), () => { if (E.level) setEditorBudget(E.level.budget - 500); });
    holdRepeat($('#e-budget-plus'), () => { if (E.level) setEditorBudget(E.level.budget + 500); });
    [nameIn, budIn].forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); }));

    // settings
    on('#set-sound', 'click', toggleMute);
    on('#set-volume', 'input', (e) => { setSetting('volume', Math.max(0, Math.min(1, (+e.target.value || 0) / 100))); applyMute(); });
    on('#set-volume', 'change', () => sound('place'));
    on('#set-sfx', 'click', () => { setSetting('sfx', !(getSetting('sfx') !== false)); applyMute(); refreshSettings(); sound('place'); });
    on('#set-music', 'click', () => { setSetting('music', !getSetting('music')); applyMute(); refreshSettings(); });
    on('#set-tester', 'click', () => { setSetting('testerMode', !getSetting('testerMode')); refreshSettings(); toast(getSetting('testerMode') ? 'Tester-Modus Klassisch an: alle Welten offen, echter Fortschritt bleibt unverändert' : 'Tester-Modus Klassisch aus', 'info'); });
    on('#set-tester-zeit', 'click', () => { setSetting('testerModeZeit', !getSetting('testerModeZeit')); refreshSettings(); toast(getSetting('testerModeZeit') ? 'Tester-Modus Zeitreise an: alle Epochen offen, echter Fortschritt bleibt unverändert' : 'Tester-Modus Zeitreise aus', 'info'); });
    on('#set-debug', 'click', () => { setSetting('debugInfo', !getSetting('debugInfo')); refreshSettings(); });
    $$('#set-view button').forEach((b) => b.addEventListener('click', () => { setSetting('buildView', b.getAttribute('data-v') === 'scene' ? 'scene' : 'blueprint'); refreshSettings(); }));
    on('#set-chase', 'click', () => { setSetting('chaseCam', !getSetting('chaseCam')); refreshSettings(); });
    on('#set-3d', 'click', () => {
      const g = readGfx();
      const next = using3d ? '2d' : '3d';
      writeGfx(Object.assign({}, g, { mode: next }));
      sv('flush');
      openModal({
        title: 'Grafik wechseln', icon: 'gear', html: '<p>Das Spiel wird neu geladen und startet dann mit der ' + (next === '3d' ? '3D-Grafik' : 'klassischen 2D-Grafik') + '. Dein Spielstand bleibt erhalten.</p>',
        buttons: [{ label: 'Neu laden', kind: 'blue', icon: 'reset', action: () => { setTimeout(() => location.reload(), 80); } }, { label: 'Später', kind: 'white', action: () => { refreshSettings(); } }],
      });
    });
    $$('#set-quality button').forEach((b) => b.addEventListener('click', () => {
      const q = b.getAttribute('data-q');
      writeGfx(Object.assign({}, readGfx(), { quality: q }));
      setSetting('quality', q);
      try { if (R3D && R3D.setQuality) R3D.setQuality(q); } catch (e) { warn('Qualität', e); }
      refreshSettings();
    }));
    on('#set-stress', 'click', () => { setSetting('showStress', !(getSetting('showStress') !== false)); refreshSettings(); });
    on('#set-help', 'click', () => showHelp(false));
    on('#set-export', 'click', () => doBackup(() => refreshSettings()));
    on('#set-import', 'click', () => { const f = $('#set-import-file'); f.value = ''; f.click(); });
    on('#set-import-file', 'change', (e) => onImportFile(e.target));
    on('#set-selftest', 'click', runSelfTest);
    on('#set-reset', 'click', resetFlow);

    // canvas input
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointers.size) { G.hoverNode = null; G.deleteHighlight = null; E.hoverVertex = null; E.hoverAnchor = null; } });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => { G.spaceHeld = false; });
  }

  function openMore() {
    const pop = $('#g-more-pop'), b = $('#g-more');
    if (!pop || !b) return;
    const r = b.getBoundingClientRect();
    pop.hidden = false;
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.left = 'auto';
    pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    applyMute();
  }
  function closeMore() { const pop = $('#g-more-pop'); if (pop) pop.hidden = true; }
  /** From inside a level: settings are a page, so leave the level (the bridge is saved already) and come back through the menu. */
  function leaveToSettings() { leaveGame(); setTimeout(() => showScreen('settings'), 60); }

  function onKeyUp(e) {
    if (!(e.key === ' ' || e.key === 'Spacebar') || !G.spaceHeld) return;
    const used = G.spaceUsed;
    G.spaceHeld = false; G.spaceUsed = false;
    if (used || view !== 'game' || !G.ed || modalStack.length || isEditable(e.target)) return;
    if (G.mode === 'build') startTest(); else stopTest();
  }
  function onKeyDown(e) {
    if (isEditable(e.target)) return;
    const top = modalStack[modalStack.length - 1];
    if (top) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (top.opts.dismissable !== false) top.close();
        else if (top.opts.onEscape) top.opts.onEscape();
      }
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const isZ = k === 'z' || k === 'Z', isY = k === 'y' || k === 'Y';
    if (view === 'game' && G.ed) {
      const build = G.mode === 'build', kl = k.length === 1 ? k.toLowerCase() : k;
      if (ctrl && isZ && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (ctrl && (isY || (isZ && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (ctrl && build && kl === 'c') { e.preventDefault(); if (G.ed.selectionCount()) selCopy(); }
      else if (ctrl && build && kl === 'x') { e.preventDefault(); if (G.ed.selectionCount()) selCut(); }
      else if (ctrl && build && kl === 'v') { e.preventDefault(); startPaste(); }
      else if (ctrl && build && kl === 'a') { e.preventDefault(); if (G.ed.tool !== 'select') setTool('select'); G.ed.selectAll(); }
      else if (k === ' ' || k === 'Spacebar') {
        // tap = start / stop the test drive; hold + drag = move the view (see keyup)
        e.preventDefault();
        if (!e.repeat) { G.spaceHeld = true; G.spaceUsed = false; }
      } else if (build && !ctrl && !e.altKey && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); if (G.ed.selectionCount()) selDelete(); }
      else if (build && !ctrl && !e.altKey && k.indexOf('Arrow') === 0 && G.ed.selectionCount()) { e.preventDefault(); selNudge(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0); }
      else if (!ctrl && !e.altKey && kl === 'v') toggleViewKind();
      else if (!ctrl && !e.altKey && kl === 'h') toggleHud();
      else if (!ctrl && !e.altKey && kl === 'i') { if (G.hudOff) toggleHud(); showLevelInfo(); }
      else if (!ctrl && !e.altKey && kl === 'p' && G.mode === 'test') togglePause();
      else if (!ctrl && !e.altKey && kl === 'r' && G.mode === 'test') replayTest();
      else if (!ctrl && !e.altKey && kl === 'c' && G.mode === 'test') { G.chase = !G.chase; setSetting('chaseCam', G.chase); updateCamButton(); }
      else if (build && !ctrl && !e.altKey && kl === 'g') toggleGrid();
      else if (build && !ctrl && !e.altKey && kl === 't') toggleQuick();
      else if (build && !ctrl && !e.altKey && kl === 'b') setTool('build');
      else if (build && !ctrl && !e.altKey && kl === 's') setTool('select');
      else if (build && !ctrl && !e.altKey && kl === 'x') toggleDeleteTool();
      else if (build && !ctrl && !e.altKey && kl === 'l') setTool('line');
      else if (build && !ctrl && !e.altKey && kl === 'a') setTool('arc');
      else if (build && !ctrl && !e.altKey && kl === 'j' && !$('#t-split').hidden) setTool('split');
      else if (build && !ctrl && !e.altKey && kl === 'p' && !$('#t-phasetool').hidden) setTool('phase');
      else if (build && !ctrl && !e.altKey && kl === 'u') { if (G.ed.foundationAllowed()) selectMaterial('foundation'); else { sound('error'); toast('Fundamente sind in diesem Level nicht erlaubt.', 'warn'); } }
      else if (build && !ctrl && !e.altKey && kl === 'q') selRotate(15);
      else if (build && !ctrl && !e.altKey && kl === 'e') selRotate(-15);
      else if (build && !ctrl && !e.altKey && kl === 'f') selMirror(e.shiftKey ? 'v' : 'h');
      else if (build && !ctrl && !e.altKey && k === 'Enter') { if (G.paste) commitPaste(); else if (G.trace && G.trace.phase === 2) commitTrace(); }
      else if (build && !ctrl && !e.altKey && /^[0-9]$/.test(k)) {
        const mk = (G.matKeys || MAT_KEYS)[k === '0' ? 9 : parseInt(k, 10) - 1];
        if (mk) { if (G.ed.allowedMaterials().indexOf(mk) >= 0) selectMaterial(mk); else { sound('error'); toast(matDef(mk).name + ' ist in diesem Level nicht erlaubt.', 'warn'); } }
      } else if (k === 'Escape') {
        if (gesture && gesture.type === 'build') { G.ed.cancelDrag(); gesture = null; updateCost(); }
        else if (G.paste) cancelPaste();
        else if (G.trace) { G.trace = null; gesture = null; }
        else if (G.hudOff) toggleHud();
        else if (G.ed.selectionCount()) G.ed.clearSelection();
        else if (G.ed.tool !== 'build') setTool('build');
      }
    } else if (view === 'editor') {
      if (!ctrl && !e.altKey && (k === 'v' || k === 'V')) toggleViewKind();
      if (ctrl && isZ) { e.preventDefault(); editorUndo(); }
      else if (k === 'Escape' && gesture && gesture.type === 'vertex') {
        const before = gesture.before;
        gesture = null;
        const s = JSON.parse(before);
        E.level = s.level;
      }
    }
  }

  // ===========================================================================
  // iPad / iOS: no accidental zoom, scroll, selection or callouts
  // ===========================================================================
  function installGuards() {
    const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => doc.addEventListener(t, prevent, { passive: false }));
    doc.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 1) { prevent(e); return; }
      const t = e.target;
      if (!(t && t.closest && t.closest('.scroll'))) prevent(e);
    }, { passive: false });
    let lastTouchEnd = 0;
    doc.addEventListener('touchend', (e) => {
      const now = Date.now();
      const t = e.target;
      const interactive = t && t.closest && t.closest('button, input, textarea, select, label, a');
      if (now - lastTouchEnd < 350 && !interactive) prevent(e);       // double-tap zoom
      lastTouchEnd = now;
    }, { passive: false });
    doc.addEventListener('dblclick', prevent, { passive: false });
    doc.addEventListener('contextmenu', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
    doc.addEventListener('selectstart', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
    doc.addEventListener('wheel', (e) => { if (e.ctrlKey) prevent(e); }, { passive: false });   // browser zoom via ctrl+wheel / trackpad pinch
    window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); }, { passive: true });
    doc.addEventListener('focusout', () => { setTimeout(() => { if (!isEditable(doc.activeElement) && (window.scrollX || window.scrollY)) window.scrollTo(0, 0); }, 80); });
  }
  function installAudioUnlock() {
    const unlock = () => { try { if (BB.Audio && BB.Audio.unlock) BB.Audio.unlock(); } catch (e) { warn('Audio.unlock', e); } };
    ['pointerdown', 'touchend', 'keydown'].forEach((t) => window.addEventListener(t, unlock, { capture: true, passive: true }));
  }
  function registerServiceWorker() {
    try {
      if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
      const reg = () => navigator.serviceWorker.register('service-worker.js').catch((e) => warn('Service Worker nicht registriert', e));
      if (doc.readyState === 'complete') reg(); else window.addEventListener('load', reg);
    } catch (e) { warn('Service Worker', e); }
  }

  let resizeTimer = null;
  function onResize() {
    resizeRenderer();
    clearTimeout(resizeTimer);
    // layout (bars wrap, panels move) settles after the resize – then refit
    resizeTimer = setTimeout(() => {
      resizeRenderer();
      const L = viewLevel();
      if (!L) return;
      if (camIsFit) fitView(false);
      else { setCamLimits(L, computeFit(L, measureInsets())); clampCam(); }
    }, 120);
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  function boot() {
    try { installGuards(); } catch (e) { warn('Schutzmaßnahmen', e); }
    try { installAudioUnlock(); } catch (e) { warn('Audio-Freischaltung', e); }
    initRenderer();
    wireUi();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') sv('flush'); lastTs = 0; });
    // read-mostly hook for automated tests / debugging (not used by the game itself)
    BB.UI = {
      G: G, E: E, Menu: Menu,
      get cam() { return cam; }, get view() { return view; }, get screen() { return currentScreen; },
      get modals() { return modalStack.length; }, get gesture() { return gesture ? gesture.type : null; },
      get renderer() { return R; }, get fallback() { return usingFallbackRenderer; },
      w2s: (x, y) => w2s(cam, x, y), s2w: (x, y) => s2w(cam, x, y),
      showScreen: showScreen, openLevelByIndex: openLevelByIndex, switchCampaign: switchCampaign, get campaign() { return CAMP.id; }, campStats: campStats, openEpochIntro: openEpochIntro, fitView: fitView, openGame: openGame, startTest: startTest,
      loadBridge(b) { if (!G.ed || G.mode !== 'build') return false; G.ed.setBridge(bridgeClone(b)); onBridgeChange(G.ed.bridge); return true; },
    };
    requestAnimationFrame(frame);
    initSave().then(() => {
      applyMute();
      if (saveIsMemory) setTimeout(() => toast('Achtung: Der Spielstand kann nicht gespeichert werden', 'warn'), 800);
      initCampaign();
      showScreen(campaignData().chosen === true ? 'menu' : 'campaign');      // first start: choose a campaign first
    }, (e) => {
      warn('Start', e);
      Save = createMemorySave(); saveIsMemory = true;
      initCampaign();
      showScreen('campaign');
    });
    registerServiceWorker();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis.BB = globalThis.BB || {});
