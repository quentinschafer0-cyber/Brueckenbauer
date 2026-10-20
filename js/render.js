/*
 * Brückenbauer – render.js  (SPEC §7)
 *
 * Canvas-2D renderer for the whole game world: sky, sun, clouds, parallax hills,
 * terrain (earth, grass, stones), animated water, tower pylons, anchors, bridge
 * beams in five materials, joints, vehicles, FX particles and the build /
 * level-editor overlays.
 *
 * World units are meters with y pointing UP. A camera {x, y, zoom} is the world
 * point shown at the canvas center; zoom = CSS pixels per meter (SPEC §2).
 *
 * Performance notes (iPad, DPR 2, 60 fps next to the physics):
 *  - Sky + sun live in their own offscreen canvas (invalidated on resize only,
 *    so compositing it back in is essentially free every frame).
 *  - Hills, canyon back wall, pylons, terrain, grid dots, anchor plates and the
 *    start sign are drawn straight into the main canvas every frame instead of
 *    through a second cached offscreen canvas: that layer alone only costs
 *    ~1 ms even in a detailed close-up, while compositing an offscreen canvas
 *    that just changed (i.e. every single frame while panning/zooming, exactly
 *    when it matters) measured 100+ ms in headless Chrome – a cache that is
 *    invalidated every frame during the one case performance matters most is
 *    worse than no cache.
 *  - Beams are batched per material: a handful of stroke() calls per material,
 *    independent of the number of beams. No shadowBlur / filters anywhere.
 */
