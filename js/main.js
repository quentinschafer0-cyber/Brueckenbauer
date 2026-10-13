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

  BB.VERSION = '1.0.0';

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
  const SETTING_DEFAULTS = { muted: false, showStress: true, helpSeen: false };
  const SANDBOX_DEFAULT = { span: 16, heightDiff: 0, water: true, rocks: 0, lowAnchors: true, highAnchors: false, vehicles: ['car'] };

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
      setSetting(k, v) { S.state.settings[k] = v; S.change(); },
      getSetting(k) { return S.state.settings[k]; },
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
  function LEVELS() { return Array.isArray(BB.LEVELS) ? BB.LEVELS : []; }
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
  function matRole(m) { return m.drivable ? 'befahrbar' : m.tensionOnly ? 'nur Zug' : 'Stütze'; }
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
    return '<h3 class="help-h">Materialien</h3>' +
      '<div class="mat-table-wrap"><table class="mat-table"><thead><tr><th>Material</th><th>Preis/m</th><th>Gewicht/m</th>' +
      '<th>Stärke</th><th>max. Länge</th><th>Art</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
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
  function summarizeVehicles(list, withWeight) {
    const counts = {};
    (list || []).forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
    return vehicleOrder().filter((k) => counts[k]).map((k) => {
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
  function w2s(c, x, y) { return [(x - c.x) * c.zoom + viewW() / 2, (c.y - y) * c.zoom + viewH() / 2]; }
  function s2w(c, sx, sy) { return [(sx - viewW() / 2) / c.zoom + c.x, c.y - (sy - viewH() / 2) / c.zoom]; }

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

  function initRenderer() {
    canvas = $('#game');
    try { if (BB.Render && typeof BB.Render.create === 'function') R = BB.Render.create(canvas); } catch (e) { warn('Render.create fehlgeschlagen', e); R = null; }
    if (!R || typeof R.draw !== 'function') {
      if (!BB.Render) warn('Grafikmodul fehlt – einfache Grafik wird verwendet');
      R = createFallbackRenderer(canvas);
      usingFallbackRenderer = true;
    }
  }
  function resizeRenderer() { try { if (R && R.resize) R.resize(); } catch (e) { warn('Render.resize', e); } }

  /** Thumbnail canvas for a box of w×h CSS px (BB.Render.thumbnail applies devicePixelRatio itself). */
  function makeThumb(level, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let c = null;
    try { if (BB.Render && typeof BB.Render.thumbnail === 'function') c = BB.Render.thumbnail(level, w, h); } catch (e) { warn('Render.thumbnail', e); c = null; }
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
    cam.x = w[0] - (sx - viewW() / 2) / cam.zoom;
    cam.y = w[1] + (sy - viewH() / 2) / cam.zoom;
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
    return p;
  }
  function normalizeVehicles(list) {
    const order = vehicleOrder();
    const out = (Array.isArray(list) ? list : []).filter((k) => order.indexOf(k) >= 0).slice(0, 8);
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
  }

  /** One counter row per vehicle type; getList/setList access the vehicle key array. */
  function buildVehicleRows(container, getList, setList) {
    container.innerHTML = '';
    const order = vehicleOrder();
    const steppers = [];
    const counts = () => { const c = {}; getList().forEach((k) => { c[k] = (c[k] || 0) + 1; }); return c; };
    const refreshLimits = () => {
      const total = getList().length;
      steppers.forEach((s) => {
        s.min = (total <= 1 && s.value >= 1) ? s.value : 0;     // at least one vehicle overall
        s.max = Math.min(5, s.value + (8 - total));             // at most 8 vehicles
        s.render();
      });
    };
    order.forEach((k) => {
      const s = makeStepper(counts()[k] || 0, 0, 5, 1, (v) => String(v), (v) => {
        const c = counts();
        c[k] = v;
        const list = [];
        order.forEach((kk) => { for (let i = 0; i < (c[kk] || 0); i++) list.push(kk); });
        setList(list);
        refreshLimits();
      });
      steppers.push(s);
      container.appendChild(paramRow(k, vehicleName(k), null, s.el, 'veh-ic'));
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
  function helpItem(ill, title, text) {
    return '<div class="help-item">' + ILL[ill] + '<div><b>' + esc(title) + '</b><span>' + esc(text) + '</span></div></div>';
  }
  function showHelp(firstTime) {
    const lvl = (view === 'game' && G.level && G.level.description) ? '<p class="help-foot"><b>Dieses Level:</b> ' + esc(G.level.description) + '</p>' : '';
    openModal({
      cls: 'wide', title: "So geht's",
      html: '<div class="help-grid">' +
        helpItem('build', 'Balken bauen', 'Ziehe von einem Punkt (Anker oder Knoten) aus und lass dort los, wo der Balken enden soll.') +
        helpItem('erase', 'Löschen-Werkzeug', 'Mit dem Radierer tippst oder wischst du Balken weg.') +
        helpItem('pinch', 'Zoomen & Verschieben', 'Zwei Finger = Zoomen/Verschieben. Ein Finger auf freier Fläche verschiebt die Ansicht. Maus: Rad und rechte Taste.') +
        helpItem('test', 'Testfahrt', 'Starte die Fahrzeuge und schau, ob die Brücke hält. Mit „Stopp“ baust du weiter.') +
        helpItem('mats', 'Materialien', 'Auf Straße fahren die Fahrzeuge. Holz und Stahl stützen, Seile halten nur auf Zug.') +
        helpItem('undo', 'Rückgängig', 'Fehler? Rückgängig und Wiederholen helfen. Am PC: Strg+Z, Strg+Y, Leertaste = Testfahrt.') +
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
    try { if (BB.Audio && BB.Audio.setMuted) BB.Audio.setMuted(m); } catch (e) { warn('Audio.setMuted', e); }
    $$('.mute-btn').forEach((b) => {
      const u = b.querySelector('use');
      if (u) u.setAttribute('href', m ? '#i-sound-off' : '#i-sound-on');
      b.setAttribute('aria-pressed', String(m));
      b.title = m ? 'Ton einschalten' : 'Ton ausschalten';
    });
    const s = $('#set-sound');
    if (s) s.setAttribute('aria-checked', String(!m));
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
      setView('menu');
      if (!Menu.level || !Menu.sim) menuNextScene(); else fitView(false);
      $('#m-backup').hidden = sv('backupDue') !== true;
      applyMute();
    },
  };
  function doBackup(after) {
    Promise.resolve(sv('exportFile')).then((r) => {
      if (r && r.ok) toast('Spielstand gesichert', 'ok');
      else if (r && r.cancelled) toast('Sicherung abgebrochen');
      else toast('Sicherung fehlgeschlagen', 'warn');
      if (after) after(r);
    }, (e) => { warn('exportFile', e); toast('Sicherung fehlgeschlagen', 'warn'); if (after) after(null); });
  }

  // ===========================================================================
  // Level selection
  // ===========================================================================
  let gridToken = null;
  function isUnlocked(i) { const L = LEVELS(); return i === 0 || (i > 0 && i < L.length && !!sv('isCompleted', L[i - 1].id)); }
  function bestCostOf(id) { const st = saveState(); const v = st && st.progress && st.progress.bestCost && st.progress.bestCost[id]; return typeof v === 'number' ? v : null; }

  function renderLevelGrid() {
    const grid = $('#level-grid');
    grid.innerHTML = '';
    const L = LEVELS();
    let totalStars = 0;
    const token = {};
    gridToken = token;
    const jobs = [];
    L.forEach((lv, i) => {
      const unlocked = isUnlocked(i);
      const done = !!sv('isCompleted', lv.id);
      const stars = done ? clamp(sv('getStars', lv.id) | 0, 0, 3) : 0;
      totalStars += stars;
      const best = done ? bestCostOf(lv.id) : null;
      const card = el('button', 'lvl-card' + (unlocked ? '' : ' locked') + (done ? ' done' : ''));
      card.type = 'button';
      card.style.animationDelay = Math.min(i * 25, 400) + 'ms';
      card.setAttribute('aria-label', 'Level ' + (i + 1) + ': ' + lv.name + (unlocked ? '' : ' (gesperrt)'));
      card.innerHTML = '<span class="lvl-num">' + (i + 1) + '</span>' +
        '<span class="lvl-thumb">' + (unlocked ? '' : '<span class="lvl-lock">' + icon('lock') + '</span>') + '</span>' +
        '<span class="lvl-name">' + esc(lv.name) + '</span>' +
        '<span class="lvl-meta">' + starsHtml(stars) + '<span class="lvl-best">' +
        (best != null ? 'Bestes: ' + fmtEuro(best) : (lv.budget != null ? 'Budget ' + fmtEuro(lv.budget) : '')) + '</span></span>';
      card.addEventListener('click', () => {
        if (isUnlocked(i)) openLevelByIndex(i);
        else { sound('error'); toast('Schaffe zuerst Level ' + i + ', dann ist dieses Level frei.', 'warn'); }
      });
      grid.appendChild(card);
      jobs.push({ box: card.querySelector('.lvl-thumb'), level: lv });
    });
    if (!L.length) grid.innerHTML = '<div class="card empty-state">' + icon('warn', 'big-ic') + '<p>Es wurden keine Level gefunden. Bitte lade die Seite neu.</p></div>';
    $('#levels-stars').textContent = totalStars + ' / ' + (L.length * 3);
    // thumbnails one by one so the screen appears immediately
    let k = 0;
    const next = () => {
      if (gridToken !== token || k >= jobs.length) return;
      const j = jobs[k++];
      const r = j.box.getBoundingClientRect();
      const w = Math.round(r.width || 220), h = Math.round(r.height || 138);
      const c = thumbFor(j.level, w, h);
      if (c) j.box.insertBefore(c, j.box.firstChild);
      setTimeout(next, 0);
    };
    setTimeout(next, 30);
  }
  screenHooks.levels = { show() { setView('none'); renderLevelGrid(); }, hide() { gridToken = null; } };
  function openLevelByIndex(i) {
    const lv = LEVELS()[i];
    if (!lv) return;
    openGame(cloneLevel(lv), { kind: 'level', key: lv.id, returnTo: 'levels', index: i });
  }

  // ===========================================================================
  // Game (build & test)
  // ===========================================================================
  const G = {
    level: null, kind: 'level', key: null, returnTo: 'levels', index: -1,
    ed: null, mode: 'build', sim: null, simAcc: 0, speed: 1, showStress: true,
    endT: null, resultShown: false, resultModal: null,
    hoverNode: null, deleteHighlight: null, progressText: '',
  };

  function openGame(level, opts) {
    closeAllModals();
    if (!BB.Editor || !level) { infoModal('Level kann nicht geöffnet werden', 'Ein Teil des Spiels fehlt. Bitte lade die Seite neu.', 'fail'); return; }
    G.level = level;
    G.kind = opts.kind; G.key = opts.key; G.returnTo = opts.returnTo;
    G.index = opts.index != null ? opts.index : -1;
    G.mode = 'build'; G.sim = null; G.endT = null; G.resultShown = false; G.resultModal = null; G.speed = 1;
    G.hoverNode = null; G.deleteHighlight = null;
    const saved = sv('getBridge', G.key);
    let bridge = { beams: [] }, removed = 0;
    if (saved && Array.isArray(saved.beams)) {
      const s = BB.Editor.sanitize(level, saved);
      bridge = s.bridge; removed = s.removed;
    }
    G.ed = BB.Editor.create(level, bridge, { onChange: onBridgeChange });
    if (removed) { sv('setBridge', G.key, G.ed.bridge); toast(removed === 1 ? '1 ungültiger Balken wurde entfernt' : removed + ' ungültige Balken wurden entfernt', 'warn'); }
    if (!G.ed.allowedMaterials().length) warn('Keine Materialien verfügbar');

    // title
    const num = $('#g-num');
    if (G.kind === 'level') num.textContent = String(G.index + 1);
    else num.innerHTML = icon(G.kind === 'sandbox' ? 'sandbox' : 'edit');
    $('#g-name').textContent = level.name || (G.kind === 'sandbox' ? 'Sandkasten' : 'Level');
    $('#g-back-label').textContent = ({ levels: 'Levels', editor: 'Editor' })[G.returnTo] || 'Zurück';
    $('#screen-game').classList.remove('testing');

    buildMaterialBar();
    updateCost();
    updateHistoryButtons();
    showScreen('game');
    fitView(false);
    showLevelHint();
    if (!getSetting('helpSeen')) setTimeout(() => { if (view === 'game' && !modalStack.length) showHelp(true); }, 350);
  }
  screenHooks.game = { show() { setView('game'); applyMute(); }, hide() { hideHint(true); } };

  function onBridgeChange(bridge) {
    sv('setBridge', G.key, bridge);
    updateCost();
    updateHistoryButtons();
    hideHint();
  }

  function leaveGame() {
    if (G.mode === 'test') stopTest();
    if (G.ed) G.ed.cancelDrag();
    sv('flush');
    const r = G.returnTo;
    if (r === 'editor' && E.level) showScreen('editor');
    else if (r === 'sandbox') showScreen('sandbox');
    else if (r === 'custom') showScreen('custom');
    else showScreen('levels');
  }

  function buildMaterialBar() {
    const wrap = $('#mat-list');
    wrap.innerHTML = '';
    G.ed.allowedMaterials().forEach((k, i) => {
      const m = matDef(k);
      const b = el('button', 'mat');
      b.type = 'button';
      b.setAttribute('data-m', k);
      b.title = m.name + (i < 9 ? ' (' + (i + 1) + ')' : '');
      b.innerHTML = '<span class="mat-sw ' + esc(k) + '" style="--sw:' + esc(m.color || '#888') + '"></span>' +
        '<span class="mat-name">' + esc(m.name) + '</span>' +
        '<span class="mat-info">' + fmtNum(m.price) + ' €/m</span>' +
        '<span class="mat-info">max ' + fmtDec(m.maxLength) + ' m</span>' +
        (i < 9 ? '<span class="mat-key">' + (i + 1) + '</span>' : '');
      b.addEventListener('click', () => selectMaterial(k));
      wrap.appendChild(b);
    });
    updateToolButtons();
  }
  function selectMaterial(k) {
    if (!G.ed || G.mode !== 'build') return;
    if (matDef(k)) toast(materialInfo(k), 'info');
    G.ed.material = k;
    G.ed.tool = 'build';
    G.ed.cancelDrag();
    G.deleteHighlight = null;
    updateToolButtons();
  }
  function toggleDeleteTool() {
    if (!G.ed || G.mode !== 'build') return;
    G.ed.tool = G.ed.tool === 'delete' ? 'build' : 'delete';
    G.ed.cancelDrag();
    G.hoverNode = null; G.deleteHighlight = null;
    updateToolButtons();
  }
  function updateToolButtons() {
    if (!G.ed) return;
    $$('#mat-list .mat').forEach((b) => {
      const on = G.ed.tool === 'build' && b.getAttribute('data-m') === G.ed.material;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const d = $('#t-delete');
    d.classList.toggle('on', G.ed.tool === 'delete');
    d.setAttribute('aria-pressed', String(G.ed.tool === 'delete'));
  }
  function updateHistoryButtons() {
    if (!G.ed) return;
    $('#t-undo').disabled = !G.ed.canUndo();
    $('#t-redo').disabled = !G.ed.canRedo();
    $('#t-clear').disabled = !G.ed.bridge.beams.length;
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
    dEl.textContent = delta ? (delta > 0 ? '+' : '') + fmtEuro(delta) : '';
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
    G.showStress = getSetting('showStress') !== false;
    G.hoverNode = null; G.deleteHighlight = null; G.progressText = '';
    $('#screen-game').classList.add('testing');
    updateSpeedButtons(); updateStressButton(); updateProgress();
    hideHint();
    sound('start');
  }
  function stopTest() {
    if (G.mode !== 'test') return;
    endGesture();
    if (G.resultModal) { const m = G.resultModal; G.resultModal = null; m.close(); }
    G.sim = null; G.mode = 'build'; G.endT = null; G.resultShown = false;
    $('#screen-game').classList.remove('testing');
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
  function updateStressButton() { $('#t-stress').setAttribute('aria-pressed', String(!!G.showStress)); }
  function updateProgress() {
    const sim = G.sim;
    if (!sim) return;
    const vs = sim.vehicles || [];
    const total = vs.length || (G.level.vehicles || []).length;
    const fin = vs.filter((v) => v.state === 'finished').length;
    const t = fin + ' / ' + total;
    if (t !== G.progressText) { G.progressText = t; $('#t-progress-text').textContent = t; $('#t-progress').title = 'Fahrzeuge im Ziel: ' + t; }
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
    let brk = false, spl = false;
    list.forEach((ev) => { if (ev.type === 'break') brk = true; else if (ev.type === 'splash') spl = true; });
    if (brk) sound('break');
    if (spl) sound('splash');
  }

  function updateGame(dt) {
    if (G.mode !== 'test' || !G.sim) return;
    try {
      G.simAcc = stepSimulation(G.sim, G.simAcc, dt, G.speed, true);
    } catch (e) {
      warn('Physik-Fehler', e);
      stopTest();
      infoModal('Fehler in der Simulation', 'Die Testfahrt musste abgebrochen werden. Deine Brücke ist unverändert.', 'fail');
      return;
    }
    const st = G.sim.status;
    if (st !== 'running' && G.endT === null) { G.endT = 0; if (st === 'failed') sound('fail'); }
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
    const nextIdx = (G.kind === 'level' && G.index >= 0 && G.index + 1 < LEVELS().length) ? G.index + 1 : -1;
    const backLabel = ({ levels: 'Levelauswahl', custom: 'Eigene Level', editor: 'Zum Editor', sandbox: 'Sandkasten' })[G.returnTo] || 'Levelauswahl';
    const backBtn = { label: backLabel, kind: 'white', icon: G.returnTo === 'levels' ? 'levels' : 'back', action: () => { G.resultModal = null; leaveGame(); } };
    const buildBtn = (kind) => ({ label: 'Zurück zum Bauen', kind: kind, icon: 'edit', action: () => { G.resultModal = null; stopTest(); } });
    const stats = (over) => '<dl class="result-stats"><dt>Kosten</dt><dd' + (over ? ' class="over"' : '') + '>' + fmtEuro(cost) + '</dd>' +
      '<dt>Budget</dt><dd>' + (budget == null ? 'unbegrenzt' : fmtEuro(budget)) + '</dd></dl>';
    const common = { dismissable: false, onEscape: () => { const m = G.resultModal; G.resultModal = null; if (m) m.close(); stopTest(); } };

    if (sim.status === 'won' && (budget == null || cost <= budget)) {
      const stars = budget == null ? 3 : starsFor(cost, budget);
      if (G.kind === 'level' || G.kind === 'custom') { sv('completeLevel', L.id, cost, stars); sv('flush'); }
      const buttons = [];
      if (nextIdx >= 0) buttons.push({ label: 'Nächstes Level', kind: 'green', icon: 'play', action: () => { G.resultModal = null; openLevelByIndex(nextIdx); } });
      buttons.push(buildBtn(nextIdx >= 0 ? 'white' : 'blue'));
      buttons.push(backBtn);
      const showStars = budget != null;
      const allDone = G.kind === 'level' && nextIdx < 0;
      G.resultModal = openModal(Object.assign({
        cls: 'win', title: 'Geschafft!',
        html: (showStars ? '<div class="result-stars">' + [0, 1, 2].map(() => icon('star', 'rstar')).join('') + '</div>' : '') +
          '<p>' + (allDone ? 'Super – du hast das letzte Level geschafft!' : 'Alle Fahrzeuge sind sicher angekommen.') + '</p>' + stats(false),
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
        buttons: [buildBtn('blue'), backBtn],
      }, common));
      sound('fail');
    } else {
      G.resultModal = openModal(Object.assign({
        cls: 'fail', icon: 'warn', title: 'Leider nicht geschafft',
        html: '<p>' + esc(resultText(sim.reason)) + '</p><p class="muted-text">Verstärke die Brücke und versuche es noch einmal.</p>',
        buttons: [buildBtn('blue'), backBtn],
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
    return generateLevel({
      span: p.span, heightDiff: p.heightDiff, water: p.water, rocks: p.rocks, lowAnchors: p.lowAnchors, highAnchors: p.highAnchors,
      vehicles: p.vehicles.slice(), budget: null, name: 'Sandkasten', id: 'sandbox',
    });
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
  const EDITOR_SHAPE_DEFAULT = { span: 16, heightDiff: 0, water: true, rocks: 0, lowAnchors: true, highAnchors: false };
  const EMPTY_BRIDGE = { beams: [] };
  const TOOL_TIPS = {
    anchor: 'Tippe auf einen Gitterpunkt: Anker setzen oder entfernen.',
    terrain: 'Ziehe die Geländepunkte. Tippe auf die Bodenlinie für einen neuen Punkt.',
    erase: 'Tippe auf einen Anker oder Geländepunkt, um ihn zu löschen.',
  };

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
  screenHooks.editor = { show() { setView('editor'); fitView(false); updateEditorStatus(); } };

  function buildEditorPanel() {
    $('#e-name').value = E.level.name || '';
    $('#e-budget').value = fmtNum(E.level.budget);
    buildVehicleRows($('#e-vehicles'), () => E.level.vehicles, (list) => { E.level.vehicles = list; markEditorDirty(); });
    buildShapeRows($('#e-params'), E.params, onShapeParamChange);
    $('#e-regen').classList.toggle('pending', E.pendingRegen);
    updateEditorStatus();
  }
  function setEditorTool(t) {
    E.tool = t;
    $$('#e-tools button').forEach((b) => {
      const on = b.getAttribute('data-tool') === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#e-tip').textContent = TOOL_TIPS[t] || '';
    E.hoverVertex = null; E.hoverAnchor = null;
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
  function refreshSettings() {
    applyMute();
    $('#set-stress').setAttribute('aria-checked', String(getSetting('showStress') !== false));
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
    const levels = LEVELS();
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
    let i = 0, sim = null;
    const mark = (li, ok, text) => {
      li.className = ok ? 'ok' : 'bad';
      li.querySelector('.st-ic').innerHTML = icon(ok ? 'check' : 'close');
      li.querySelector('.st-res').textContent = text;
    };
    const advance = () => { sim = null; i++; setTimeout(next, 0); };
    const next = () => {
      if (run.cancelled) return;
      if (i >= levels.length) {
        selfTest = null;
        btn.disabled = false;
        summary.textContent = run.passed + ' von ' + levels.length + ' Level bestanden' + (run.passed === levels.length ? ' – alles in Ordnung!' : '.');
        return;
      }
      const L = levels[i], li = items[i];
      if (!sim) {
        li.className = 'run';
        li.querySelector('.st-res').textContent = 'läuft …';
        const v = validateBridge(L, L.solution || { beams: [] });
        if (!L.solution || !v.ok) { mark(li, false, 'Musterlösung ungültig'); advance(); return; }
        try { sim = BB.Physics.createSim(L, bridgeClone(L.solution)); } catch (e) { warn('Selbsttest', e); mark(li, false, 'Fehler beim Start'); advance(); return; }
      }
      const t0 = nowMs();
      try {
        while (sim.status === 'running' && sim.t < 300 && nowMs() - t0 < 25) {
          BB.Physics.step(sim);
          if (sim.events) sim.events.length = 0;
        }
      } catch (e) { warn('Selbsttest', e); mark(li, false, 'Fehler in der Simulation'); advance(); return; }
      if (sim.status === 'running' && sim.t < 300) { setTimeout(next, 0); return; }
      const cost = bridgeCost(L, L.solution), budget = L.budget;
      const ok = sim.status === 'won' && (budget == null || cost <= budget);
      let res = fmtEuro(cost) + ' / ' + (budget == null ? 'unbegrenzt' : fmtEuro(budget));
      if (!ok) res = (sim.status === 'won' ? 'über dem Budget' : resultText(sim.reason)) + ' · ' + res;
      if (ok) run.passed++;
      mark(li, ok, res);
      advance();
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
    }
    gesture = null;
    if (G.ed && G.ed.drag) G.ed.cancelDrag();
  }
  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function tolFor(type) { return (type === 'mouse' ? 14 : 28) / cam.zoom; }
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
    const w = s2w(cam, p[0], p[1]);
    const tol = tolFor(e.pointerType);
    if (view === 'game' && G.ed && G.mode === 'build') {
      if (G.ed.tool === 'build' && G.ed.startDrag(w[0], w[1], tol)) { gesture = { type: 'build', id: id }; return; }
      if (G.ed.tool === 'delete' && G.ed.beamAt(w[0], w[1], tol) >= 0) {
        G.ed.beginErase();
        if (G.ed.eraseAt(w[0], w[1], tol)) sound('delete');
        gesture = { type: 'erase', id: id };
        return;
      }
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
          cam.x -= dx / cam.zoom;
          cam.y += dy / cam.zoom;
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
        cam.x = gesture.w0[0] - (mid[0] - viewW() / 2) / cam.zoom;
        cam.y = gesture.w0[1] + (mid[1] - viewH() / 2) / cam.zoom;
        clampCam();
        camIsFit = false;
        break;
      }
      case 'tap':
        if (gesture.id === e.pointerId && pt.moved) { gesture = { type: 'pan', id: e.pointerId }; cam.x -= (p[0] - pt.x0) / cam.zoom; cam.y += (p[1] - pt.y0) / cam.zoom; clampCam(); camIsFit = false; }
        break;
      case 'vertex':
        if (gesture.id === e.pointerId) moveVertexDrag(w);
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
      case 'vertex':
        if (g.id !== e.pointerId) break;
        finishVertexDrag();
        gesture = null;
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
      if (G.ed.tool === 'build') {
        const n = G.ed.nodeAt(w[0], w[1], tol);
        G.hoverNode = n ? [n.x, n.y] : null;
        G.deleteHighlight = null;
        if (n) cursor = 'crosshair';
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

  // --- level editor pointer handling --------------------------------------------
  function editorPointerDown(id, w, tol) {
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
        bridge: G.ed.bridge, sim: testing ? G.sim : null, showStress: !!G.showStress, showGrid: !testing,
        preview: testing ? null : G.ed.preview, hoverNode: testing ? null : hoverNode,
        deleteHighlight: testing || G.ed.tool !== 'delete' ? null : G.deleteHighlight, leveledit: null,
      };
    }
    if (view === 'editor' && E.level) {
      return {
        mode: 'leveledit', level: E.level, camera: cam, time: animTime, bridge: EMPTY_BRIDGE, sim: null,
        showStress: false, showGrid: true, preview: null, hoverNode: E.hoverAnchor, deleteHighlight: null,
        leveledit: { hoverVertex: gesture && gesture.type === 'vertex' ? gesture.index : E.hoverVertex, tool: E.tool },
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
    on('#m-play', 'click', () => showScreen('levels'));
    on('#m-sandbox', 'click', () => showScreen('sandbox'));
    on('#m-custom', 'click', () => showScreen('custom'));
    on('#m-editor', 'click', () => openEditorNew('menu'));
    on('#m-settings', 'click', () => showScreen('settings'));
    on('#m-backup-now', 'click', () => doBackup((r) => { if (r && r.ok) $('#m-backup').hidden = true; }));

    // game HUD
    on('#g-back', 'click', leaveGame);
    on('#g-fit', 'click', () => fitView(true));
    on('#g-help', 'click', () => showHelp(false));
    on('#g-hint-close', 'click', () => hideHint());
    on('#t-delete', 'click', toggleDeleteTool);
    on('#t-undo', 'click', doUndo);
    on('#t-redo', 'click', doRedo);
    on('#t-clear', 'click', askClear);
    on('#t-test', 'click', startTest);
    on('#t-stop', 'click', stopTest);
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
      if (ctrl && isZ && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (ctrl && (isY || (isZ && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (k === ' ' || k === 'Spacebar') {
        e.preventDefault();
        if (!e.repeat) { if (G.mode === 'build') startTest(); else stopTest(); }
      } else if (!ctrl && !e.altKey && (k === 'e' || k === 'E')) toggleDeleteTool();
      else if (!ctrl && !e.altKey && /^[1-9]$/.test(k)) {
        const keys = G.ed.allowedMaterials(), i = parseInt(k, 10) - 1;
        if (i < keys.length) selectMaterial(keys[i]);
      } else if (k === 'Escape') {
        if (gesture && gesture.type === 'build') { G.ed.cancelDrag(); gesture = null; updateCost(); }
      }
    } else if (view === 'editor') {
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
      showScreen: showScreen, openLevelByIndex: openLevelByIndex, fitView: fitView,
      loadBridge(b) { if (!G.ed || G.mode !== 'build') return false; G.ed.setBridge(bridgeClone(b)); onBridgeChange(G.ed.bridge); return true; },
    };
    requestAnimationFrame(frame);
    initSave().then(() => {
      applyMute();
      if (saveIsMemory) setTimeout(() => toast('Achtung: Der Spielstand kann nicht gespeichert werden', 'warn'), 800);
      showScreen('menu');
    }, (e) => {
      warn('Start', e);
      Save = createMemorySave(); saveIsMemory = true;
      showScreen('menu');
    });
    registerServiceWorker();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis.BB = globalThis.BB || {});