(function (BB) {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================
  const ZOOM_MIN = 4;            // px per meter (fitCamera clamp, SPEC §7)
  const ZOOM_MAX = 120;
  const DPR_MAX = 2;             // backing-store resolution cap (fill rate on iPad / phones)
  const TAU = Math.PI * 2;
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const NO_DASH = [];
  const MAX_FX = 700;            // particle cap
  const PATTERN_SIZE = 96;       // CSS px of the earth texture tile

  const TERRAIN = {
    body: '#b0743f',
    topsoil: '#91592e',
    outline: '#3a2414',
    rock: '#9a8b7b',
    rockLine: '#76685b',
    grass: '#6cc341',
    grassDark: '#3f8b2a',
    grassLight: '#a4e571',
    sand: '#dcc48c',
    sandDark: '#b99d64',
    stone: '#a39a90',
    stoneLight: '#cbc3ba',
    stoneEdge: '#4f4034',
    tuft: '#4f9f33',
  };

  // Back wall of a canyon/gorge: the "recessed" interior seen in side view, well
  // behind the foreground cliff faces (TERRAIN.rock/body) – darker and cooler/more
  // desaturated so depth reads clearly even though it is really just a flat fill.
  const BACKWALL = {
    top: '#7d7263',
    mid: '#5f5346',
    bottom: '#3c3327',
    strataLight: 'rgba(255,242,222,0.10)',
    strataDark: 'rgba(20,14,8,0.22)',
    bush: '#4a5e42',
    bushDark: '#374a33',
  };

  // Visual style per material. T = thickness in meters, px = minimum thickness in CSS px.
  // `kind` selects the drawing routine. Colors are deliberately very different per
  // material so the bridge is readable at a glance (also for the UI swatches, see
  // BB.Render.MATERIAL_COLORS).
  const MAT_STYLE = {
    road:      { kind: 'road', body: '#4b4f57', edge: '#1c1f24', top: '#868c96', line: '#ffd84a', T: 0.34, px: 4.6 },
    steelroad: { kind: 'steelroad', body: '#4b4f57', edge: '#18212c', top: '#868c96', girder: '#7c95b3', flange: '#566d88', rivet: '#e6edf5', T: 0.2, px: 2.6, Tg: 0.3, pxg: 3.0 },
    wood:      { kind: 'wood', body: '#cd8c46', edge: '#4f2c10', top: '#f0c084', grain: '#8e5525', T: 0.26, px: 3.6 },
    steel:     { kind: 'steel', body: '#e85d2f', edge: '#5e1d0b', top: '#ffa47c', flange: '#a93915', hole: '#5f1d0b', T: 0.3, px: 4.0 },
    rope:      { kind: 'rope', body: '#3b332d', edge: '#120e0b', top: '#a8957c', T: 0.09, px: 1.9 },
    concrete:  { kind: 'steel', body: '#8a8f98', edge: '#3f4349', top: '#c3c7cd', flange: '#6b6f76', hole: '#3f4349', T: 0.4, px: 5.0 },
    rail:      { kind: 'steelroad', body: '#4b4540', edge: '#241f1b', top: '#6b6054', girder: '#5c5248', flange: '#443d35', rivet: '#9b8f82', T: 0.22, px: 2.8, Tg: 0.3, pxg: 3.0 },
  };
  // Draw order (back → front): structure first, decks last.
  const MAT_DRAW_ORDER = ['wood', 'concrete', 'steel', 'rope', 'steelroad', 'rail', 'road'];
  const STYLE_COLOR_KEYS = ['body', 'edge', 'top', 'line', 'girder', 'flange', 'rivet', 'grain', 'hole'];

  // Fallback vehicle data in case physics.js (BB.VEHICLES) is not loaded.
  const VEH_FALLBACK = {
    bike:       { length: 1.8, height: 1.75, wheelRadius: 0.34, axles: [-0.55, 0.55], color: '#2a9d8f' },
    motorcycle: { length: 2.0, height: 1.3, wheelRadius: 0.32, axles: [-0.75, 0.75], color: '#c0392b' },
    car:        { length: 4.0, height: 1.5, wheelRadius: 0.36, axles: [-1.3, 1.3], color: '#e63946' },
    bus:        { length: 10, height: 3.1, wheelRadius: 0.5, axles: [-3.2, 3.0], color: '#ffc233' },
    truck:      { length: 9, height: 3.4, wheelRadius: 0.5, axles: [-3.4, -2.3, 2.9], color: '#3a7bd5' },
    tanker:     { length: 12, height: 3.3, wheelRadius: 0.5, axles: [-4.2, -2.9, 4.5], color: '#95a5a6' },
    crane:      { length: 9.5, height: 3.6, wheelRadius: 0.55, axles: [-3.5, -2.1, 3.1], color: '#f5b700' },
    train:      { length: 24, height: 3.8, wheelRadius: 0.55, axles: [-10.5, -7, -3.5, 0, 3.5, 7, 10.5], color: '#34495e' },
  };

  // Distant hill layers: f = horizontal parallax factor, fy = vertical follow factor,
  // amp = height in "layer meters", lift = extra raise as fraction of screen height.
  const HILLS = [
    { f: 0.10, fy: 0.16, amp: 12, lift: 0.13, col: '#c6e7dc', edge: '#b0d8ca', ph: 0.7, trees: 0 },
    { f: 0.22, fy: 0.30, amp: 8.5, lift: 0.07, col: '#a8d99e', edge: '#91c889', ph: 2.9, trees: 1 },
    { f: 0.38, fy: 0.46, amp: 6, lift: 0.0, col: '#88ca76', edge: '#6fb45f', ph: 5.3, trees: 2 },
  ];

  // Clouds: sprite index, relative start x, relative y, scale, drift speed px/s, parallax.
  const CLOUDS = [
    { s: 0, x: 0.05, y: 0.08, k: 1.0, v: 6, p: 0.035 },
    { s: 1, x: 0.36, y: 0.19, k: 0.72, v: 4, p: 0.025 },
    { s: 2, x: 0.60, y: 0.05, k: 1.12, v: 7, p: 0.04 },
    { s: 1, x: 0.84, y: 0.24, k: 0.58, v: 3, p: 0.02 },
    { s: 0, x: 0.22, y: 0.30, k: 0.48, v: 2.5, p: 0.015 },
  ];

  // ===========================================================================
  // Small helpers
  // ===========================================================================
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function mod(a, n) { const r = a % n; return r < 0 ? r + n : r; }

  // Deterministic integer hash → [0, 1). Used for decoration placement keyed by
  // world position so nothing shimmers when the camera moves.
  function hashInt(n) {
    let h = (n | 0) ^ 0x2c1b3c6d;
    h = Math.imul(h ^ (h >>> 16), 0x297a2d39);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function hash2(a, b) { return hashInt(Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)); }

  function parseColor(c) {
    if (typeof c !== 'string') return null;
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
    m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) { const s = m[1]; return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]; }
    return null;
  }
  function rgbStr(r, g, b) {
    return 'rgb(' + Math.round(clamp(r, 0, 255)) + ',' + Math.round(clamp(g, 0, 255)) + ',' + Math.round(clamp(b, 0, 255)) + ')';
  }
  const shadeMemo = new Map();
  /** Darken (f < 0) or lighten (f > 0) a hex color. Non-hex colors are returned unchanged. */
  function shade(c, f) {
    const key = c + '|' + f;
    let r = shadeMemo.get(key);
    if (r) return r;
    const p = parseColor(c);
    if (!p) r = c;
    else if (f < 0) r = rgbStr(p[0] * (1 + f), p[1] * (1 + f), p[2] * (1 + f));
    else r = rgbStr(p[0] + (255 - p[0]) * f, p[1] + (255 - p[1]) * f, p[2] + (255 - p[2]) * f);
    shadeMemo.set(key, r);
    return r;
  }

  /** Stress color: green (0) → yellow (0.5) → red (≥ 1). */
  function stressColor(stress) {
    const s = isNum(stress) ? clamp(stress, 0, 1) : 0;
    let r, g, b;
    if (s < 0.5) {
      const t = s / 0.5;
      r = 64 + (255 - 64) * t; g = 200 + (210 - 200) * t; b = 80 - 80 * t;
    } else {
      const t = (s - 0.5) / 0.5;
      r = 255 - 20 * t; g = 210 - 170 * t; b = 35 * t;
    }
    return rgbStr(r, g, b);
  }
  const STRESS_STEPS = 20;
  const STRESS_COLORS = [];
  for (let i = 0; i <= STRESS_STEPS; i++) STRESS_COLORS.push(stressColor(i / STRESS_STEPS));

  /** Rounded-rectangle sub-path (works in y-up and y-down coordinate systems). */
  function rrect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function fmtLen(l) {
    return (Math.round(l * 10) / 10).toFixed(1).replace('.', ',') + ' m';
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // ===========================================================================
  // Terrain queries (local copies so the renderer works without physics.js)
  // ===========================================================================
  /** Highest ground surface y at x (ground: [[x,y],…], x non-decreasing; flat beyond the ends). */
  function surfaceY(g, x) {
    const n = g ? g.length : 0;
    if (!n) return -1000;
    if (x < g[0][0]) return g[0][1];
    if (x > g[n - 1][0]) return g[n - 1][1];
    // binary search: last index with g[i].x <= x
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g[mid][0] <= x) lo = mid; else hi = mid - 1;
    }
    let best = -Infinity;
    for (let j = lo; j >= 0 && g[j][0] === x; j--) if (g[j][1] > best) best = g[j][1];   // vertical wall
    if (lo + 1 < n) {
      const a = g[lo], b = g[lo + 1], dx = b[0] - a[0];
      const y = dx > 0 ? a[1] + (b[1] - a[1]) * (x - a[0]) / dx : Math.max(a[1], b[1]);
      if (y > best) best = y;
    } else if (g[lo][1] > best) best = g[lo][1];
    return best;
  }

  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + dx * t - px, qy = ay + dy * t - py;
    return qx * qx + qy * qy;
  }

  /** true if (x,y) is closer than tol to the ground polyline. */
  function nearGround(g, x, y, tol) {
    const t2 = tol * tol;
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i], b = g[i + 1];
      if (b[0] < x - tol || a[0] > x + tol) continue;     // x is non-decreasing
      if (segDist2(x, y, a[0], a[1], b[0], b[1]) < t2) return true;
    }
    return false;
  }

  /** Ground points covering [x0, x1] (extended flat beyond the polyline ends). */
  function visiblePolyline(g, x0, x1) {
    const out = [];
    const n = g.length;
    if (g[0][0] > x0) out.push([x0, g[0][1]]);
    let i0 = 0;
    while (i0 + 1 < n && g[i0 + 1][0] <= x0) i0++;
    for (let i = i0; i < n; i++) {
      out.push(g[i]);
      if (g[i][0] >= x1) break;
    }
    if (g[n - 1][0] < x1) out.push([x1, g[n - 1][1]]);
    return out;
  }

  /**
   * Water basins: the parts of the ground polyline below the water level, each as a
   * flat array [x0,w, x,y, …, x1,w] starting and ending at the shoreline crossings.
   */
  function waterBasins(g, w, x0, x1) {
    const out = [];
    const n = g.length;
    if (!n) return out;
    const pts = [];
    if (g[0][0] > x0) pts.push(x0, g[0][1]);
    for (let i = 0; i < n; i++) pts.push(g[i][0], g[i][1]);
    if (g[n - 1][0] < x1) pts.push(x1, g[n - 1][1]);
    const m = pts.length >> 1;
    let cur = null;
    if (pts[1] < w) cur = [pts[0], w, pts[0], pts[1]];
    for (let i = 0; i + 1 < m; i++) {
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3];
      if (ay < w && by < w) {
        if (cur) cur.push(bx, by);
      } else if (ay >= w && by < w) {
        const cx = ax + (bx - ax) * (w - ay) / (by - ay);
        cur = [cx, w, bx, by];
      } else if (ay < w && by >= w) {
        const cx = ax + (bx - ax) * (w - ay) / (by - ay);
        if (cur) { cur.push(cx, w); out.push(cur); }
        cur = null;
      }
    }
    if (cur) { cur.push(pts[2 * (m - 1)], w); out.push(cur); }
    return out;
  }

  /**
   * Splits the visible surface polyline into runs by look:
   *  'grass' – up-facing surface above water, 'sand' – up-facing below water,
   *  'rock'  – steep faces / walls.
   */
  function surfaceRuns(pts, water) {
    const runs = [];
    let cur = null;
    function add(type, ax, ay, bx, by) {
      if (cur && cur.type === type) cur.pts.push([bx, by]);
      else { cur = { type: type, pts: [[ax, ay], [bx, by]] }; runs.push(cur); }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
      const dx = bx - ax, dy = by - ay;
      if (dx === 0 && dy === 0) continue;
      const up = dx > 1e-6 && Math.abs(dy) <= dx * 1.3;
      if (!up) { add('rock', ax, ay, bx, by); continue; }
      if (water === null || (ay >= water && by >= water)) add('grass', ax, ay, bx, by);
      else if (ay <= water && by <= water) add('sand', ax, ay, bx, by);
      else {
        const cx = ax + dx * (water - ay) / dy;
        if (ay > water) { add('grass', ax, ay, cx, water); add('sand', cx, water, bx, by); }
        else { add('sand', ax, ay, cx, water); add('grass', cx, water, bx, by); }
      }
    }
    return runs;
  }

  /** Tower anchors (high above the ground) with the y where their pylon ends. */
  function towerAnchors(level) {
    const out = [];
    const g = level.ground, an = level.anchors;
    if (!Array.isArray(an) || !Array.isArray(g) || g.length < 2) return out;
    for (let i = 0; i < an.length; i++) {
      const a = an[i];
      if (!a || !isNum(a[0]) || !isNum(a[1])) continue;
      const x = a[0], y = a[1];
      const sy = surfaceY(g, x);
      if (!(y - sy > 1.5)) continue;
      // Reach down to the lowest ground under the pylon foot so it never floats
      // (towers at a bank edge get a foundation down the cliff face).
      let bottom = Math.min(sy, surfaceY(g, x - 0.75), surfaceY(g, x + 0.75)) - 0.8;
      bottom = Math.max(bottom, y - 90);
      out.push([x, y, bottom]);
    }
    return out;
  }

  // ===========================================================================
  // View (camera → transforms)
  // ===========================================================================
  function makeView() {
    return { ctx: null, W: 1, H: 1, dpr: 1, cam: null, z: 1, ox: 0, oy: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, t: 0, lite: false };
  }
  function setView(V, ctx, W, H, dpr, cam) {
    const z = cam.zoom;
    V.ctx = ctx; V.W = W; V.H = H; V.dpr = dpr; V.cam = cam; V.z = z;
    V.ox = W / 2 - cam.x * z;               // screen x of world x = 0
    V.oy = H / 2 + cam.y * z;               // screen y of world y = 0
    V.minX = cam.x - W / 2 / z; V.maxX = cam.x + W / 2 / z;
    V.minY = cam.y - H / 2 / z; V.maxY = cam.y + H / 2 / z;
    return V;
  }
  /** World transform: draw in meters, y up. */
  function setWorld(V) { V.ctx.setTransform(V.dpr * V.z, 0, 0, -V.dpr * V.z, V.dpr * V.ox, V.dpr * V.oy); }
  /** Screen transform: draw in CSS px. */
  function setScreen(V) { V.ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); }

  function validCam(c) { return c && isNum(c.x) && isNum(c.y) && isNum(c.zoom) && c.zoom > 0; }

  /** Region the camera should show initially. */
  function levelBounds(level) {
    let b = null;
    try {
      if (BB.Levels && typeof BB.Levels.fitBounds === 'function') b = BB.Levels.fitBounds(level);
    } catch (e) { b = null; }
    if (b && isNum(b.minX) && isNum(b.maxX) && isNum(b.minY) && isNum(b.maxY) && b.maxX > b.minX && b.maxY > b.minY) return b;
    // Fallback: build area ∪ anchors ∪ finish flag, with margins.
    const bd = (level && level.build) || { minX: -10, maxX: 10, minY: -10, maxY: 10 };
    let minX = num(bd.minX, -10), maxX = num(bd.maxX, 10), minY = num(bd.minY, -10), maxY = num(bd.maxY, 10);
    const g = level && Array.isArray(level.ground) && level.ground.length ? level.ground : null;
    if (level && Array.isArray(level.anchors)) {
      level.anchors.forEach(function (a) {
        if (!a || !isNum(a[0]) || !isNum(a[1])) return;
        minX = Math.min(minX, a[0] - 1); maxX = Math.max(maxX, a[0] + 1);
        minY = Math.min(minY, a[1] - 1); maxY = Math.max(maxY, a[1] + 1.5);
      });
    }
    if (level && isNum(level.flagX)) {
      const fy = g ? surfaceY(g, level.flagX) : 0;
      maxX = Math.max(maxX, level.flagX + 3.5);
      maxY = Math.max(maxY, fy + 6.5);
      minY = Math.min(minY, fy - 1);
    }
    return { minX: minX - 3, maxX: maxX + 2, minY: minY - 2, maxY: maxY + 2 };
  }

  function fitCam(level, W, H, insets, zmin, zmax) {
    const b = levelBounds(level || {});
    const ins = insets || {};
    const l = Math.max(0, num(ins.left, 0)), r = Math.max(0, num(ins.right, 0));
    const t = Math.max(0, num(ins.top, 0)), bo = Math.max(0, num(ins.bottom, 0));
    const aw = Math.max(40, W - l - r), ah = Math.max(40, H - t - bo);
    const z = clamp(Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY)), zmin, zmax);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // The bounds center must land in the center of the free (non-HUD) area.
    const sx = l + aw / 2, sy = t + ah / 2;
    return { x: cx - (sx - W / 2) / z, y: cy + (sy - H / 2) / z, zoom: z };
  }

  // ===========================================================================
  // Background: sky, sun, clouds, hills
  // ===========================================================================
  function drawSkyBase(V, small) {
    const ctx = V.ctx, W = V.W, H = V.H;
    setScreen(V);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#45a8ea');
    g.addColorStop(0.55, '#92d3f6');
    g.addColorStop(1, '#e2f5fc');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // comic sun with soft glow and rays
    const R = small ? clamp(Math.min(W, H) * 0.09, 5, 22) : clamp(Math.min(W, H) * 0.052, 14, 56);
    const x = W * 0.86, y = Math.max(R * 2.2, H * 0.13);
    const glow = ctx.createRadialGradient(x, y, R * 0.8, x, y, R * 3.4);
    glow.addColorStop(0, 'rgba(255,243,180,0.6)');
    glow.addColorStop(1, 'rgba(255,243,180,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, R * 3.4, 0, TAU); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * TAU + 0.13;
      const r0 = R * 1.22, r1 = R * (i % 2 ? 1.7 : 2.05), da = 0.12;
      ctx.moveTo(x + Math.cos(a - da) * r0, y + Math.sin(a - da) * r0);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      ctx.lineTo(x + Math.cos(a + da) * r0, y + Math.sin(a + da) * r0);
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(255,212,80,0.7)';
    ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU);
    ctx.fillStyle = '#ffd84a'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, R * 0.08); ctx.strokeStyle = '#f2a32a'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x - R * 0.32, y - R * 0.3, R * 0.34, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
  }

  function makeCloudSprite(seed, w, h, res) {
    const c = makeCanvas(w * res, h * res);
    const x = c.getContext('2d');
    x.scale(res, res);
    const n = 4 + (seed % 2);
    const puffs = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const r = h * (0.19 + 0.16 * Math.sin(t * Math.PI) + 0.06 * hashInt(seed * 13 + i));
      puffs.push([w * (0.15 + 0.7 * t), h * 0.68 - r * 0.55, r]);
    }
    function shape(dy) {
      x.beginPath();
      rrect(x, w * 0.08, h * 0.5 + dy, w * 0.84, h * 0.3, h * 0.15);
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        x.moveTo(p[0] + p[2], p[1] + dy);
        x.arc(p[0], p[1] + dy, p[2], 0, TAU);
      }
      x.fill();
    }
    x.fillStyle = '#cfe4f2'; shape(h * 0.07);
    x.fillStyle = '#ffffff'; shape(0);
    return { c: c, w: w, h: h };
  }

  function drawClouds(V, sprites, time) {
    const ctx = V.ctx;
    setScreen(V);
    for (let i = 0; i < CLOUDS.length; i++) {
      const cl = CLOUDS[i], sp = sprites[cl.s];
      const w = sp.w * cl.k, h = sp.h * cl.k;
      const span = V.W + w * 2;
      let x = mod(cl.x * span + time * cl.v - V.cam.x * V.z * cl.p, span) - w;
      const y = V.H * cl.y + clamp(V.cam.y * V.z * cl.p * 0.5, -40, 40);
      ctx.drawImage(sp.c, x, y, w, h);
    }
  }

  function hillHeight(u, L) {
    return L.amp * (0.62 + 0.2 * Math.sin(u * 0.081 + L.ph) + 0.12 * Math.sin(u * 0.187 + L.ph * 2.3) + 0.06 * Math.sin(u * 0.43 + L.ph * 0.7));
  }

  function drawHills(V) {
    const ctx = V.ctx, W = V.W, H = V.H;
    setScreen(V);
    // Hills are "far away": their pixel scale grows only slowly with the zoom.
    const zl = 9 * Math.pow(V.z / 20, 0.3) * (V.lite ? 0.8 : 1);
    const base = H * 0.6;
    const step = V.lite ? 4 : 8;
    ctx.lineJoin = 'round';
    for (let li = 0; li < HILLS.length; li++) {
      const L = HILLS[li];
      const hy = clamp(base + (V.oy - base) * L.fy - H * L.lift, H * 0.16, H * 1.05);
      const uOff = V.cam.x * L.f;
      ctx.beginPath();
      ctx.moveTo(-step, H + 2);
      for (let sx = -step; sx <= W + step; sx += step) {
        const u = (sx - W / 2) / zl + uOff;
        ctx.lineTo(sx, hy - hillHeight(u, L) * zl);
      }
      ctx.lineTo(W + step, H + 2);
      ctx.closePath();
      ctx.fillStyle = L.col; ctx.fill();
      ctx.lineWidth = V.lite ? 1 : 2; ctx.strokeStyle = L.edge; ctx.stroke();
      if (L.trees && !V.lite) drawHillTrees(V, L, hy, zl, uOff);
    }
  }

  function drawHillTrees(V, L, hy, zl, uOff) {
    const ctx = V.ctx, W = V.W;
    const far = L.trees === 1;
    const sp = far ? 7 : 5.5;
    const sc = zl * (far ? 0.5 : 0.75);
    const u0 = -W / 2 / zl + uOff - sp, u1 = W / 2 / zl + uOff + sp;
    const trunks = [], rounds = [], pines = [];
    for (let i = Math.floor(u0 / sp); i <= Math.ceil(u1 / sp); i++) {
      if (hash2(i, 31 + L.trees) < 0.42) continue;
      const u = (i + hash2(i, 41) * 0.7) * sp;
      const x = W / 2 + (u - uOff) * zl;
      const y = hy - hillHeight(u, L) * zl + 0.3 * sc;
      const s = sc * (0.75 + 0.5 * hash2(i, 51));
      if (hash2(i, 61) < 0.55) { trunks.push(x, y, s, 1.1); rounds.push(x, y, s); }
      else { trunks.push(x, y, s, 0.6); pines.push(x, y, s); }
    }
    const canopy = far ? '#78b86c' : '#579f47', light = far ? '#93cb85' : '#77bd62';
    ctx.fillStyle = far ? '#8d7660' : '#7a5636';
    ctx.beginPath();
    for (let i = 0; i < trunks.length; i += 4) {
      const x = trunks[i], y = trunks[i + 1], s = trunks[i + 2], h = trunks[i + 3];
      ctx.rect(x - 0.12 * s, y - h * s, 0.24 * s, h * s);
    }
    ctx.fill();
    ctx.fillStyle = canopy;
    ctx.beginPath();
    for (let i = 0; i < rounds.length; i += 3) {
      const x = rounds[i], y = rounds[i + 1], s = rounds[i + 2];
      ctx.moveTo(x + 0.75 * s, y - 1.6 * s); ctx.arc(x, y - 1.6 * s, 0.75 * s, 0, TAU);
      ctx.moveTo(x - 0.35 * s + 0.5 * s, y - 1.2 * s); ctx.arc(x - 0.35 * s, y - 1.2 * s, 0.5 * s, 0, TAU);
      ctx.moveTo(x + 0.4 * s + 0.5 * s, y - 1.25 * s); ctx.arc(x + 0.4 * s, y - 1.25 * s, 0.5 * s, 0, TAU);
    }
    for (let i = 0; i < pines.length; i += 3) {
      const x = pines[i], y = pines[i + 1], s = pines[i + 2];
      ctx.moveTo(x, y - 2.7 * s); ctx.lineTo(x + 0.55 * s, y - 1.5 * s); ctx.lineTo(x - 0.55 * s, y - 1.5 * s); ctx.closePath();
      ctx.moveTo(x, y - 2.0 * s); ctx.lineTo(x + 0.75 * s, y - 0.55 * s); ctx.lineTo(x - 0.75 * s, y - 0.55 * s); ctx.closePath();
    }
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    for (let i = 0; i < rounds.length; i += 3) {
      const x = rounds[i], y = rounds[i + 1], s = rounds[i + 2];
      ctx.moveTo(x - 0.2 * s + 0.3 * s, y - 1.85 * s); ctx.arc(x - 0.2 * s, y - 1.85 * s, 0.3 * s, 0, TAU);
    }
    ctx.fill();
  }

  // ===========================================================================
  // Canyon back wall: fills the "recessed" open space of a gap (canyon, river,
  // notch around a rock pillar, …) with a believable far wall of the gorge
  // instead of letting the distant-hills layer show through underneath the rim.
  // ===========================================================================

  /** Running max of g[].y from the left and from the right, indexed like g. */
  function groundRims(g) {
    const n = g.length;
    const left = new Array(n), right = new Array(n);
    let m = -Infinity;
    for (let i = 0; i < n; i++) { if (g[i][1] > m) m = g[i][1]; left[i] = m; }
    m = -Infinity;
    for (let i = n - 1; i >= 0; i--) { if (g[i][1] > m) m = g[i][1]; right[i] = m; }
    return { left: left, right: right };
  }

  /**
   * "Skyline" height at world x: the lowest rim that encloses x from both sides
   * (classic trapped-rain-water profile). Where this is above the ground surface
   * itself, that x is inside a recess (canyon/valley/notch) as seen from above –
   * exactly the region that needs a gorge back wall instead of open sky.
   * Uses the FULL ground array (not just the on-screen slice) so a close-up view
   * that only shows part of a cliff wall still finds the true rim off-screen.
   */
  function rimY(g, rims, x) {
    const n = g.length;
    if (x <= g[0][0]) return g[0][1];
    if (x >= g[n - 1][0]) return g[n - 1][1];
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g[mid][0] <= x) lo = mid; else hi = mid - 1; }
    const sy = surfaceY(g, x);
    const leftMax = Math.max(rims.left[lo], sy);
    const rightMax = Math.max(lo + 1 < n ? rims.right[lo + 1] : g[n - 1][1], sy);
    return Math.min(leftMax, rightMax);
  }

  function drawCanyonBack(V, level) {
    const g = level.ground;
    if (!Array.isArray(g) || g.length < 2) return;
    const pts = visiblePolyline(g, V.minX - 3, V.maxX + 3);
    const n = pts.length;
    if (n < 2) return;
    const rims = groundRims(g);
    const topY = new Array(n);
    let minSurf = Infinity, maxRim = -Infinity, any = false;
    for (let i = 0; i < n; i++) {
      const r = rimY(g, rims, pts[i][0]);
      topY[i] = r;
      if (r - pts[i][1] > 0.04) any = true;
      if (pts[i][1] < minSurf) minSurf = pts[i][1];
      if (r > maxRim) maxRim = r;
    }
    if (!any) return;
    const ctx = V.ctx, z = V.z;
    setWorld(V);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], topY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], topY[i]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    const x0 = pts[0][0] - 1, x1 = pts[n - 1][0] + 1;
    const grad = ctx.createLinearGradient(0, maxRim, 0, minSurf);
    grad.addColorStop(0, BACKWALL.top);
    grad.addColorStop(0.45, BACKWALL.mid);
    grad.addColorStop(1, BACKWALL.bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(x0, minSurf - 1, x1 - x0, (maxRim - minSurf) + 2);
    if (!V.lite) {
      // horizontal strata bands, gently wavy so the wall doesn't look like flat fill
      const step = Math.max(0.35, 5 / z), rowH = 1.35;
      const r0 = Math.floor(minSurf / rowH) * rowH;
      ctx.lineWidth = Math.max(0.05, 1.1 / z);
      ctx.beginPath();
      for (let yy = r0, ri = 0; yy < maxRim; yy += rowH, ri++) {
        ctx.moveTo(x0, yy);
        for (let x = x0; x <= x1; x += step) ctx.lineTo(x, yy + Math.sin(x * 0.6 + ri * 1.7) * 0.1);
      }
      ctx.strokeStyle = BACKWALL.strataDark; ctx.stroke();
      ctx.beginPath();
      for (let yy = r0 + rowH * 0.45, ri = 0; yy < maxRim; yy += rowH, ri++) {
        ctx.moveTo(x0, yy);
        for (let x = x0; x <= x1; x += step) ctx.lineTo(x, yy + Math.sin(x * 0.6 + 1.1 + ri * 1.7) * 0.1);
      }
      ctx.strokeStyle = BACKWALL.strataLight; ctx.stroke();
      // a few scrubby distant bushes clinging to the wall, just under the rim
      if (z >= 6) {
        const sp = 2.1;
        const bush = [];
        for (let k = Math.floor(x0 / sp); k <= Math.ceil(x1 / sp); k++) {
          if (hash2(k, 71) < 0.52) continue;
          const bx = (k + hash2(k, 72) * 0.6) * sp;
          const by = rimY(g, rims, bx);
          const sy = surfaceY(g, bx);
          if (by - sy < 1.6) continue;              // too shallow here – no room for a bush
          const depth = 0.3 + hash2(k, 73) * 1.1;    // sits a bit below the rim, on the wall
          const s = 0.22 + hash2(k, 74) * 0.18;
          bush.push(bx, by - depth, s);
        }
        if (bush.length) {
          ctx.fillStyle = BACKWALL.bushDark;
          ctx.beginPath();
          for (let i = 0; i < bush.length; i += 3) {
            const x = bush[i], y = bush[i + 1], s = bush[i + 2];
            ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, TAU);
            ctx.moveTo(x + s * 0.8 + s * 0.6, y + s * 0.3); ctx.arc(x + s * 0.8, y + s * 0.3, s * 0.6, 0, TAU);
            ctx.moveTo(x - s * 0.7 + s * 0.55, y + s * 0.25); ctx.arc(x - s * 0.7, y + s * 0.25, s * 0.55, 0, TAU);
          }
          ctx.fill();
          ctx.fillStyle = BACKWALL.bush;
          ctx.beginPath();
          for (let i = 0; i < bush.length; i += 3) {
            const x = bush[i], y = bush[i + 1], s = bush[i + 2];
            ctx.moveTo(x - s * 0.15 + s * 0.65, y - s * 0.15); ctx.arc(x - s * 0.15, y - s * 0.15, s * 0.65, 0, TAU);
          }
          ctx.fill();
        }
      }
    }
    // subtle extra shadow right under the rim edge, for a sense of overhang/depth
    ctx.beginPath();
    ctx.moveTo(pts[0][0], topY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], topY[i]);
    ctx.lineWidth = Math.max(0.15, 2.2 / z);
    ctx.strokeStyle = 'rgba(20,14,8,0.28)';
    ctx.stroke();
    ctx.restore();
  }

  // ===========================================================================
  // Static world: pylons, terrain, start sign, grid, anchor plates
  // ===========================================================================
  function makeEarthTile(res) {
    const S = PATTERN_SIZE;
    const c = makeCanvas(S * res, S * res);
    const x = c.getContext('2d');
    x.scale(res, res);
    const offs = [-S, 0, S];
    // tiny specks (light and dark) – drawn with wrap-around copies → seamless tile
    for (let i = 0; i < 80; i++) {
      const px = hashInt(i * 7 + 1) * S, py = hashInt(i * 7 + 2) * S, r = 0.6 + hashInt(i * 7 + 3) * 1.5;
      x.fillStyle = hashInt(i * 7 + 4) < 0.55 ? 'rgba(92,50,20,0.30)' : 'rgba(255,222,175,0.20)';
      x.beginPath();
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        x.moveTo(px + offs[a] + r, py + offs[b]); x.arc(px + offs[a], py + offs[b], r, 0, TAU);
      }
      x.fill();
    }
    // small embedded pebbles
    for (let i = 0; i < 6; i++) {
      const px = hashInt(i * 11 + 101) * S, py = hashInt(i * 11 + 102) * S;
      const rx = 2.4 + hashInt(i * 11 + 103) * 3, ry = rx * (0.55 + 0.2 * hashInt(i * 11 + 104));
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        const cx = px + offs[a], cy = py + offs[b];
        x.beginPath(); x.ellipse(cx, cy, rx, ry, 0.3, 0, TAU);
        x.fillStyle = 'rgba(80,44,18,0.32)'; x.fill();
        x.beginPath(); x.ellipse(cx - rx * 0.25, cy - ry * 0.3, rx * 0.45, ry * 0.35, 0.3, 0, TAU);
        x.fillStyle = 'rgba(255,230,195,0.22)'; x.fill();
      }
    }
    // short strata dashes
    x.strokeStyle = 'rgba(90,48,18,0.22)';
    x.lineWidth = 1.2; x.lineCap = 'round';
    x.beginPath();
    for (let i = 0; i < 9; i++) {
      const px = hashInt(i * 5 + 300) * S, py = hashInt(i * 5 + 301) * S, l = 5 + hashInt(i * 5 + 302) * 9;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        x.moveTo(px + offs[a], py + offs[b]); x.lineTo(px + offs[a] + l, py + offs[b] + l * 0.12);
      }
    }
    x.stroke();
    return c;
  }

  function drawPylons(V, level) {
    const list = towerAnchors(level);
    if (!list.length) return;
    setWorld(V);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p[0] + 1.5 < V.minX || p[0] - 1.5 > V.maxX || p[1] + 1 < V.minY || p[2] > V.maxY) continue;
      drawPylon(V, p[0], p[1], p[2]);
    }
  }

  function drawPylon(V, x, top, bottom) {
    const ctx = V.ctx, z = V.z;
    const ol = Math.max(0.07, 1.4 / z);
    const wT = 0.9, wB = 1.3 + Math.min(0.7, (top - bottom) * 0.025);
    const capY = top - 0.32;
    function shaft() {
      ctx.beginPath();
      ctx.moveTo(x - wB / 2, bottom); ctx.lineTo(x - wT / 2, capY);
      ctx.lineTo(x + wT / 2, capY); ctx.lineTo(x + wB / 2, bottom);
      ctx.closePath();
    }
    shaft();
    ctx.fillStyle = '#d5ccbf'; ctx.fill();
    // right-side shading for volume
    ctx.beginPath();
    ctx.moveTo(x + wB * 0.16, bottom); ctx.lineTo(x + wT * 0.16, capY);
    ctx.lineTo(x + wT / 2, capY); ctx.lineTo(x + wB / 2, bottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(95,75,55,0.2)'; ctx.fill();
    // masonry joints
    if (z >= 7) {
      ctx.beginPath();
      const rowH = 0.9;
      let row = 0;
      for (let yy = capY - rowH; yy > bottom; yy -= rowH, row++) {
        const t = (capY - yy) / (capY - bottom);
        const hw = (wT + (wB - wT) * t) / 2;
        ctx.moveTo(x - hw, yy); ctx.lineTo(x + hw, yy);
        const vx = x + (row % 2 ? -hw * 0.3 : hw * 0.35);
        ctx.moveTo(vx, yy); ctx.lineTo(vx, Math.min(capY, yy + rowH));
      }
      ctx.lineWidth = Math.max(0.035, 0.9 / z); ctx.strokeStyle = 'rgba(115,98,82,0.75)'; ctx.lineCap = 'butt';
      ctx.stroke();
    }
    shaft();
    ctx.lineJoin = 'round'; ctx.lineWidth = ol; ctx.strokeStyle = '#4f463d'; ctx.stroke();
    // cap block
    ctx.beginPath(); rrect(ctx, x - 0.75, capY - 0.28, 1.5, top - capY + 0.33, 0.08);
    ctx.fillStyle = '#c0b6a8'; ctx.fill(); ctx.stroke();
  }

  function surfacePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  function runPath(ctx, run) {
    const P = run.pts;
    ctx.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
  }

  /** Band below a surface run: top = the run, bottom = run − depth(x) (sampled). */
  function bandPath(ctx, run, step, depthFn) {
    const P = run.pts;
    ctx.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
    for (let i = P.length - 1; i > 0; i--) {
      const a = P[i], b = P[i - 1];
      const n = Math.max(1, Math.ceil((a[0] - b[0]) / step));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
        ctx.lineTo(x, y - depthFn(x));
      }
    }
    ctx.closePath();
  }

  function drawTerrain(V, level, pattern) {
    const g = level.ground;
    if (!Array.isArray(g) || g.length < 2) return;
    const ctx = V.ctx, z = V.z;
    const water = isNum(level.water) ? level.water : null;
    const pts = visiblePolyline(g, V.minX - 3, V.maxX + 3);
    if (pts.length < 2) return;
    let topY = -Infinity, lowY = Infinity;
    for (let i = 0; i < pts.length; i++) { topY = Math.max(topY, pts[i][1]); lowY = Math.min(lowY, pts[i][1]); }
    const bottom = Math.min(V.minY, lowY) - 5;

    setWorld(V);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // --- body
    ctx.beginPath();
    ctx.moveTo(pts[0][0], bottom);
    for (let i = 0; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(pts[pts.length - 1][0], bottom);
    ctx.closePath();
    ctx.fillStyle = TERRAIN.body; ctx.fill();
    if (pattern) {
      // earth texture anchored to the world (moves with panning, scales mildly with zoom)
      const s = clamp(z / 26, 0.55, 1.7), T = PATTERN_SIZE * s;
      ctx.setTransform(s, 0, 0, s, V.dpr * mod(V.ox, T), V.dpr * mod(V.oy, T));
      ctx.fillStyle = pattern; ctx.fill();
      setWorld(V);
    }
    const deep = ctx.createLinearGradient(0, topY - 1.5, 0, topY - 32);
    deep.addColorStop(0, 'rgba(70,35,12,0)');
    deep.addColorStop(1, 'rgba(70,35,12,0.55)');
    ctx.fillStyle = deep; ctx.fill();

    const runs = surfaceRuns(pts, water);
    ctx.save();
    ctx.clip();                         // everything below stays inside the ground
    // --- topsoil band along the whole surface
    surfacePath(ctx, pts);
    ctx.lineWidth = 2 * Math.max(0.95, 5 / z); ctx.strokeStyle = TERRAIN.topsoil; ctx.stroke();
    // --- rock faces
    ctx.beginPath();
    for (let i = 0; i < runs.length; i++) if (runs[i].type === 'rock') runPath(ctx, runs[i]);
    ctx.lineWidth = 2 * Math.max(0.6, 3.5 / z); ctx.strokeStyle = TERRAIN.rock; ctx.stroke();
    if (z >= 8) {
      ctx.lineWidth = Math.max(0.06, 1 / z); ctx.strokeStyle = TERRAIN.rockLine;
      ctx.beginPath();
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].type !== 'rock') continue;
        const P = runs[i].pts;
        for (let k = 0; k + 1 < P.length; k++) {
          const a = P[k], b = P[k + 1];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.floor(len / 1.3);
          for (let j = 1; j <= n; j++) {
            const t = j / (n + 1), x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
            const dir = (b[0] - a[0]) >= 0 ? -1 : 1;     // crack goes into the rock
            const l = 0.25 + 0.3 * hash2(Math.round(x * 10), Math.round(y * 10));
            ctx.moveTo(x, y); ctx.lineTo(x + dir * 0.1, y - l);
          }
        }
      }
      ctx.stroke();
    }
    // --- embedded stones
    if (!V.lite) drawStones(V, g);
    // --- sand under water
    ctx.beginPath();
    const sandD = Math.max(0.3, 2.4 / z), stepS = Math.max(0.25, 3 / z);
    for (let i = 0; i < runs.length; i++) if (runs[i].type === 'sand') bandPath(ctx, runs[i], stepS, function () { return sandD; });
    ctx.fillStyle = TERRAIN.sand; ctx.fill();
    // --- grass strip with a scalloped lower edge
    const gD = Math.max(0.3, 2.6 / z), per = Math.max(0.85, 9 / z), stepG = Math.max(0.12, 2 / z);
    const gDepth = function (x) { return gD * (0.85 + 0.38 * (0.5 + 0.5 * Math.cos(TAU * x / per))); };
    const gDepthDark = function (x) { return gDepth(x) + Math.max(0.1, 1.2 / z); };
    ctx.beginPath();
    for (let i = 0; i < runs.length; i++) if (runs[i].type === 'grass') bandPath(ctx, runs[i], stepG, gDepthDark);
    ctx.fillStyle = TERRAIN.grassDark; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < runs.length; i++) if (runs[i].type === 'grass') bandPath(ctx, runs[i], stepG, gDepth);
    ctx.fillStyle = TERRAIN.grass; ctx.fill();
    if (z >= 6) {
      const hlw = Math.max(0.07, 1.4 / z);
      ctx.beginPath();
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].type !== 'grass') continue;
        const P = runs[i].pts;
        ctx.moveTo(P[0][0], P[0][1] - hlw * 1.6);
        for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1] - hlw * 1.6);
      }
      ctx.lineWidth = hlw; ctx.strokeStyle = TERRAIN.grassLight; ctx.stroke();
    }
    ctx.restore();

    // --- dark comic outline
    surfacePath(ctx, pts);
    ctx.lineWidth = Math.max(0.13, 2.3 / z); ctx.strokeStyle = TERRAIN.outline; ctx.stroke();

    // --- decoration on top of the surface
    if (!V.lite) {
      drawBoulders(V, runs);
      if (z >= 9) drawTufts(V, runs);
    }
  }

  function drawStones(V, g) {
    const ctx = V.ctx, z = V.z;
    if (z < 5) return;
    const list = [];
    const scales = [
      { sp: 1.7, dmin: 0.9, dmax: 4.5, rmin: 0.16, rmax: 0.42, p: 0.5, seed: 11 },
      { sp: 4.6, dmin: 3, dmax: 14, rmin: 0.45, rmax: 1.0, p: 0.55, seed: 23 },
    ];
    for (let si = 0; si < scales.length; si++) {
      const S = scales[si];
      for (let k = Math.floor((V.minX - 2) / S.sp); k <= Math.ceil((V.maxX + 2) / S.sp); k++) {
        if (hash2(k, S.seed) < S.p) continue;
        const x = (k + hash2(k, S.seed + 1)) * S.sp;
        const y = surfaceY(g, x) - (S.dmin + hash2(k, S.seed + 2) * (S.dmax - S.dmin));
        const r = S.rmin + hash2(k, S.seed + 3) * (S.rmax - S.rmin);
        if (r * z < 2.2 || y < V.minY - 2 || y > V.maxY + 2) continue;
        // keep stones inside the ground near canyon walls
        if (surfaceY(g, x - r * 1.5) < y + r * 1.2 || surfaceY(g, x + r * 1.5) < y + r * 1.2) continue;
        list.push(x, y, r * 1.35, r, (hash2(k, S.seed + 4) - 0.5) * 0.8);
      }
    }
    if (!list.length) return;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 5) {
      const x = list[i], y = list[i + 1], rx = list[i + 2], ry = list[i + 3], a = list[i + 4];
      ctx.moveTo(x + rx * Math.cos(a), y + rx * Math.sin(a));
      ctx.ellipse(x, y, rx, ry, a, 0, TAU);
    }
    ctx.fillStyle = TERRAIN.stone; ctx.fill();
    ctx.lineWidth = Math.max(0.04, 1.1 / z); ctx.strokeStyle = TERRAIN.stoneEdge; ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 5) {
      const x = list[i] - list[i + 2] * 0.22, y = list[i + 1] + list[i + 3] * 0.3, rx = list[i + 2] * 0.45, ry = list[i + 3] * 0.32, a = list[i + 4];
      ctx.moveTo(x + rx * Math.cos(a), y + rx * Math.sin(a));
      ctx.ellipse(x, y, rx, ry, a, 0, TAU);
    }
    ctx.fillStyle = TERRAIN.stoneLight; ctx.fill();
  }

  /** A few half-buried boulders lying on the grass. */
  function drawBoulders(V, runs) {
    const ctx = V.ctx, z = V.z;
    if (z < 6) return;
    const sp = 6.5, list = [];
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].type !== 'grass') continue;
      const P = runs[i].pts;
      for (let s = 0; s + 1 < P.length; s++) {
        const a = P[s], b = P[s + 1];
        if (b[0] < V.minX - 1 || a[0] > V.maxX + 1 || b[0] - a[0] < 1.4) continue;
        for (let k = Math.ceil(a[0] / sp); k * sp < b[0]; k++) {
          if (hash2(k, 71) < 0.72) continue;
          const x = k * sp + (hash2(k, 72) - 0.5) * 2;
          if (x < a[0] + 0.6 || x > b[0] - 0.6) continue;
          const y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
          const r = 0.28 + hash2(k, 73) * 0.25;
          list.push(x, y + r * 0.25, r);
        }
      }
    }
    if (!list.length) return;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) {
      const x = list[i], y = list[i + 1], r = list[i + 2];
      ctx.moveTo(x + r * 1.3, y); ctx.ellipse(x, y, r * 1.3, r * 0.85, 0, 0, TAU);
    }
    ctx.fillStyle = TERRAIN.stone; ctx.fill();
    ctx.lineWidth = Math.max(0.05, 1.4 / z); ctx.strokeStyle = TERRAIN.stoneEdge; ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) {
      const x = list[i] - list[i + 2] * 0.35, y = list[i + 1] + list[i + 2] * 0.3, r = list[i + 2] * 0.35;
      ctx.moveTo(x + r * 1.2, y); ctx.ellipse(x, y, r * 1.2, r * 0.7, 0, 0, TAU);
    }
    ctx.fillStyle = TERRAIN.stoneLight; ctx.fill();
  }

  /** Grass tufts and a few flowers on the grass runs (world-anchored positions). */
  function drawTufts(V, runs) {
    const ctx = V.ctx, z = V.z;
    const sp = 0.85;
    const flowers = [];
    ctx.beginPath();
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].type !== 'grass') continue;
      const P = runs[i].pts;
      for (let s = 0; s + 1 < P.length; s++) {
        const a = P[s], b = P[s + 1];
        if (b[0] < V.minX - 1 || a[0] > V.maxX + 1 || b[0] - a[0] < 1e-6) continue;
        for (let k = Math.ceil(a[0] / sp); k * sp < b[0]; k++) {
          if (hash2(k, 5) < 0.3) continue;
          const x = k * sp + (hash2(k, 6) - 0.5) * 0.4;
          if (x < a[0] || x >= b[0]) continue;
          const y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]) - 0.05;
          const sc = 0.75 + 0.6 * hash2(k, 7);
          ctx.moveTo(x - 0.1 * sc, y); ctx.quadraticCurveTo(x - 0.15 * sc, y + 0.2 * sc, x - 0.3 * sc, y + 0.34 * sc);
          ctx.moveTo(x, y); ctx.quadraticCurveTo(x - 0.02 * sc, y + 0.3 * sc, x + 0.05 * sc, y + 0.5 * sc);
          ctx.moveTo(x + 0.1 * sc, y); ctx.quadraticCurveTo(x + 0.16 * sc, y + 0.22 * sc, x + 0.32 * sc, y + 0.3 * sc);
          if (hash2(k, 8) > 0.87) flowers.push(x + 0.05 * sc, y + 0.5 * sc, (hash2(k, 9) * 3) | 0);
        }
      }
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.065, 1.25 / z); ctx.strokeStyle = TERRAIN.tuft; ctx.stroke();
    if (!flowers.length) return;
    const cols = ['#ffffff', '#ffd23f', '#ff7eb6'];
    const r = Math.max(0.085, 1.6 / z);
    for (let c = 0; c < 3; c++) {
      ctx.beginPath();
      for (let i = 0; i < flowers.length; i += 3) {
        if (flowers[i + 2] !== c) continue;
        ctx.moveTo(flowers[i] + r, flowers[i + 1]); ctx.arc(flowers[i], flowers[i + 1], r, 0, TAU);
      }
      ctx.fillStyle = cols[c]; ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < flowers.length; i += 3) {
      ctx.moveTo(flowers[i] + r * 0.4, flowers[i + 1]); ctx.arc(flowers[i], flowers[i + 1], r * 0.4, 0, TAU);
    }
    ctx.fillStyle = '#f59e0b'; ctx.fill();
  }

  function drawStartSign(V, level) {
    if (!isNum(level.startX)) return;
    const g = level.ground || [];
    const x = level.startX + 0.6;
    if (x + 2 < V.minX || x - 2 > V.maxX) return;
    const gy = g.length ? surfaceY(g, x) : 0;
    const ctx = V.ctx, z = V.z, ol = Math.max(0.05, 1.2 / z);
    setWorld(V);
    ctx.lineJoin = 'round';
    ctx.beginPath(); rrect(ctx, x - 0.08, gy - 0.3, 0.16, 2.7, 0.04);
    ctx.fillStyle = '#8a5a2e'; ctx.fill(); ctx.lineWidth = ol; ctx.strokeStyle = '#3a2414'; ctx.stroke();
    const bw = 1.5, bh = 0.78, by = gy + 2.05, cy = by + bh / 2;
    ctx.beginPath(); rrect(ctx, x - bw / 2, by, bw, bh, 0.16);
    ctx.fillStyle = '#34c26f'; ctx.fill(); ctx.strokeStyle = '#145a31'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 0.5, cy - 0.1); ctx.lineTo(x + 0.1, cy - 0.1); ctx.lineTo(x + 0.1, cy - 0.25);
    ctx.lineTo(x + 0.52, cy); ctx.lineTo(x + 0.1, cy + 0.25); ctx.lineTo(x + 0.1, cy + 0.1);
    ctx.lineTo(x - 0.5, cy + 0.1); ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.fill();
  }

  function drawGrid(V, level, mode) {
    const b = level.build;
    if (!b || !isNum(b.minX) || !isNum(b.maxX) || !isNum(b.minY) || !isNum(b.maxY)) return;
    const g = Array.isArray(level.ground) ? level.ground : [];
    const ctx = V.ctx, z = V.z;
    setScreen(V);
    if (mode === 'build') {
      // faint build-area tint so players see where nodes may go
      const x0 = V.ox + b.minX * z, x1 = V.ox + b.maxX * z, y0 = V.oy - b.maxY * z, y1 = V.oy - b.minY * z;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    const step = z >= 13 ? 1 : (z >= 6.5 ? 2 : 5);
    const xa = Math.ceil(Math.max(b.minX, V.minX - 1) / step) * step;
    const xb = Math.min(b.maxX, V.maxX + 1);
    const ya = Math.ceil(Math.max(b.minY, V.minY - 1) / step) * step;
    const yb = Math.min(b.maxY, V.maxY + 1);
    const r = step === 1 ? clamp(z * 0.06, 1.4, 2.6) : 1.4;
    const R = r + 1.3;
    const minor = [], major = [];
    for (let x = xa; x <= xb; x += step) {
      const sy = g.length > 1 ? surfaceY(g, x) : -Infinity;
      for (let y = ya; y <= yb; y += step) {
        if (g.length > 1) {
          if (mode === 'leveledit') {
            // level editor: anchors may sit on the surface / cliff faces → keep dots on the ground line
            if (y < sy - 1e-6 && !nearGround(g, x, y, 0.05)) continue;
          } else {
            if (y < sy - 1e-6) continue;                                    // inside terrain
            if (nearGround(g, x, y, 0.5)) continue;                          // too close (SPEC §4)
          }
        }
        ((x % 5 === 0 && y % 5 === 0) ? major : minor).push(V.ox + x * z, V.oy - y * z);
      }
    }
    // dark halo then white dot (readable on sky and on hills)
    ctx.beginPath();
    for (let i = 0; i < minor.length; i += 2) { ctx.moveTo(minor[i] + R, minor[i + 1]); ctx.arc(minor[i], minor[i + 1], R, 0, TAU); }
    for (let i = 0; i < major.length; i += 2) { ctx.moveTo(major[i] + R + 1, major[i + 1]); ctx.arc(major[i], major[i + 1], R + 1, 0, TAU); }
    ctx.fillStyle = 'rgba(20,50,80,0.2)'; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < minor.length; i += 2) { ctx.moveTo(minor[i] + r, minor[i + 1]); ctx.arc(minor[i], minor[i + 1], r, 0, TAU); }
    for (let i = 0; i < major.length; i += 2) { ctx.moveTo(major[i] + r + 1, major[i + 1]); ctx.arc(major[i], major[i + 1], r + 1, 0, TAU); }
    ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fill();
  }

  /** Anchor plates (static, behind the beams). The center bolts are drawn per frame on top. */
  function drawAnchorPlates(V, level) {
    const an = level.anchors;
    if (!Array.isArray(an) || !an.length) return;
    const ctx = V.ctx, z = V.z;
    // small level-card thumbnails (V.lite): small fixed-pixel plates, otherwise they dominate the picture
    const h = V.lite ? 2.6 / z : Math.max(0.5, 7.5 / z), ol = V.lite ? 0.8 / z : Math.max(0.06, 1.4 / z);
    setWorld(V);
    ctx.lineJoin = 'round';
    const vis = [];
    for (let i = 0; i < an.length; i++) {
      const a = an[i];
      if (!a || !isNum(a[0]) || !isNum(a[1])) continue;
      if (a[0] + h < V.minX || a[0] - h > V.maxX || a[1] + h < V.minY || a[1] - h > V.maxY) continue;
      vis.push(a[0], a[1]);
    }
    if (!vis.length) return;
    ctx.beginPath();
    for (let i = 0; i < vis.length; i += 2) rrect(ctx, vis[i] - h, vis[i + 1] - h, 2 * h, 2 * h, h * 0.32);
    ctx.fillStyle = '#6a7582'; ctx.fill();
    ctx.lineWidth = ol; ctx.strokeStyle = '#20262d'; ctx.stroke();
    if (h * z >= 9) {
      // bevel highlight + corner bolts
      ctx.beginPath();
      for (let i = 0; i < vis.length; i += 2) rrect(ctx, vis[i] - h * 0.8, vis[i + 1] - h * 0.8, 1.6 * h, 1.6 * h, h * 0.22);
      ctx.lineWidth = Math.max(0.03, 0.9 / z); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.stroke();
      const br = h * 0.13, d = h * 0.6;
      ctx.beginPath();
      for (let i = 0; i < vis.length; i += 2) {
        for (let k = 0; k < 4; k++) {
          const bx = vis[i] + (k & 1 ? d : -d), by = vis[i + 1] + (k & 2 ? d : -d);
          ctx.moveTo(bx + br, by); ctx.arc(bx, by, br, 0, TAU);
        }
      }
      ctx.fillStyle = '#c9d0d8'; ctx.fill();
      ctx.lineWidth = Math.max(0.025, 0.8 / z); ctx.strokeStyle = '#20262d'; ctx.stroke();
    }
  }

  function drawTag(V, sx, sy, text, bg, fg, font) {
    const ctx = V.ctx;
    ctx.font = font || ('700 13px ' + FONT);
    const w = ctx.measureText(text).width + 14, h = 22;
    const x = clamp(sx - w / 2, 4, V.W - w - 4), y = clamp(sy - h / 2, 4, V.H - h - 4);
    ctx.beginPath(); rrect(ctx, x, y, w, h, 7);
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  }

  /** Level editor extras that do not change while hovering: build frame and marker labels. */
  function drawLevelEditStatic(V, level) {
    const ctx = V.ctx, z = V.z;
    const g = Array.isArray(level.ground) ? level.ground : [];
    setScreen(V);
    const b = level.build;
    if (b && isNum(b.minX) && isNum(b.maxX) && isNum(b.minY) && isNum(b.maxY)) {
      const x0 = V.ox + b.minX * z, x1 = V.ox + b.maxX * z, y0 = V.oy - b.maxY * z, y1 = V.oy - b.minY * z;
      ctx.setLineDash([9, 6]);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,40,70,0.35)'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash(NO_DASH);
      ctx.font = '700 12px ' + FONT;
      const tw = ctx.measureText('Baubereich').width;
      drawTag(V, x0 + tw / 2 + 14, y0 + 16, 'Baubereich', 'rgba(255,255,255,0.9)', '#1d3557', '700 12px ' + FONT);
    }
    if (isNum(level.startX)) {
      const gy = g.length ? surfaceY(g, level.startX + 0.6) : 0;
      drawTag(V, V.ox + (level.startX + 0.6) * z, V.oy - (gy + 3.2) * z - 14, 'Start', '#34c26f', '#ffffff');
    }
    if (isNum(level.flagX)) {
      const gy = g.length ? surfaceY(g, level.flagX) : 0;
      drawTag(V, V.ox + (level.flagX + 1) * z, V.oy - (gy + 5.7) * z - 16, 'Ziel', '#1d1f22', '#ffffff');
    }
  }

  // ===========================================================================
  // Dynamic world: flag, water, hydraulics, ships, checkpoints
  // ===========================================================================
  const flagXs = new Float64Array(8), flagYs = new Float64Array(8);

  /** Hydraulic pistons: a cylinder sleeve near the pivot and a rod reaching to the (possibly
   *  moving) head. Uses the live simulation state when testing, else the level's starting pose. */
  function drawPistons(V, level, sim) {
    const defs = Array.isArray(level.pistons) ? level.pistons : [];
    if (!defs.length) return;
    const ctx = V.ctx, z = V.z;
    const live = sim && sim._s && sim._s.pistons;
    setWorld(V);
    ctx.lineCap = 'round';
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      let px, py, hx, hy;
      if (live && live[i]) { px = live[i].pivot.x; py = live[i].pivot.y; hx = live[i].head.x; hy = live[i].head.y; }
      else {
        const rad = num(d.angleDeg, 0) * Math.PI / 180;
        const len = isNum(d.startLen) ? d.startLen : num(d.minLen, 1);
        px = d.pivotX; py = d.pivotY; hx = px + Math.cos(rad) * len; hy = py + Math.sin(rad) * len;
      }
      if (!isNum(px) || !isNum(hx)) continue;
      if (Math.max(px, hx) + 1 < V.minX || Math.min(px, hx) - 1 > V.maxX) continue;
      const dx = hx - px, dy = hy - py, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const sleeve = Math.min(L * 0.4, 1.3);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + ux * sleeve, py + uy * sleeve);
      ctx.lineWidth = Math.max(0.1, 7 / z); ctx.strokeStyle = '#6b7280'; ctx.stroke();
      ctx.lineWidth = Math.max(0.06, 4.6 / z); ctx.strokeStyle = '#aeb4bd'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px + ux * sleeve * 0.7, py + uy * sleeve * 0.7); ctx.lineTo(hx, hy);
      ctx.lineWidth = Math.max(0.05, 3.2 / z); ctx.strokeStyle = '#dfe3e8'; ctx.stroke();
      ctx.lineWidth = Math.max(0.02, 1.2 / z); ctx.strokeStyle = '#8a8f98'; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, Math.max(0.12, 3 / z), 0, TAU); ctx.fillStyle = '#3f4349'; ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, Math.max(0.1, 2.4 / z), 0, TAU); ctx.fillStyle = '#3f4349'; ctx.fill();
    }
  }

  /** Passage gates (classic fallback): dashed frame in the bridge plane with the vessel's front-view outline. */
  function drawShips(V, level, sim) {
    const defs = BB.Gates ? BB.Gates.of(level) : [];
    if (!defs.length) return;
    const ctx = V.ctx, z = V.z;
    setWorld(V);
    for (let i = 0; i < defs.length; i++) {
      const g = defs[i], live = sim && sim.gates && sim.gates[i];
      const w = g.x1 - g.x0, h = g.y1 - g.y0, cx = (g.x0 + g.x1) / 2;
      const blocked = live && live.state === 'blocked';
      ctx.save();
      ctx.globalAlpha = 0.55;
      const bw = Math.min(w * 0.7, 7), hullH = Math.min(1.3, h * 0.3);
      ctx.beginPath(); ctx.moveTo(cx - bw / 2, g.y0 + hullH); ctx.lineTo(cx - bw * 0.36, g.y0); ctx.lineTo(cx + bw * 0.36, g.y0); ctx.lineTo(cx + bw / 2, g.y0 + hullH); ctx.closePath();
      ctx.fillStyle = g.kind === 'ship' ? '#34495e' : '#7a8794'; ctx.fill();
      ctx.lineWidth = Math.max(0.04, 1.2 / z); ctx.strokeStyle = '#1b2733'; ctx.stroke();
      ctx.beginPath(); rrect(ctx, cx - bw * 0.3, g.y0 + hullH, bw * 0.6, Math.max(0.4, h * 0.3), 0.08); ctx.fillStyle = '#5d6d7e'; ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([0.7, 0.45]); ctx.lineWidth = Math.max(0.05, 2 / z); ctx.strokeStyle = blocked ? '#d93b30' : '#c98a00';
      ctx.strokeRect(g.x0, g.y0, w, h);
      ctx.restore();
    }
  }

  // Per-world colour grade (screen-space overlay) – cheap but gives each world a distinct mood
  // without re-deriving every background drawing routine.
  const WORLD_TINT = {
    'wuesten-canyon': 'rgba(255,176,86,0.14)',
    hafenstadt: 'rgba(50,130,150,0.10)',
    winterberge: 'rgba(205,228,248,0.20)',
    'industrie-nacht': 'rgba(8,10,24,0.60)',
  };
  function drawWorldTint(V, level) {
    const c = WORLD_TINT[level.world];
    if (!c) return;
    setScreen(V);
    V.ctx.fillStyle = c;
    V.ctx.fillRect(0, 0, V.W, V.H);
  }

  /** Icy pale wash + drifting wind streaks – cheap full-viewport weather ambience (screen space). */
  function drawWeather(V, level, t) {
    const ice = !!level.ice, wind = num(level.wind, 0);
    if (!ice && wind === 0) return;
    const ctx = V.ctx, W = V.W, H = V.H;
    setScreen(V);
    if (ice) {
      ctx.fillStyle = 'rgba(214,238,250,0.16)';
      ctx.fillRect(0, 0, W, H);
    }
    if (wind !== 0) {
      const dir = wind > 0 ? 1 : -1, speed = Math.min(6, Math.abs(wind)) * 90;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.4;
      const n = 10;
      for (let i = 0; i < n; i++) {
        const row = i / n, y = H * row;
        const off = mod(t * speed + i * 137, W + 160) - 80;
        const x = dir > 0 ? off : W - off;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dir * 46, y + 7);
        ctx.stroke();
      }
    }
  }

  /** Checkpoint posts on the deck/ground that advance the hydraulics phase when crossed. */
  function drawCheckpoints(V, level, t) {
    const cps = Array.isArray(level.checkpoints) ? level.checkpoints : [];
    if (!cps.length) return;
    const ctx = V.ctx, z = V.z, g = level.ground || [];
    setWorld(V);
    for (let i = 0; i < cps.length; i++) {
      const x = cps[i] && cps[i].x;
      if (!isNum(x) || x + 1 < V.minX || x - 1 > V.maxX) continue;
      const gy = g.length ? surfaceY(g, x) : 0, h = 2.0;
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy + h);
      ctx.lineWidth = Math.max(0.05, 1.6 / z); ctx.strokeStyle = '#2b3036'; ctx.stroke();
      const flap = Math.sin((t || 0) * 4 - i) * 0.06;
      ctx.beginPath();
      ctx.moveTo(x, gy + h); ctx.lineTo(x + 0.5, gy + h - 0.18 + flap); ctx.lineTo(x, gy + h - 0.36);
      ctx.closePath(); ctx.fillStyle = '#ffb703'; ctx.fill();
    }
  }

  function drawFlag(V, level, t) {
    if (!isNum(level.flagX)) return;
    const g = level.ground || [];
    const x = level.flagX;
    const gy = g.length ? surfaceY(g, x) : 0;
    if (x + 4 < V.minX || x - 1 > V.maxX || gy - 1 > V.maxY || gy + 6.5 < V.minY) return;
    const ctx = V.ctx, z = V.z, ol = Math.max(0.05, 1.2 / z);
    const poleH = 5.2, pw = Math.max(0.14, 2.2 / z);
    setWorld(V);
    ctx.lineJoin = 'round';
    // base block
    ctx.beginPath(); rrect(ctx, x - 0.42, gy - 0.25, 0.84, 0.5, 0.1);
    ctx.fillStyle = '#9aa3ad'; ctx.fill(); ctx.lineWidth = ol; ctx.strokeStyle = '#3b424a'; ctx.stroke();
    // pole
    ctx.beginPath(); ctx.moveTo(x, gy + 0.2); ctx.lineTo(x, gy + poleH);
    ctx.lineCap = 'round';
    ctx.lineWidth = pw + 2 * ol; ctx.strokeStyle = '#3b424a'; ctx.stroke();
    ctx.lineWidth = pw; ctx.strokeStyle = '#f1f3f6'; ctx.stroke();
    // golden ball
    ctx.beginPath(); ctx.arc(x, gy + poleH + 0.12, Math.max(0.18, 2.6 / z), 0, TAU);
    ctx.fillStyle = '#ffcf33'; ctx.fill(); ctx.lineWidth = ol; ctx.stroke();
    // waving checkered cloth
    const cols = 6, rows = 4, fw = 2.3, fh = 1.5, top = gy + poleH - 0.12, ch = fh / rows;
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      flagXs[i] = x + pw / 2 + u * fw * (1 - 0.03 * Math.sin(t * 3.1));
      flagYs[i] = top + Math.sin(t * 5.5 - i * 0.95) * 0.17 * u;
    }
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if ((i + j) % 2 !== pass) continue;
          ctx.moveTo(flagXs[i], flagYs[i] - j * ch);
          ctx.lineTo(flagXs[i + 1], flagYs[i + 1] - j * ch);
          ctx.lineTo(flagXs[i + 1], flagYs[i + 1] - (j + 1) * ch);
          ctx.lineTo(flagXs[i], flagYs[i] - (j + 1) * ch);
          ctx.closePath();
        }
      }
      ctx.fillStyle = pass ? '#ffffff' : '#1d1f22'; ctx.fill();
    }
    // fold shading
    ctx.beginPath();
    for (let i = 0; i < cols; i++) {
      if (flagYs[i + 1] >= flagYs[i]) continue;
      ctx.moveTo(flagXs[i], flagYs[i]); ctx.lineTo(flagXs[i + 1], flagYs[i + 1]);
      ctx.lineTo(flagXs[i + 1], flagYs[i + 1] - fh); ctx.lineTo(flagXs[i], flagYs[i] - fh); ctx.closePath();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(flagXs[0], flagYs[0]);
    for (let i = 1; i <= cols; i++) ctx.lineTo(flagXs[i], flagYs[i]);
    for (let i = cols; i >= 0; i--) ctx.lineTo(flagXs[i], flagYs[i] - fh);
    ctx.closePath();
    ctx.lineWidth = ol; ctx.strokeStyle = '#1d1f22'; ctx.stroke();
  }

  function waveY(x, w, t, A) {
    return w + A * (0.6 * Math.sin(x * 1.15 + t * 1.9) + 0.4 * Math.sin(x * 2.3 - t * 1.3));
  }

  /** Animated water body in front of everything under the surface (semi-transparent). */
  function drawWater(V, level, t) {
    if (!isNum(level.water)) return;
    const g = level.ground;
    if (!Array.isArray(g) || g.length < 2) return;
    const w = level.water;
    if (w + 0.5 < V.minY) return;
    const ctx = V.ctx, z = V.z;
    const basins = waterBasins(g, w, Math.min(g[0][0], V.minX) - 2, Math.max(g[g.length - 1][0], V.maxX) + 2);
    if (!basins.length) return;
    setWorld(V);
    ctx.lineJoin = 'round';
    const A = Math.max(0.09, 1.5 / z);
    const step = Math.max(0.2, 6 / z);
    for (let bi = 0; bi < basins.length; bi++) {
      const B = basins[bi];
      const n = B.length >> 1;
      const bx0 = B[0], bx1 = B[B.length - 2];
      if (bx1 < V.minX - 1 || bx0 > V.maxX + 1) continue;
      let deep = w;
      for (let i = 1; i < B.length; i += 2) deep = Math.min(deep, B[i]);
      const xa = Math.max(bx0, V.minX - 1), xb = Math.min(bx1, V.maxX + 1);
      // wave top (only the visible part is sampled finely)
      function topPath(move) {
        if (move) ctx.moveTo(bx0, waveY(bx0, w, t, A)); else ctx.lineTo(bx0, waveY(bx0, w, t, A));
        for (let x = xa; x < xb; x += step) ctx.lineTo(x, waveY(x, w, t, A));
        ctx.lineTo(bx1, waveY(bx1, w, t, A));
      }
      ctx.beginPath();
      topPath(true);
      // bottom: the underwater ground, pushed slightly into the terrain so the water
      // visibly covers the underwater surface edge
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(B[2 * i], B[2 * i + 1] - 0.4);
      ctx.closePath();
      const grd = ctx.createLinearGradient(0, w, 0, Math.min(deep, w - 3) - 0.5);
      grd.addColorStop(0, 'rgba(80,190,240,0.78)');
      grd.addColorStop(1, 'rgba(24,96,178,0.9)');
      ctx.fillStyle = grd; ctx.fill();
      // light band under the surface
      ctx.beginPath();
      ctx.moveTo(bx0, waveY(bx0, w, t, A) - 0.16);
      for (let x = xa; x < xb; x += step) ctx.lineTo(x, waveY(x, w, t, A) - 0.16);
      ctx.lineTo(bx1, waveY(bx1, w, t, A) - 0.16);
      ctx.lineWidth = Math.max(0.2, 3.5 / z); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineCap = 'butt'; ctx.stroke();
      // bright surface line
      ctx.beginPath(); topPath(true);
      ctx.lineWidth = Math.max(0.09, 2.4 / z); ctx.strokeStyle = '#d9f4ff'; ctx.lineCap = 'round'; ctx.stroke();
      // drifting highlight streaks
      if (z >= 5) {
        const sp = 2.6, depthMax = Math.min(3.2, w - deep - 0.4);
        if (depthMax > 0.3) {
          ctx.beginPath();
          for (let k = Math.floor(xa / sp) - 1; k <= Math.ceil(xb / sp); k++) {
            const h = hash2(k, 21);
            const x = k * sp + mod(t * 0.35 + h * sp, sp);
            const y = w - 0.35 - hash2(k, 22) * depthMax;
            const len = 0.4 + hash2(k, 23) * 0.8;
            if (x < bx0 + 0.3 || x + len > bx1 - 0.3) continue;
            if (surfaceY(g, x) > y - 0.2 || surfaceY(g, x + len) > y - 0.2) continue;
            ctx.moveTo(x, y); ctx.lineTo(x + len, y);
          }
          ctx.lineWidth = Math.max(0.06, 1.6 / z); ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.stroke();
        }
      }
      // little foam blobs at the shore lines
      if (z >= 6) {
        ctx.beginPath();
        const fr = Math.max(0.12, 2.5 / z);
        for (let e = 0; e < 2; e++) {
          const x = e ? bx1 : bx0;
          if (x <= V.minX - 1 || x >= V.maxX + 1) continue;
          const dir = e ? -1 : 1;
          for (let k = 0; k < 3; k++) {
            const fx = x + dir * (0.15 + k * 0.32), fy = waveY(fx, w, t, A) + 0.02 + 0.05 * Math.sin(t * 3 + k * 2);
            ctx.moveTo(fx + fr * (1 - k * 0.2), fy); ctx.arc(fx, fy, fr * (1 - k * 0.2), 0, TAU);
          }
        }
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
      }
    }
  }

  // ===========================================================================
  // Beams
  // ===========================================================================
  const styleCache = Object.create(null);
  /** Visual style for material key m (dark = debris variant). */
  function styleFor(m, dark) {
    const key = (dark ? 'd:' : 'n:') + m;
    let st = styleCache[key];
    if (st) return st;
    let base = MAT_STYLE[m];
    if (!base) {
      // unknown material: derive from BB.MATERIALS data if present
      const md = BB.MATERIALS && BB.MATERIALS[m];
      const col = md && parseColor(md.color) ? md.color : '#9a9a9a';
      if (md && md.tensionOnly) base = Object.assign({}, MAT_STYLE.rope, { body: col });
      else if (md && md.drivable) base = Object.assign({}, MAT_STYLE.road, { body: col });
      else base = Object.assign({}, MAT_STYLE.wood, { body: col, top: shade(col, 0.3), grain: shade(col, -0.3), edge: shade(col, -0.6) });
    }
    st = Object.assign({}, base);
    if (dark) STYLE_COLOR_KEYS.forEach(function (k) { if (st[k]) st[k] = shade(st[k], -0.3); });
    styleCache[key] = st;
    return st;
  }

  function isTensionOnly(m) {
    if (m === 'rope') return true;
    const md = BB.MATERIALS && BB.MATERIALS[m];
    return !!(md && md.tensionOnly);
  }

  /** Fill a reusable segment record. n = unit normal pointing DOWN (world). */
  function setSeg(s, x1, y1, x2, y2, m) {
    s.x1 = x1; s.y1 = y1; s.x2 = x2; s.y2 = y2; s.m = m;
    s.sag = false; s.cx = 0; s.cy = 0; s.stress = 0;
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.sqrt(dx * dx + dy * dy);
    s.len = L;
    if (L < 1e-9) { s.nx = 0; s.ny = -1; }
    else if (dx > 0 || (dx === 0 && dy < 0)) { s.nx = dy / L; s.ny = -dx / L; }
    else { s.nx = -dy / L; s.ny = dx / L; }
    return s;
  }

  /** Build a path of all segments offset by `off` meters along their down-normal. */
  function pathSegs(ctx, arr, off) {
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      const ox = s.nx * off, oy = s.ny * off;
      ctx.moveTo(s.x1 + ox, s.y1 + oy);
      if (s.sag) ctx.quadraticCurveTo(s.cx + ox, s.cy + oy, s.x2 + ox, s.y2 + oy);
      else ctx.lineTo(s.x2 + ox, s.y2 + oy);
    }
  }
  function strokeAs(ctx, w, color, cap) {
    ctx.lineWidth = w; ctx.strokeStyle = color; ctx.lineCap = cap || 'round'; ctx.stroke();
  }

  // Body metrics (center offset + thickness) per style, used for tinting and highlights.
  const bodyM = { c: 0, T: 0 };
  function bodyMetrics(st, z) {
    if (st.kind === 'road') {
      const T = Math.max(st.T, st.px / z);
      bodyM.T = T; bodyM.c = T / 2 - 0.04;
    } else if (st.kind === 'steelroad') {
      const Ta = Math.max(st.T, st.px / z), Tg = Math.max(st.Tg, st.pxg / z);
      const bot = Ta + Tg - 0.05;               // distance from beam line to girder bottom
      bodyM.T = bot + 0.04; bodyM.c = (bot - 0.04) / 2;
    } else {
      bodyM.T = Math.max(st.T, st.px / z); bodyM.c = 0;
    }
    return bodyM;
  }

  function drawRoadSegs(ctx, arr, z, st) {
    const T = Math.max(st.T, st.px / z), ol = Math.max(0.045, 1.2 / z);
    // Deck hangs below the beam line: the top surface ≈ the line the wheels roll on.
    const c = T / 2 - 0.04;
    pathSegs(ctx, arr, c);
    strokeAs(ctx, T + 2 * ol, st.edge);
    strokeAs(ctx, T, st.body);
    if (z > 9) {
      ctx.setLineDash([0.7, 0.55]);
      strokeAs(ctx, Math.max(0.06, 1.2 / z), st.line, 'butt');
      ctx.setLineDash(NO_DASH);
    }
    if (z > 6) {
      const hl = Math.max(0.05, 1.3 / z);
      pathSegs(ctx, arr, c - T / 2 + hl / 2);
      strokeAs(ctx, hl, st.top, 'butt');
    }
  }

  function drawSteelRoadSegs(ctx, arr, z, st) {
    const Ta = Math.max(st.T, st.px / z), Tg = Math.max(st.Tg, st.pxg / z), ol = Math.max(0.045, 1.2 / z);
    const ca = Ta / 2 - 0.04;                       // asphalt center
    const cg = Ta - 0.04 + Tg / 2 - 0.01;           // girder center (slight overlap)
    const bot = Ta + Tg - 0.05;
    pathSegs(ctx, arr, (bot - 0.04) / 2);
    strokeAs(ctx, bot + 0.04 + 2 * ol, st.edge);
    pathSegs(ctx, arr, cg);
    strokeAs(ctx, Tg, st.girder);
    if (z > 9) {
      ctx.setLineDash([0.001, 0.42]);
      strokeAs(ctx, Math.max(0.075, 1.7 / z), st.rivet, 'round');
      ctx.setLineDash(NO_DASH);
    }
    if (z > 6) {
      const fl = Math.max(0.05, 1.1 / z);
      pathSegs(ctx, arr, bot - fl / 2 - 0.005);
      strokeAs(ctx, fl, st.flange, 'butt');
    }
    pathSegs(ctx, arr, ca);
    strokeAs(ctx, Ta, st.body);
    pathSegs(ctx, arr, Ta - 0.04);
    strokeAs(ctx, ol * 0.9, st.edge, 'butt');
    if (z > 6) {
      const hl = Math.max(0.045, 1.2 / z);
      pathSegs(ctx, arr, -0.04 + hl / 2);
      strokeAs(ctx, hl, st.top, 'butt');
    }
  }

  function drawWoodSegs(ctx, arr, z, st) {
    const T = Math.max(st.T, st.px / z), ol = Math.max(0.045, 1.2 / z);
    pathSegs(ctx, arr, 0);
    strokeAs(ctx, T + 2 * ol, st.edge);
    strokeAs(ctx, T, st.body);
    if (z > 7) {
      const hl = Math.max(0.04, 1.1 / z);
      pathSegs(ctx, arr, -T / 2 + hl / 2 + 0.01);
      strokeAs(ctx, hl, st.top, 'butt');
    }
    if (z > 11) {
      const gw = Math.max(0.022, 0.75 / z);
      pathSegs(ctx, arr, 0.035);
      ctx.setLineDash([0.55, 0.18, 0.22, 0.3]);
      strokeAs(ctx, gw, st.grain, 'butt');
      pathSegs(ctx, arr, -0.045);
      ctx.setLineDash([0.3, 0.26, 0.75, 0.2]);
      strokeAs(ctx, gw, st.grain, 'butt');
      ctx.setLineDash(NO_DASH);
    }
  }

  function drawSteelSegs(ctx, arr, z, st) {
    const T = Math.max(st.T, st.px / z), ol = Math.max(0.045, 1.2 / z);
    pathSegs(ctx, arr, 0);
    strokeAs(ctx, T + 2 * ol, st.edge);
    strokeAs(ctx, T, st.body);
    if (z > 12) {
      // lightening holes along the web
      ctx.setLineDash([0.001, 0.5]);
      strokeAs(ctx, Math.max(0.1, 2 / z), st.hole, 'round');
      ctx.setLineDash(NO_DASH);
    }
    if (z > 6) {
      // I-beam flanges: light top flange, dark bottom flange
      const f = Math.max(0.055, 1.2 / z);
      pathSegs(ctx, arr, -T / 2 + f / 2);
      strokeAs(ctx, f, st.top, 'butt');
      pathSegs(ctx, arr, T / 2 - f / 2);
      strokeAs(ctx, f, st.flange, 'butt');
    }
  }

  function drawRopeSegs(ctx, arr, z, st) {
    const T = Math.max(st.T, st.px / z);
    pathSegs(ctx, arr, 0);
    strokeAs(ctx, T + 2 * Math.max(0.018, 0.55 / z), st.edge);
    strokeAs(ctx, T, st.body);
    if (z > 14) {
      // twisted strands
      ctx.setLineDash([0.09, 0.09]);
      strokeAs(ctx, T * 0.45, st.top, 'butt');
      ctx.setLineDash(NO_DASH);
    }
  }

  function drawSegsOfStyle(ctx, arr, z, st) {
    if (!arr.length) return;
    switch (st.kind) {
      case 'road': drawRoadSegs(ctx, arr, z, st); break;
      case 'steelroad': drawSteelRoadSegs(ctx, arr, z, st); break;
      case 'steel': drawSteelSegs(ctx, arr, z, st); break;
      case 'rope': drawRopeSegs(ctx, arr, z, st); break;
      default: drawWoodSegs(ctx, arr, z, st);
    }
  }

  /** Material → segment list buckets, reused every frame. */
  function Groups() { this.map = Object.create(null); this.keys = []; }
  Groups.prototype.reset = function () { for (let i = 0; i < this.keys.length; i++) this.map[this.keys[i]].length = 0; };
  Groups.prototype.add = function (m, s) {
    let a = this.map[m];
    if (!a) { a = this.map[m] = []; this.keys.push(m); }
    a.push(s);
  };
  Groups.prototype.draw = function (ctx, z, dark) {
    // unknown materials first, then the fixed back-to-front order
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (MAT_DRAW_ORDER.indexOf(k) < 0) drawSegsOfStyle(ctx, this.map[k], z, styleFor(k, dark));
    }
    for (let i = 0; i < MAT_DRAW_ORDER.length; i++) {
      const a = this.map[MAT_DRAW_ORDER[i]];
      if (a && a.length) drawSegsOfStyle(ctx, a, z, styleFor(MAT_DRAW_ORDER[i], dark));
    }
  };

  /** Bolt circles at (xs[i], ys[i]). */
  function drawBolts(V, xs, ys, n, r, fill, ring, inner) {
    if (!n) return;
    const ctx = V.ctx, z = V.z;
    ctx.beginPath();
    for (let i = 0; i < n; i++) { ctx.moveTo(xs[i] + r, ys[i]); ctx.arc(xs[i], ys[i], r, 0, TAU); }
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = Math.max(0.045, 1.3 / z) * (r > 0.25 ? 1.35 : 1); ctx.strokeStyle = ring; ctx.stroke();
    const rp = r * z;
    if (rp >= 4.5) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) { ctx.moveTo(xs[i] + r * 0.4, ys[i]); ctx.arc(xs[i], ys[i], r * 0.4, 0, TAU); }
      ctx.fillStyle = inner; ctx.fill();
    }
    if (rp >= 5.5) {
      ctx.beginPath();
      const hr = r * 0.26;
      for (let i = 0; i < n; i++) { const hx = xs[i] - r * 0.38, hy = ys[i] + r * 0.4; ctx.moveTo(hx + hr, hy); ctx.arc(hx, hy, hr, 0, TAU); }
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
    }
  }

  // ===========================================================================
  // Vehicles (drawn in the vehicle's local frame: meters, y up, front = +x)
  // ===========================================================================
  const defMemo = new WeakMap();
  function vehDef(v) {
    const src = v.def || (BB.VEHICLES && BB.VEHICLES[v.type]) || null;
    if (src && typeof src === 'object') {
      const m = defMemo.get(src);
      if (m) return m;
    }
    const fb = VEH_FALLBACK[v.type] || VEH_FALLBACK.car;
    const d = src || fb;
    const out = {
      length: num(d.length, fb.length) > 0 ? num(d.length, fb.length) : fb.length,
      height: num(d.height, fb.height) > 0 ? num(d.height, fb.height) : fb.height,
      wheelRadius: num(d.wheelRadius, fb.wheelRadius) > 0 ? num(d.wheelRadius, fb.wheelRadius) : fb.wheelRadius,
      axles: Array.isArray(d.axles) && d.axles.length ? d.axles : fb.axles,
      color: parseColor(d.color) ? d.color : fb.color,
    };
    if (src && typeof src === 'object') defMemo.set(src, out);
    return out;
  }

  function drawWheel(ctx, w, kind, z) {
    const r = w.r;
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(w.rot);
    const ol = Math.max(0.03, 1 / z);
    if (kind === 'bike') {
      // clamp: at very low zoom the minimum-stroke-width term (1.8/z) can exceed the
      // (small) bike wheel radius itself – never let the inner arc go negative.
      const tw = clamp(Math.max(r * 0.17, 1.8 / z), 0.001, r * 0.9);
      ctx.beginPath(); ctx.arc(0, 0, r - tw / 2, 0, TAU);
      ctx.lineWidth = tw; ctx.strokeStyle = '#25272b'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r - tw, 0, TAU);
      ctx.lineWidth = Math.max(r * 0.06, 0.8 / z); ctx.strokeStyle = '#a9b2bc'; ctx.stroke();
      if (r * z > 6) {
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = k * TAU / 8;
          ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * (r - tw), Math.sin(a) * (r - tw));
        }
        ctx.lineWidth = Math.max(0.014, 0.6 / z); ctx.strokeStyle = '#d4dae0'; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, Math.max(r * 0.13, 1.2 / z), 0, TAU);
      ctx.fillStyle = '#59616b'; ctx.fill();
    } else {
      const heavy = kind === 'heavy';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = '#26282c'; ctx.fill();
      ctx.lineWidth = ol; ctx.strokeStyle = '#0d0e10'; ctx.stroke();
      const rr = r * (heavy ? 0.6 : 0.58);
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU);
      ctx.fillStyle = heavy ? '#c4cbd3' : '#e1e6ec'; ctx.fill();
      ctx.lineWidth = ol * 0.8; ctx.strokeStyle = '#59616b'; ctx.stroke();
      if (rr * z > 3) {
        const n = heavy ? 6 : 5;
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const a = k * TAU / n;
          ctx.moveTo(Math.cos(a) * rr * 0.3, Math.sin(a) * rr * 0.3);
          ctx.lineTo(Math.cos(a) * rr * 0.86, Math.sin(a) * rr * 0.86);
        }
        ctx.lineWidth = Math.max(rr * 0.17, 1 / z); ctx.strokeStyle = '#8a939d'; ctx.lineCap = 'round'; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, rr * 0.3, 0, TAU);
      ctx.fillStyle = '#6c7580'; ctx.fill();
    }
    ctx.restore();
  }

  function drawWheelWells(ctx, wl, nw, yb, scale) {
    ctx.beginPath();
    for (let i = 0; i < nw; i++) {
      const w = wl[i], R = w.r * scale;
      ctx.moveTo(w.x + R, yb);
      ctx.arc(w.x, yb, R, 0, Math.PI);         // upper half (y up)
      ctx.closePath();
    }
    ctx.fillStyle = '#1b1d21'; ctx.fill();
  }

  function drawCar(ctx, d, wl, nw, z, col) {
    const L = d.length, Hh = d.height, hl = L / 2;
    const ol = Math.max(0.045, 1.1 / z), edge = '#1f2328';
    const yb = 0.1, ys = Hh * 0.56, yr = Hh;
    // body silhouette
    ctx.beginPath();
    ctx.moveTo(-hl + 0.18, yb);
    ctx.lineTo(hl - 0.22, yb);
    ctx.quadraticCurveTo(hl, yb, hl, yb + 0.22);
    ctx.lineTo(hl, ys - 0.2);
    ctx.quadraticCurveTo(hl, ys, hl - 0.3, ys + 0.02);
    ctx.lineTo(L * 0.2, ys + 0.08);
    ctx.quadraticCurveTo(L * 0.09, yr, -L * 0.04, yr);
    ctx.lineTo(-L * 0.24, yr);
    ctx.quadraticCurveTo(-L * 0.35, yr, -L * 0.4, ys + 0.06);
    ctx.lineTo(-hl + 0.12, ys);
    ctx.quadraticCurveTo(-hl, ys, -hl, ys - 0.2);
    ctx.lineTo(-hl, yb + 0.18);
    ctx.quadraticCurveTo(-hl, yb, -hl + 0.18, yb);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = ol; ctx.strokeStyle = edge; ctx.stroke();
    // shoulder highlight + lower shade
    ctx.beginPath(); ctx.moveTo(-hl + 0.2, ys - 0.12); ctx.lineTo(hl - 0.35, ys - 0.14);
    strokeAs(ctx, Math.max(0.06, 1.2 / z), shade(col, 0.35), 'round');
    ctx.beginPath(); ctx.moveTo(-hl + 0.25, yb + 0.14); ctx.lineTo(hl - 0.3, yb + 0.14);
    strokeAs(ctx, Math.max(0.1, 1.5 / z), shade(col, -0.22), 'round');
    // windows
    ctx.beginPath();
    ctx.moveTo(L * 0.18, ys + 0.1);
    ctx.quadraticCurveTo(L * 0.08, yr - 0.11, -L * 0.04, yr - 0.11);
    ctx.lineTo(-L * 0.23, yr - 0.11);
    ctx.quadraticCurveTo(-L * 0.31, yr - 0.11, -L * 0.35, ys + 0.1);
    ctx.closePath();
    ctx.fillStyle = '#bfe8ff'; ctx.fill();
    ctx.lineWidth = ol * 0.8; ctx.strokeStyle = edge; ctx.stroke();
    // driver silhouette + B-pillar + glare
    ctx.beginPath(); ctx.arc(-L * 0.12, ys + 0.33, 0.13, 0, TAU);
    ctx.fillStyle = 'rgba(40,52,64,0.45)'; ctx.fill();
    ctx.fillStyle = col;
    ctx.fillRect(-L * 0.095, ys + 0.08, L * 0.035, yr - ys - 0.17);
    ctx.beginPath();
    ctx.moveTo(L * 0.1, ys + 0.14); ctx.lineTo(L * 0.14, ys + 0.14); ctx.lineTo(L * 0.05, yr - 0.15); ctx.lineTo(L * 0.01, yr - 0.15); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill();
    // door line + handle
    ctx.beginPath(); ctx.moveTo(-L * 0.08, yb + 0.12); ctx.lineTo(-L * 0.08, ys + 0.05);
    strokeAs(ctx, Math.max(0.025, 0.8 / z), shade(col, -0.4), 'butt');
    ctx.fillStyle = shade(col, -0.4);
    ctx.fillRect(-L * 0.08 - 0.32, ys - 0.17, 0.2, 0.06);
    // lights + bumpers
    ctx.beginPath(); ctx.ellipse(hl - 0.07, ys - 0.2, 0.07, 0.11, 0, 0, TAU);
    ctx.fillStyle = '#fff4b8'; ctx.fill(); ctx.lineWidth = ol * 0.7; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = '#ff4747';
    ctx.fillRect(-hl, ys - 0.34, 0.09, 0.18);
    ctx.beginPath(); rrect(ctx, hl - 0.28, yb - 0.03, 0.34, 0.17, 0.06); rrect(ctx, -hl - 0.06, yb - 0.03, 0.34, 0.17, 0.06);
    ctx.fillStyle = '#2b2f35'; ctx.fill();
    drawWheelWells(ctx, wl, nw, yb + 0.02, 1.2);
    for (let i = 0; i < nw; i++) drawWheel(ctx, wl[i], 'car', z);
  }

  function drawBus(ctx, d, wl, nw, z, col) {
    const L = d.length, Hh = d.height, hl = L / 2;
    const ol = Math.max(0.05, 1.2 / z), edge = '#1f2328';
    const yb = 0.16;
    ctx.beginPath(); rrect(ctx, -hl, yb, L, Hh - yb, 0.4);
    ctx.fillStyle = col; ctx.fill();
    // lower skirt
    ctx.beginPath(); rrect(ctx, -hl, yb, L, 0.5, 0.25);
    ctx.fillStyle = shade(col, -0.2); ctx.fill();
    // white stripe
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-hl + 0.05, Hh * 0.42, L - 0.1, Math.max(0.12, 1.5 / z));
    // roof unit
    ctx.beginPath(); rrect(ctx, -L * 0.18, Hh - 0.04, L * 0.28, 0.22, 0.07);
    ctx.fillStyle = shade(col, 0.35); ctx.fill(); ctx.lineWidth = ol * 0.8; ctx.strokeStyle = edge; ctx.stroke();
    // outline of the body
    ctx.beginPath(); rrect(ctx, -hl, yb, L, Hh - yb, 0.4);
    ctx.lineWidth = ol; ctx.strokeStyle = edge; ctx.stroke();
    // passenger windows
    const y0 = Hh * 0.56, y1 = Hh - 0.3;
    const wx0 = -hl + 0.45, wx1 = hl - 2.15;
    const span = wx1 - wx0;
    const n = Math.max(2, Math.round(span / 1.25));
    const gap = 0.16, ww = (span - (n - 1) * gap) / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) rrect(ctx, wx0 + i * (ww + gap), y0, ww, y1 - y0, 0.12);
    rrect(ctx, hl - 1.05, Hh * 0.5, 0.97, y1 - Hh * 0.5 + 0.06, 0.16);     // windshield
    ctx.fillStyle = '#bfe8ff'; ctx.fill();
    ctx.lineWidth = ol * 0.8; ctx.strokeStyle = edge; ctx.stroke();
    // passengers
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (hash2(i, 3) < 0.35) continue;
      const cx = wx0 + i * (ww + gap) + ww * (0.3 + 0.4 * hash2(i, 4)), cy = y0 + 0.36;
      ctx.moveTo(cx + 0.17, cy); ctx.arc(cx, cy, 0.17, 0, TAU);
    }
    ctx.moveTo(hl - 0.55 + 0.17, y0 + 0.3); ctx.arc(hl - 0.55, y0 + 0.3, 0.17, 0, TAU);     // driver
    ctx.fillStyle = 'rgba(40,52,64,0.4)'; ctx.fill();
    // glare
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = wx0 + i * (ww + gap);
      ctx.moveTo(x + ww * 0.55, y0 + 0.08); ctx.lineTo(x + ww * 0.75, y0 + 0.08);
      ctx.lineTo(x + ww * 0.45, y1 - 0.08); ctx.lineTo(x + ww * 0.25, y1 - 0.08); ctx.closePath();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
    // door
    ctx.beginPath(); rrect(ctx, hl - 2.0, yb + 0.2, 0.8, y1 - yb - 0.2, 0.08);
    ctx.fillStyle = '#a9d9f6'; ctx.fill(); ctx.lineWidth = ol * 0.8; ctx.strokeStyle = edge; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hl - 1.6, yb + 0.22); ctx.lineTo(hl - 1.6, y1 - 0.02);
    strokeAs(ctx, ol * 0.8, edge, 'butt');
    // destination sign
    ctx.beginPath(); rrect(ctx, hl - 1.0, Hh - 0.26, 0.85, 0.18, 0.04);
    ctx.fillStyle = '#22262b'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(hl - 0.9, Hh - 0.17); ctx.lineTo(hl - 0.3, Hh - 0.17);
    strokeAs(ctx, 0.06, '#ffb020', 'butt');
    // lights + bumper
    ctx.beginPath(); ctx.arc(hl - 0.16, yb + 0.62, 0.12, 0, TAU);
    ctx.fillStyle = '#fff4b8'; ctx.fill(); ctx.lineWidth = ol * 0.7; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = '#ff4747'; ctx.fillRect(-hl, yb + 0.55, 0.1, 0.3);
    ctx.beginPath(); rrect(ctx, hl - 0.4, yb - 0.04, 0.48, 0.22, 0.07); rrect(ctx, -hl - 0.08, yb - 0.04, 0.48, 0.22, 0.07);
    ctx.fillStyle = '#2b2f35'; ctx.fill();
    drawWheelWells(ctx, wl, nw, yb + 0.02, 1.18);
    for (let i = 0; i < nw; i++) drawWheel(ctx, wl[i], 'heavy', z);
  }

  function drawTruck(ctx, d, wl, nw, z, col) {
    const L = d.length, Hh = d.height, hl = L / 2;
    const ol = Math.max(0.05, 1.2 / z), edge = '#1f2328';
    const cabL = clamp(L * 0.26, 1.8, 2.6);
    const cabX0 = hl - cabL, trX1 = cabX0 - 0.15;
    // chassis rail
    ctx.beginPath(); rrect(ctx, -hl + 0.3, 0.12, L - 0.55, 0.38, 0.08);
    ctx.fillStyle = '#2d3136'; ctx.fill();
    // trailer box
    ctx.beginPath(); rrect(ctx, -hl, 0.5, trX1 + hl, Hh - 0.5, 0.15);
    ctx.fillStyle = '#f3f5f8'; ctx.fill();
    if (z > 6) {
      ctx.beginPath();
      for (let x = -hl + 0.45; x < trX1 - 0.2; x += 0.55) { ctx.moveTo(x, 0.66); ctx.lineTo(x, Hh - 0.14); }
      strokeAs(ctx, Math.max(0.04, 0.8 / z), '#d3d9e1', 'butt');
    }
    const sy = 0.5 + (Hh - 0.5) * 0.3;
    ctx.fillStyle = col; ctx.fillRect(-hl + 0.05, sy, trX1 + hl - 0.1, 0.32);
    ctx.fillStyle = shade(col, -0.3); ctx.fillRect(-hl + 0.05, sy + 0.42, trX1 + hl - 0.1, 0.09);
    ctx.beginPath(); rrect(ctx, -hl, 0.5, trX1 + hl, Hh - 0.5, 0.15);
    ctx.lineWidth = ol; ctx.strokeStyle = edge; ctx.stroke();
    // exhaust pipe
    ctx.beginPath(); rrect(ctx, cabX0 - 0.13, 0.5, 0.1, Hh * 0.97 - 0.5, 0.04);
    ctx.fillStyle = '#9aa3ad'; ctx.fill(); ctx.lineWidth = ol * 0.7; ctx.strokeStyle = edge; ctx.stroke();
    // cab
    const ct = Hh * 0.9;
    ctx.beginPath();
    ctx.moveTo(cabX0, 0.42);
    ctx.lineTo(cabX0, ct - 0.15);
    ctx.quadraticCurveTo(cabX0, ct, cabX0 + 0.15, ct);
    ctx.lineTo(hl - 0.6, ct);
    ctx.lineTo(hl - 0.1, Hh * 0.56);
    ctx.quadraticCurveTo(hl, Hh * 0.53, hl, Hh * 0.47);
    ctx.lineTo(hl, 0.42);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = ol; ctx.strokeStyle = edge; ctx.stroke();
    // cab window
    ctx.beginPath();
    ctx.moveTo(cabX0 + 0.3, Hh * 0.58);
    ctx.lineTo(cabX0 + 0.3, ct - 0.16);
    ctx.lineTo(hl - 0.66, ct - 0.16);
    ctx.lineTo(hl - 0.24, Hh * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#bfe8ff'; ctx.fill(); ctx.lineWidth = ol * 0.8; ctx.stroke();
    ctx.beginPath(); ctx.arc(cabX0 + 0.85, Hh * 0.68, 0.16, 0, TAU);
    ctx.fillStyle = 'rgba(40,52,64,0.42)'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hl - 0.95, ct - 0.2); ctx.lineTo(hl - 0.78, ct - 0.2); ctx.lineTo(hl - 1.05, Hh * 0.62); ctx.lineTo(hl - 1.22, Hh * 0.62); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fill();
    // cab details: door line, grille, light, bumper
    ctx.beginPath(); ctx.moveTo(cabX0 + 0.22, 0.5); ctx.lineTo(cabX0 + 0.22, Hh * 0.56);
    ctx.moveTo(hl - 0.5, 0.5); ctx.lineTo(hl - 0.5, Hh * 0.55);
    strokeAs(ctx, Math.max(0.025, 0.8 / z), shade(col, -0.4), 'butt');
    ctx.fillStyle = '#2b2f35'; ctx.fillRect(hl - 0.14, 0.62, 0.12, 0.55);
    ctx.beginPath(); ctx.arc(hl - 0.1, 1.32, 0.1, 0, TAU);
    ctx.fillStyle = '#fff4b8'; ctx.fill(); ctx.lineWidth = ol * 0.7; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = '#ff4747'; ctx.fillRect(-hl, 0.6, 0.1, 0.25);
    ctx.beginPath(); rrect(ctx, hl - 0.4, 0.26, 0.48, 0.22, 0.07);
    ctx.fillStyle = '#2b2f35'; ctx.fill();
    drawWheelWells(ctx, wl, nw, 0.3, 1.15);
    for (let i = 0; i < nw; i++) drawWheel(ctx, wl[i], 'heavy', z);
  }

  /** Two-bone IK: joint between a and b with segment lengths l1, l2, bending towards (dx, dy). */
  function ikJoint(ax, ay, bx, by, l1, l2, dx, dy) {
    const vx = bx - ax, vy = by - ay;
    const d = Math.max(1e-6, Math.sqrt(vx * vx + vy * vy));
    const dd = Math.min(d, (l1 + l2) * 0.999);
    const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const ux = vx / d, uy = vy / d;
    let px = -uy, py = ux;
    if (px * dx + py * dy < 0) { px = -px; py = -py; }
    return [ax + ux * a + px * h, ay + uy * a + py * h];
  }

  function drawBike(ctx, d, wl, nw, z, col) {
    let R = wl[0], F = wl[nw > 1 ? 1 : 0];
    if (nw > 1 && R.x > F.x) { const t = R; R = F; F = t; }
    const s = clamp(d.height / 1.75, 0.7, 1.4);
    const yA = (R.y + F.y) / 2;
    const B = [R.x + (F.x - R.x) * 0.42, yA + 0.02 * s];      // bottom bracket
    const S = [B[0] - 0.13 * s, yA + 0.6 * s];                // saddle
    const Hd = [F.x - 0.15 * s, yA + 0.6 * s];                // head tube top
    const Hb = [Hd[0] - 0.06 * s, Hd[1] + 0.16 * s];          // handlebar
    const crank = R.rot * 0.6, cr = 0.17 * s;
    const P1 = [B[0] + Math.cos(crank) * cr, B[1] + Math.sin(crank) * cr];
    const P2 = [B[0] - Math.cos(crank) * cr, B[1] - Math.sin(crank) * cr];
    const hip = [S[0] - 0.02 * s, S[1] + 0.08 * s];
    const sh = [hip[0] + 0.3 * s, hip[1] + 0.52 * s];
    const head = [sh[0] + 0.1 * s, sh[1] + 0.26 * s];
    const lw = Math.max(0.1 * s, 2 / z);
    const pants = '#2f4a7a';
    function leg(foot, color) {
      const knee = ikJoint(hip[0], hip[1], foot[0], foot[1], 0.45 * s, 0.45 * s, 1, 0);
      ctx.beginPath(); ctx.moveTo(hip[0], hip[1]); ctx.lineTo(knee[0], knee[1]); ctx.lineTo(foot[0], foot[1]);
      ctx.lineJoin = 'round';
      strokeAs(ctx, lw, color, 'round');
      ctx.beginPath(); ctx.ellipse(foot[0] + 0.04 * s, foot[1] + 0.02 * s, 0.09 * s, 0.045 * s, 0, 0, TAU);
      ctx.fillStyle = '#1e2126'; ctx.fill();
    }
    leg(P2, shade(pants, -0.35));
    drawWheel(ctx, R, 'bike', z);
    drawWheel(ctx, F, 'bike', z);
    // frame
    ctx.beginPath();
    ctx.moveTo(R.x, R.y); ctx.lineTo(B[0], B[1]); ctx.lineTo(S[0], S[1]); ctx.lineTo(R.x, R.y);
    ctx.moveTo(B[0], B[1]); ctx.lineTo(Hd[0], Hd[1]); ctx.lineTo(S[0], S[1]);
    ctx.moveTo(Hd[0], Hd[1]); ctx.lineTo(F.x, F.y);
    ctx.lineJoin = 'round';
    strokeAs(ctx, Math.max(0.075, 2.2 / z), '#1f2328', 'round');
    strokeAs(ctx, Math.max(0.05, 1.3 / z), '#ff7a1a', 'round');
    ctx.beginPath(); ctx.moveTo(Hd[0], Hd[1]); ctx.lineTo(Hb[0], Hb[1]); ctx.lineTo(Hb[0] + 0.13 * s, Hb[1] + 0.01 * s);
    strokeAs(ctx, Math.max(0.04, 1.2 / z), '#33373d', 'round');
    ctx.beginPath(); ctx.ellipse(S[0], S[1] + 0.04 * s, 0.14 * s, 0.05 * s, 0, 0, TAU);
    ctx.fillStyle = '#1e2126'; ctx.fill();
    // crank
    ctx.beginPath(); ctx.arc(B[0], B[1], 0.08 * s, 0, TAU);
    ctx.fillStyle = '#8f98a2'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(P1[0], P1[1]); ctx.lineTo(P2[0], P2[1]);
    strokeAs(ctx, Math.max(0.03, 1 / z), '#4b525a', 'round');
    // near leg, torso, arm, head
    leg(P1, pants);
    ctx.beginPath(); ctx.moveTo(hip[0], hip[1]); ctx.lineTo(sh[0], sh[1]);
    strokeAs(ctx, Math.max(0.2 * s, 3 / z), col, 'round');
    const elbow = ikJoint(sh[0], sh[1], Hb[0] + 0.06 * s, Hb[1], 0.3 * s, 0.3 * s, 0, -1);
    ctx.beginPath(); ctx.moveTo(sh[0], sh[1]); ctx.lineTo(elbow[0], elbow[1]); ctx.lineTo(Hb[0] + 0.06 * s, Hb[1]);
    strokeAs(ctx, Math.max(0.075 * s, 1.6 / z), shade(col, -0.15), 'round');
    ctx.beginPath(); ctx.arc(head[0], head[1], 0.14 * s, 0, TAU);
    ctx.fillStyle = '#f2c9a0'; ctx.fill();
    ctx.lineWidth = Math.max(0.02, 0.8 / z); ctx.strokeStyle = '#8a5a3c'; ctx.stroke();
    // helmet
    ctx.beginPath(); ctx.arc(head[0] - 0.01 * s, head[1] + 0.02 * s, 0.16 * s, -0.15, Math.PI + 0.15);
    ctx.closePath();
    ctx.fillStyle = '#ffd23f'; ctx.fill(); ctx.strokeStyle = '#1f2328'; ctx.stroke();
  }

  // ===========================================================================
  // FX particles
  // ===========================================================================
  const BREAK_COLORS = {
    wood: ['#cd8c46', '#8e5525', '#f0c084'],
    steel: ['#e85d2f', '#a93915', '#8f98a2'],
    road: ['#4b4f57', '#2b2f35', '#868c96'],
    steelroad: ['#7c95b3', '#4b4f57', '#2b2f35'],
    rope: ['#3b332d', '#6b5d4f', '#a8957c'],
  };
  const DUST_COLORS = { wood: '#e3cfa8', steel: '#d4d4d4', road: '#bdbdbd', steelroad: '#cfd6de', rope: '#d8ccb8' };
  const CONFETTI = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff924c'];

  function pickColor(arr) { return arr[(Math.random() * arr.length) | 0]; }

  // ===========================================================================
  // Renderer instance
  // ===========================================================================
  function create(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    let W = 1, H = 1, dpr = 1;

    // caches
    const skyCanvas = document.createElement('canvas');
    const skyCtx = skyCanvas.getContext('2d');
    let skyKey = '';
    let cloudSprites = null, cloudKey = '';
    let earthTile = null, earthPattern = null, earthRes = 0;

    const V = makeView();          // main view
    const SV = makeView();         // view for the sky cache

    // per-frame buffers (reused, no allocation in steady state)
    const segPool = [];
    let segN = 0;
    const gIntact = new Groups(), gDebris = new Groups();
    const tint = Object.create(null);
    let tintKeys = [];
    const jx = [], jy = [], dx = [], dy = [], ax = [], ay = [];
    const nodeKeys = new Set(), anchorKeys = new Set();
    const intactParticles = new Set();
    const wheelBuf = [];
    const oneSeg = [null];

    // FX
    const fx = [];
    let fxLastTime = null, fxLevel = null, fxMode = null;
    let lastScene = null;

    function nextSeg() {
      let s = segPool[segN];
      if (!s) { s = {}; segPool[segN] = s; }
      segN++;
      return s;
    }

    function resize() {
      let w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) {
        const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
        w = (r && r.width) || window.innerWidth || 800;
        h = (r && r.height) || window.innerHeight || 600;
      }
      const d = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
      W = w; H = h; dpr = d;
      const pw = Math.max(1, Math.round(w * d)), ph = Math.max(1, Math.round(h * d));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      if (skyCanvas.width !== pw || skyCanvas.height !== ph) { skyCanvas.width = pw; skyCanvas.height = ph; }
      skyKey = '';
    }

    function checkSize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const d = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
      if ((w && h && (w !== W || h !== H)) || d !== dpr) resize();
    }

    function worldToScreen(cam, wx, wy) {
      return [(wx - cam.x) * cam.zoom + W / 2, (cam.y - wy) * cam.zoom + H / 2];
    }
    function screenToWorld(cam, sx, sy) {
      return [(sx - W / 2) / cam.zoom + cam.x, cam.y - (sy - H / 2) / cam.zoom];
    }
    function fitCamera(level, insets) {
      return fitCam(level, W, H, insets, ZOOM_MIN, ZOOM_MAX);
    }

    // ---------------------------------------------------------------- caches
    function ensureSky() {
      const key = W + 'x' + H + '@' + dpr;
      if (key === skyKey) return;
      skyKey = key;
      setView(SV, skyCtx, W, H, dpr, { x: 0, y: 0, zoom: 20 });
      drawSkyBase(SV, false);
      const sc = clamp(Math.min(W, H) / 800, 0.6, 1.25);
      const ck = sc + '@' + dpr;
      if (ck !== cloudKey) {
        cloudKey = ck;
        cloudSprites = [makeCloudSprite(1, 170 * sc, 70 * sc, dpr), makeCloudSprite(2, 130 * sc, 58 * sc, dpr), makeCloudSprite(5, 210 * sc, 80 * sc, dpr)];
      }
    }

    // Background world layer (hills, canyon back wall, pylons, terrain, start sign,
    // grid dots, anchor plates). Drawn straight into the main canvas every frame:
    // measured well under 1 ms even for a detailed close-up view, and compositing it
    // through an extra offscreen canvas (as a "only redraw when the camera changes"
    // cache) turned out to cost 100+ ms per redraw in headless Chrome whenever that
    // cache actually needed to update – i.e. on every single frame while panning or
    // pinch-zooming, exactly when smooth drawing matters the most. So: no cache here.
    function drawStatic(scene, level) {
      const mode = scene.mode || 'build';
      const grid = scene.showGrid && mode !== 'test';
      if (earthRes !== dpr) {
        earthRes = dpr;
        earthTile = makeEarthTile(dpr);
        earthPattern = null;
      }
      if (!earthPattern) earthPattern = ctx.createPattern(earthTile, 'repeat');
      V.lite = false;
      drawHills(V);
      drawCanyonBack(V, level);
      drawPylons(V, level);
      drawTerrain(V, level, earthPattern);
      drawStartSign(V, level);
      if (grid) drawGrid(V, level, mode);
      drawAnchorPlates(V, level);
      if (mode === 'leveledit') drawLevelEditStatic(V, level);
    }

    // ---------------------------------------------------------------- beams
    function cullSeg(s, m) {
      let x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2), y0 = Math.min(s.y1, s.y2), y1 = Math.max(s.y1, s.y2);
      if (s.sag) { x0 = Math.min(x0, s.cx); x1 = Math.max(x1, s.cx); y0 = Math.min(y0, s.cy); y1 = Math.max(y1, s.cy); }
      return x1 < V.minX - m || x0 > V.maxX + m || y1 < V.minY - m || y0 > V.maxY + m;
    }

    function anchorKey(x, y) { return (Math.round(x * 4) + 65536) * 262144 + (Math.round(y * 4) + 65536); }

    function collectAnchors(level) {
      anchorKeys.clear();
      let n = 0;
      const an = level.anchors;
      if (!Array.isArray(an)) return 0;
      for (let i = 0; i < an.length; i++) {
        const a = an[i];
        if (!a || !isNum(a[0]) || !isNum(a[1])) continue;
        anchorKeys.add(anchorKey(a[0], a[1]));
        if (a[0] < V.minX - 1 || a[0] > V.maxX + 1 || a[1] < V.minY - 1 || a[1] > V.maxY + 1) continue;
        ax[n] = a[0]; ay[n] = a[1]; n++;
      }
      return n;
    }

    function addTint(s, st) {
      const b = Math.round(clamp(isNum(s.stress) ? s.stress : 0, 0, 1) * STRESS_STEPS);
      const key = st.kind === 'road' || st.kind === 'steelroad' || st.kind === 'rope' ? st.kind : 'beam';
      const k = key + b;
      let arr = tint[k];
      if (!arr) { arr = tint[k] = []; arr.kind = key; arr.bucket = b; tintKeys.push(k); }
      arr.push(s);
    }

    function drawTint(z) {
      const c = V.ctx;
      c.globalAlpha = 0.68;
      for (let i = 0; i < tintKeys.length; i++) {
        const arr = tint[tintKeys[i]];
        if (!arr.length) continue;
        const st = styleFor(arr.kind === 'beam' ? 'wood' : arr.kind, false);
        const bm = bodyMetrics(st, z);
        pathSegs(c, arr, bm.c);
        strokeAs(c, bm.T * (arr.kind === 'rope' ? 1.8 : 1), STRESS_COLORS[arr.bucket], 'round');
      }
      c.globalAlpha = 1;
    }

    function resetTint() {
      for (let i = 0; i < tintKeys.length; i++) tint[tintKeys[i]].length = 0;
    }

    function drawBridgeBeams(scene, level) {
      const bridge = scene.bridge;
      const beams = bridge && Array.isArray(bridge.beams) ? bridge.beams : [];
      segN = 0;
      gIntact.reset();
      nodeKeys.clear();
      const na = collectAnchors(level);
      let nj = 0;
      for (let i = 0; i < beams.length; i++) {
        const b = beams[i];
        if (!b || !isNum(b.x1) || !isNum(b.y1) || !isNum(b.x2) || !isNum(b.y2)) continue;
        const s = setSeg(nextSeg(), b.x1, b.y1, b.x2, b.y2, b.m);
        if (cullSeg(s, 1)) continue;
        gIntact.add(b.m, s);
        for (let e = 0; e < 2; e++) {
          const x = e ? b.x2 : b.x1, y = e ? b.y2 : b.y1;
          const k = anchorKey(x, y);
          if (anchorKeys.has(k) || nodeKeys.has(k)) continue;
          nodeKeys.add(k);
          jx[nj] = x; jy[nj] = y; nj++;
        }
      }
      setWorld(V);
      ctx.lineJoin = 'round';
      gIntact.draw(ctx, V.z, false);
      drawBolts(V, jx, jy, nj, Math.max(0.2, 3.4 / V.z), '#dfe3e8', '#2b3036', '#7d8794');
      drawBolts(V, ax, ay, na, Math.max(0.27, 4.6 / V.z), '#cfd5dc', '#1a1f25', '#545d68');
    }

    function drawSimBeams(scene, sim, level) {
      const beams = Array.isArray(sim.beams) ? sim.beams : [];
      segN = 0;
      gIntact.reset(); gDebris.reset(); resetTint();
      intactParticles.clear();
      const showStress = !!scene.showStress;
      for (let i = 0; i < beams.length; i++) {
        const b = beams[i];
        if (!b || b.broken || !b.a || !b.b) continue;
        const pa = b.a, pb = b.b;
        if (!isNum(pa.x) || !isNum(pa.y) || !isNum(pb.x) || !isNum(pb.y)) continue;
        const s = setSeg(nextSeg(), pa.x, pa.y, pb.x, pb.y, b.m);
        if (isTensionOnly(b.m) && isNum(b.rest) && b.rest > s.len + 0.01) {
          // slack rope: quadratic curve with the same arc length (parabola approximation)
          const slack = b.rest - s.len;
          let sg = s.len > 0.05 ? Math.sqrt(3 * s.len * slack / 8) : b.rest / 2;
          sg = Math.min(sg, b.rest * 0.5);
          s.sag = true;
          s.cx = (s.x1 + s.x2) / 2 + s.nx * 2 * sg;
          s.cy = (s.y1 + s.y2) / 2 + s.ny * 2 * sg;
        }
        if (!b.debris) { intactParticles.add(pa); intactParticles.add(pb); }
        if (cullSeg(s, 1)) continue;
        if (b.debris) gDebris.add(b.m, s);
        else {
          gIntact.add(b.m, s);
          if (showStress) { s.stress = b.stress; addTint(s, styleFor(b.m, false)); }
        }
      }
      setWorld(V);
      ctx.lineJoin = 'round';
      gDebris.draw(ctx, V.z, true);
      gIntact.draw(ctx, V.z, false);
      if (showStress) drawTint(V.z);
      // joints
      let nj = 0, nd = 0;
      const joints = Array.isArray(sim.joints) ? sim.joints : [];
      for (let i = 0; i < joints.length; i++) {
        const p = joints[i];
        if (!p || p.anchor || !(p.deg > 0) || !isNum(p.x) || !isNum(p.y)) continue;
        if (p.x < V.minX - 1 || p.x > V.maxX + 1 || p.y < V.minY - 1 || p.y > V.maxY + 1) continue;
        if (intactParticles.has(p)) { jx[nj] = p.x; jy[nj] = p.y; nj++; }
        else { dx[nd] = p.x; dy[nd] = p.y; nd++; }
      }
      const na = collectAnchors(level);
      drawBolts(V, dx, dy, nd, Math.max(0.15, 2.6 / V.z), '#9aa1aa', '#22262b', '#5d6570');
      drawBolts(V, jx, jy, nj, Math.max(0.2, 3.4 / V.z), '#dfe3e8', '#2b3036', '#7d8794');
      drawBolts(V, ax, ay, na, Math.max(0.27, 4.6 / V.z), '#cfd5dc', '#1a1f25', '#545d68');
    }

    // ---------------------------------------------------------------- vehicles
    function drawVehicles(sim) {
      const vs = Array.isArray(sim.vehicles) ? sim.vehicles : [];
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (!v || v.state === 'waiting' || v.visible === false || !v.pose) continue;
        const p = v.pose;
        if (!isNum(p.x) || !isNum(p.y)) continue;
        const def = vehDef(v);
        const R = Math.max(def.length, def.height) + 1;
        if (p.x + R < V.minX || p.x - R > V.maxX || p.y + R < V.minY || p.y - R > V.maxY) continue;
        drawVehicle(v, def);
      }
    }

    function drawVehicle(v, def) {
      const p = v.pose, a = num(p.angle, 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      let nw = 0;
      if (Array.isArray(v.wheels)) {
        for (let i = 0; i < v.wheels.length; i++) {
          const w = v.wheels[i];
          if (!w || !w.p || !isNum(w.p.x) || !isNum(w.p.y)) continue;
          const o = wheelBuf[nw] || (wheelBuf[nw] = {});
          const ddx = w.p.x - p.x, ddy = w.p.y - p.y;
          o.x = ddx * ca + ddy * sa;
          o.y = -ddx * sa + ddy * ca;
          o.r = num(w.r, def.wheelRadius);
          o.rot = num(w.angle, 0) - a;
          nw++;
        }
      }
      if (!nw) {
        for (let i = 0; i < def.axles.length; i++) {
          const o = wheelBuf[nw] || (wheelBuf[nw] = {});
          o.x = def.axles[i]; o.y = 0; o.r = def.wheelRadius; o.rot = 0;
          nw++;
        }
      }
      setWorld(V);
      ctx.translate(p.x, p.y);
      ctx.rotate(a);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const z = V.z;
      switch (v.type) {
        case 'bike': case 'motorcycle': drawBike(ctx, def, wheelBuf, nw, z, def.color); break;
        case 'bus': case 'train': drawBus(ctx, def, wheelBuf, nw, z, def.color); break;
        case 'truck': case 'tanker': case 'crane': drawTruck(ctx, def, wheelBuf, nw, z, def.color); break;
        default: drawCar(ctx, def, wheelBuf, nw, z, def.color);
      }
    }

    // ---------------------------------------------------------------- FX
    function pushFx(p) {
      if (fx.length >= MAX_FX) fx.shift();
      fx.push(p);
    }

    function spawnBreak(x, y, m) {
      const cols = BREAK_COLORS[m] || BREAK_COLORS.wood;
      const metal = m === 'steel' || m === 'steelroad';
      const n = m === 'rope' ? 8 : 13;
      for (let i = 0; i < n; i++) {
        pushFx({ k: 'chip', x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), vx: rand(-4, 4), vy: rand(1, 6.5), r: rand(0, TAU), vr: rand(-14, 14),
          s: m === 'rope' ? rand(0.15, 0.35) : rand(0.12, 0.38), th: m === 'rope' ? 0.035 : rand(0.05, 0.1), life: rand(1.0, 1.8), max: 1.8, c: pickColor(cols), g: 1 });
      }
      if (metal) {
        for (let i = 0; i < 12; i++) {
          pushFx({ k: 'spark', x: x, y: y, vx: rand(-7, 7), vy: rand(-1, 8), r: 0, vr: 0, s: 0, life: rand(0.25, 0.6), max: 0.6, c: i % 3 ? '#ffd25a' : '#fff4c2', g: 0.6 });
        }
      }
      const dc = DUST_COLORS[m] || DUST_COLORS.wood;
      for (let i = 0; i < 7; i++) {
        pushFx({ k: 'dust', x: x + rand(-0.3, 0.3), y: y + rand(-0.2, 0.3), vx: rand(-0.9, 0.9), vy: rand(0.1, 0.9), r: 0, vr: 0, s: rand(0.25, 0.5), life: rand(0.7, 1.3), max: 1.3, c: dc, g: -0.03 });
      }
    }

    function spawnSplash(x, y) {
      const lvl = lastScene && lastScene.level;
      const wy = lvl && isNum(lvl.water) ? lvl.water : y;
      for (let i = 0; i < 18; i++) {
        pushFx({ k: 'drop', x: x + rand(-0.4, 0.4), y: wy + 0.05, vx: rand(-2.6, 2.6), vy: rand(2.5, 7), r: 0, vr: 0, s: rand(0.07, 0.17), life: rand(0.8, 1.4), max: 1.4, c: i % 3 ? '#e6f7ff' : '#8fd3f7', g: 1, water: wy });
      }
      for (let i = 0; i < 2; i++) {
        pushFx({ k: 'ring', x: x, y: wy, vx: 0, vy: 0, r: 0, vr: 0, s: 0.4 + i * 0.3, life: 0.9 + i * 0.3, max: 0.9 + i * 0.3, c: '#ffffff', g: 0 });
      }
      for (let i = 0; i < 4; i++) {
        pushFx({ k: 'dust', x: x + rand(-0.5, 0.5), y: wy + 0.1, vx: rand(-0.6, 0.6), vy: rand(0.2, 0.8), r: 0, vr: 0, s: rand(0.2, 0.4), life: rand(0.5, 0.9), max: 0.9, c: '#ffffff', g: 0 });
      }
    }

    function spawnConfetti() {
      const lvl = lastScene && lastScene.level;
      if (!lvl || !isNum(lvl.flagX)) return;
      const g = Array.isArray(lvl.ground) ? lvl.ground : [];
      const x = lvl.flagX + 1, y = (g.length ? surfaceY(g, lvl.flagX) : 0) + 5.2;
      for (let i = 0; i < 26; i++) {
        pushFx({ k: 'conf', x: x + rand(-0.6, 0.6), y: y + rand(-0.3, 0.3), vx: rand(-3.2, 3.2), vy: rand(2, 6), r: rand(0, TAU), vr: rand(-9, 9), s: rand(0.14, 0.24), life: rand(1.8, 2.8), max: 2.8, c: pickColor(CONFETTI), g: 0.3 });
      }
    }

    function spawnCrash(index) {
      const sim = lastScene && lastScene.sim;
      const v = sim && Array.isArray(sim.vehicles) ? sim.vehicles[index] : null;
      if (!v || !v.pose || !isNum(v.pose.x) || !isNum(v.pose.y)) return;
      const lvl = lastScene.level;
      if (lvl && isNum(lvl.water) && v.pose.y < lvl.water) return;      // the splash covers that
      for (let i = 0; i < 8; i++) {
        pushFx({ k: 'dust', x: v.pose.x + rand(-1, 1), y: v.pose.y + rand(0, 1), vx: rand(-0.8, 0.8), vy: rand(0.3, 1.2), r: 0, vr: 0, s: rand(0.35, 0.7), life: rand(0.8, 1.5), max: 1.5, c: '#bfb6a8', g: -0.03 });
      }
    }

    function addEvents(events) {
      if (!events || !events.length) return;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || typeof e !== 'object') continue;
        try {
          if (e.type === 'break' && isNum(e.x) && isNum(e.y)) spawnBreak(e.x, e.y, e.m);
          else if (e.type === 'splash' && isNum(e.x) && isNum(e.y)) spawnSplash(e.x, e.y);
          else if (e.type === 'finish') spawnConfetti();
          else if (e.type === 'crash' && isNum(e.index)) spawnCrash(e.index);
        } catch (err) { /* FX must never break the game */ }
      }
    }

    function updateFx(dt, level) {
      if (!fx.length || dt <= 0) return;
      const g = level && Array.isArray(level.ground) && level.ground.length > 1 ? level.ground : null;
      const water = level && isNum(level.water) ? level.water : null;
      for (let i = fx.length - 1; i >= 0; i--) {
        const p = fx[i];
        p.life -= dt;
        let dead = p.life <= 0;
        if (!dead) {
          p.vy -= 9.81 * p.g * dt;
          if (p.k === 'dust') { p.vx *= 1 - 1.5 * dt; p.vy *= 1 - 1.5 * dt; }
          if (p.k === 'conf') { p.vx *= 1 - 1.2 * dt; p.vy = Math.max(p.vy, -1.6); }
          p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
          if (p.k === 'drop') {
            if (p.vy < 0 && p.y < p.water) dead = true;
          } else if (p.k === 'chip' || p.k === 'spark' || p.k === 'conf') {
            if (water !== null && p.y < water) { p.vx *= 1 - 3 * dt; p.vy = Math.max(p.vy, -1); p.vr *= 1 - 3 * dt; }
            if (g) {
              const sy = surfaceY(g, p.x);
              if (p.y < sy && p.y > sy - 1.5) { p.y = sy; p.vy *= -0.3; p.vx *= 0.55; p.vr *= 0.5; if (p.k === 'spark') dead = true; }
            }
          }
        }
        if (dead) { fx[i] = fx[fx.length - 1]; fx.pop(); }
      }
    }

    function drawFx() {
      if (!fx.length) return;
      const z = V.z;
      setWorld(V);
      for (let i = 0; i < fx.length; i++) {
        const p = fx[i];
        const a = clamp(p.life / p.max, 0, 1);
        switch (p.k) {
          case 'chip': {
            ctx.globalAlpha = Math.min(1, a * 3);
            const c = Math.cos(p.r), s = Math.sin(p.r), hl = p.s / 2, ht = Math.max(p.th, 1.5 / z) / 2;
            ctx.beginPath();
            ctx.moveTo(p.x + c * hl - s * ht, p.y + s * hl + c * ht);
            ctx.lineTo(p.x - c * hl - s * ht, p.y - s * hl + c * ht);
            ctx.lineTo(p.x - c * hl + s * ht, p.y - s * hl - c * ht);
            ctx.lineTo(p.x + c * hl + s * ht, p.y + s * hl - c * ht);
            ctx.closePath();
            ctx.fillStyle = p.c; ctx.fill();
            break;
          }
          case 'spark':
            ctx.globalAlpha = a;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
            strokeAs(ctx, Math.max(0.04, 1.6 / z), p.c, 'round');
            break;
          case 'dust': {
            ctx.globalAlpha = a * 0.6;
            const r = p.s * (1 + (1 - a) * 1.8);
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU);
            ctx.fillStyle = p.c; ctx.fill();
            break;
          }
          case 'drop':
            ctx.globalAlpha = Math.min(1, a * 2);
            ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(p.s, 1.5 / z), 0, TAU);
            ctx.fillStyle = p.c; ctx.fill();
            break;
          case 'ring': {
            ctx.globalAlpha = a * 0.9;
            const rx = p.s * (1 + (1 - a) * 4);
            ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, rx * 0.22, 0, 0, TAU);
            strokeAs(ctx, Math.max(0.06, 1.8 / z), p.c, 'round');
            break;
          }
          case 'conf': {
            ctx.globalAlpha = Math.min(1, a * 3);
            const c = Math.cos(p.r), s = Math.sin(p.r);
            const hw = p.s / 2 * Math.abs(Math.cos(p.r * 1.7)) + 0.02, hh = p.s * 0.3;
            ctx.beginPath();
            ctx.moveTo(p.x + c * hw - s * hh, p.y + s * hw + c * hh);
            ctx.lineTo(p.x - c * hw - s * hh, p.y - s * hw + c * hh);
            ctx.lineTo(p.x - c * hw + s * hh, p.y - s * hw - c * hh);
            ctx.lineTo(p.x + c * hw + s * hh, p.y + s * hw - c * hh);
            ctx.closePath();
            ctx.fillStyle = p.c; ctx.fill();
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------------- overlays
    function drawDeleteHighlight(scene, t) {
      const beams = scene.bridge && scene.bridge.beams;
      const i = scene.deleteHighlight;
      if (!Array.isArray(beams) || !isNum(i) || i < 0 || i >= beams.length) return;
      const b = beams[i];
      if (!b || !isNum(b.x1) || !isNum(b.y1) || !isNum(b.x2) || !isNum(b.y2)) return;
      const s = setSeg(nextSeg(), b.x1, b.y1, b.x2, b.y2, b.m);
      const bm = bodyMetrics(styleFor(b.m, false), V.z);
      const z = V.z;
      setWorld(V);
      oneSeg[0] = s;
      pathSegs(ctx, oneSeg, bm.c);
      ctx.globalAlpha = 0.4 + 0.15 * Math.sin(t * 8);
      strokeAs(ctx, bm.T + Math.max(0.45, 12 / z), '#ff2d2d', 'round');
      ctx.globalAlpha = 1;
      ctx.setLineDash([Math.max(0.3, 7 / z), Math.max(0.2, 5 / z)]);
      strokeAs(ctx, Math.max(0.07, 2.2 / z), '#ffffff', 'butt');
      ctx.setLineDash(NO_DASH);
    }

    function drawPreview(pv, t) {
      if (!pv || !isNum(pv.x1) || !isNum(pv.y1) || !isNum(pv.x2) || !isNum(pv.y2)) return;
      const z = V.z;
      const s = setSeg(nextSeg(), pv.x1, pv.y1, pv.x2, pv.y2, pv.m);
      const len = isNum(pv.length) ? pv.length : s.len;
      setWorld(V);
      ctx.lineJoin = 'round';
      oneSeg[0] = s;
      const r = Math.max(0.2, 3.4 / z);
      if (pv.valid) {
        ctx.globalAlpha = 0.62;
        drawSegsOfStyle(ctx, oneSeg, z, styleFor(pv.m, false));
        ctx.globalAlpha = 0.85;
        jx[0] = pv.x1; jy[0] = pv.y1; jx[1] = pv.x2; jy[1] = pv.y2;
        drawBolts(V, jx, jy, 2, r, '#ffffff', '#2b3036', '#7d8794');
        ctx.globalAlpha = 1;
      } else {
        pathSegs(ctx, oneSeg, 0);
        ctx.setLineDash([Math.max(0.35, 10 / z), Math.max(0.25, 7 / z)]);
        strokeAs(ctx, Math.max(0.16, 5 / z), 'rgba(120,0,0,0.35)', 'butt');
        strokeAs(ctx, Math.max(0.1, 3 / z), '#ff3b30', 'butt');
        ctx.setLineDash(NO_DASH);
        ctx.beginPath();
        ctx.moveTo(pv.x2 + r * 1.2, pv.y2); ctx.arc(pv.x2, pv.y2, r * 1.2, 0, TAU);
        strokeAs(ctx, Math.max(0.08, 2.5 / z), '#ff3b30', 'round');
      }
      // length label above the middle of the beam (screen space)
      if (len > 0) {
        const mx = V.ox + (pv.x1 + pv.x2) / 2 * z, my = V.oy - (pv.y1 + pv.y2) / 2 * z;
        let nx = -(pv.y2 - pv.y1), ny = -(pv.x2 - pv.x1);            // screen-space normal
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        if (ny > 0) { nx = -nx; ny = -ny; }
        setScreen(V);
        drawTag(V, mx + nx * 26, my + ny * 26, fmtLen(len), pv.valid ? 'rgba(255,255,255,0.95)' : '#ff3b30', pv.valid ? '#1d2a38' : '#ffffff', '700 14px ' + FONT);
      }
    }

    function drawHoverNode(hn, t) {
      if (!hn || !isNum(hn[0]) || !isNum(hn[1])) return;
      const sx = V.ox + hn[0] * V.z, sy = V.oy - hn[1] * V.z;
      const r = Math.max(13, 0.62 * V.z) * (1 + 0.08 * Math.sin(t * 6));
      setScreen(V);
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(20,40,70,0.45)'; ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffd84a'; ctx.stroke();
    }

    function drawGroundHandles(level, le) {
      const g = level.ground;
      if (!Array.isArray(g) || !g.length) return;
      const active = le.tool === 'terrain' || le.tool === 'erase';
      const hv = isNum(le.hoverVertex) ? le.hoverVertex : -1;
      const r = active ? 6.5 : 4.5;
      setScreen(V);
      ctx.globalAlpha = active ? 1 : 0.6;
      ctx.beginPath();
      for (let i = 0; i < g.length; i++) {
        if (i === hv || !g[i]) continue;
        const sx = V.ox + g[i][0] * V.z, sy = V.oy - g[i][1] * V.z;
        if (sx < -20 || sx > V.W + 20 || sy < -20 || sy > V.H + 20) continue;
        ctx.moveTo(sx + r, sy); ctx.arc(sx, sy, r, 0, TAU);
      }
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#1d2a38'; ctx.stroke();
      ctx.globalAlpha = 1;
      if (hv >= 0 && hv < g.length && g[hv]) {
        const sx = V.ox + g[hv][0] * V.z, sy = V.oy - g[hv][1] * V.z;
        ctx.beginPath(); ctx.arc(sx, sy, 11, 0, TAU);
        ctx.fillStyle = le.tool === 'erase' ? '#ff3b30' : '#ff9f1c'; ctx.fill();
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(20,40,70,0.5)'; ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      }
    }

    // ---------------------------------------------------------------- frame
    function draw(scene) {
      if (!scene) return;
      checkSize();
      const level = scene.level || (scene.sim && scene.sim.level) || null;
      let cam = scene.camera;
      if (!validCam(cam)) cam = level ? fitCamera(level, null) : { x: 0, y: 0, zoom: 20 };
      const time = num(scene.time, 0);
      const mode = scene.mode || 'build';
      lastScene = scene;
      setView(V, ctx, W, H, dpr, cam);
      V.t = time;
      ctx.lineJoin = 'round';

      // FX clock (scene.time drives the particle simulation)
      if (level !== fxLevel || (mode !== fxMode && fxMode === 'test')) fx.length = 0;
      fxLevel = level; fxMode = mode;
      let dt = fxLastTime === null ? 0 : time - fxLastTime;
      if (!(dt >= 0)) dt = 0;
      fxLastTime = time;
      updateFx(Math.min(dt, 0.1), level);

      // background
      ensureSky();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(skyCanvas, 0, 0);
      drawClouds(V, cloudSprites, time);
      if (!level) { ctx.setTransform(1, 0, 0, 1, 0, 0); return; }
      drawWorldTint(V, level);
      drawStatic(scene, level);

      drawFlag(V, level, time);
      drawCheckpoints(V, level, time);
      const sim = mode === 'test' && scene.sim ? scene.sim : null;
      drawPistons(V, level, sim);
      if (sim) {
        drawSimBeams(scene, sim, level);
        drawVehicles(sim);
      } else {
        drawBridgeBeams(scene, level);
      }
      drawWater(V, level, time);
      drawShips(V, level, sim);
      drawFx();
      drawWeather(V, level, time);

      // overlays
      if (scene.deleteHighlight !== null && scene.deleteHighlight !== undefined) drawDeleteHighlight(scene, time);
      if (scene.preview) drawPreview(scene.preview, time);
      if (BB.Overlay && BB.Overlay.drawRoutes) { setScreen(V); BB.Overlay.drawRoutes(ctx, function (x, y) { return [V.ox + x * V.z, V.oy - y * V.z]; }, V.z, level, { lines: true, preview: (scene.mode || 'build') === 'build', sim: (scene.mode === 'test' && scene.sim) ? scene.sim : null }); }
      if (scene.overlay && BB.Overlay) { setScreen(V); BB.Overlay.draw(ctx, function (x, y) { return [V.ox + x * V.z, V.oy - y * V.z]; }, V.z, scene.overlay, time); }
      if (scene.hoverNode) drawHoverNode(scene.hoverNode, time);
      if (scene.hoverFoundation) {
        const hf = scene.hoverFoundation, surf = isNum(hf[4]) ? hf[4] : hf[1] - 1.2, bot = Math.min(surf, hf[1] - 0.3);
        const x0 = V.ox + (hf[0] - 0.85) * V.z, x1 = V.ox + (hf[0] + 0.85) * V.z, y0 = V.oy - hf[1] * V.z, y1 = V.oy - bot * V.z;
        setScreen(V);
        ctx.fillStyle = hf[2] ? 'rgba(70,200,120,0.5)' : 'rgba(240,70,60,0.5)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.lineWidth = 2.5; ctx.strokeStyle = hf[2] ? '#fff' : '#e03a30'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
      if (mode === 'leveledit' && scene.leveledit) drawGroundHandles(level, scene.leveledit);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    resize();

    return {
      canvas: canvas,
      resize: resize,
      draw: draw,
      worldToScreen: worldToScreen,
      screenToWorld: screenToWorld,
      fitCamera: fitCamera,
      addEvents: addEvents,
      /** Removes all running FX particles (e.g. when leaving a level). */
      clearEffects: function () { fx.length = 0; },
      get width() { return W; },
      get height() { return H; },
    };
  }

  // ===========================================================================
  // Level thumbnail (level cards)
  // ===========================================================================
  function thumbnail(level, w, h) {
    w = Math.max(1, Math.round(num(w, 160)));
    h = Math.max(1, Math.round(num(h, 90)));
    const d = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, DPR_MAX);
    const c = makeCanvas(w * d, h * d);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    try {
      const V = makeView();
      const cam = fitCam(level || {}, w, h, { top: 2, bottom: 2, left: 2, right: 2 }, 0.2, ZOOM_MAX);
      setView(V, ctx, w, h, d, cam);
      V.lite = true;
      drawSkyBase(V, true);
      if (level) {
        drawHills(V);
        drawCanyonBack(V, level);
        drawPylons(V, level);
        drawTerrain(V, level, null);
        drawAnchorPlates(V, level);
        drawStartSign(V, level);
        drawFlag(V, level, 0.6);
        drawWater(V, level, 0.6);
      }
    } catch (e) {
      // a broken level must never break the level list – keep whatever was drawn
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  BB.Render = {
    create: create,
    thumbnail: thumbnail,
    stressColor: stressColor,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    /** Main color per material as drawn by the renderer (for UI swatches, informative). */
    MATERIAL_COLORS: { road: MAT_STYLE.road.body, steelroad: MAT_STYLE.steelroad.girder, wood: MAT_STYLE.wood.body, steel: MAT_STYLE.steel.body, rope: MAT_STYLE.rope.body },
  };
})(globalThis.BB = globalThis.BB || {});
