/*
 * Brückenbauer – render-bp.js
 * ----------------------------------------------------------------------------
 * "Architektenansicht": the blueprint renderer. Straight from the front, orthographic (no perspective),
 * dark-blue paper with a fine grid, flat light-blue terrain with clear outlines, bridge parts as clean
 * lines with joints, vehicles / pylons / anchors / goals as plain outline drawings.
 * Pure 2D canvas, works without WebGL. Same interface as the other renderers:
 *   const R = BB.RenderBP.create(canvas); R.draw(scene); R.worldToScreen / screenToWorld / fitCamera / addEvents …
 * The build grid (dots) is drawn ONLY inside the allowed build zone.
 */
(function (BB) {
  'use strict';

  var TAU = Math.PI * 2;
  var C = {
    bg0: '#0b2447', bg1: '#102f58', gridMinor: 'rgba(160,205,255,0.035)', gridMajor: 'rgba(160,205,255,0.085)',
    line: '#dff0ff', lineDim: 'rgba(223,240,255,0.55)', terrain: '#17406f', terrainHatch: 'rgba(200,228,255,0.05)', terrainTop: '#e8f4ff',
    water: 'rgba(80,185,255,0.5)', waterLine: 'rgba(190,225,255,0.6)', accent: '#ffc247', ok: '#52d98c', bad: '#ff5a4d',
    road: '#eaf5ff', steelroad: '#9fd4ff', wood: '#f2d58c', steel: '#bff0ff', rope: '#e6dcc8', cable: '#9fe8ff', spring: '#7ef0a4',
    hydraulic: '#ffc247', rail: '#cfd8e6', concrete: '#aab6c8',
  };
  var MAT_COLOR = { road: C.road, steelroad: C.steelroad, wood: C.wood, steel: C.steel, rope: C.rope, cable: C.cable, spring: C.spring, hydraulic: C.hydraulic, rail: C.rail, concrete: C.concrete };
  var STRESS_STOPS = [[0, [59, 139, 255]], [0.35, [52, 199, 89]], [0.65, [255, 214, 10]], [0.85, [255, 122, 26]], [1, [255, 45, 45]]];
  function stressRGB(s) {
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    for (var i = 1; i < STRESS_STOPS.length; i++) if (s <= STRESS_STOPS[i][0]) {
      var a = STRESS_STOPS[i - 1], b = STRESS_STOPS[i], t = (s - a[0]) / (b[0] - a[0]);
      return 'rgb(' + Math.round(a[1][0] + (b[1][0] - a[1][0]) * t) + ',' + Math.round(a[1][1] + (b[1][1] - a[1][1]) * t) + ',' + Math.round(a[1][2] + (b[1][2] - a[1][2]) * t) + ')';
    }
    return 'rgb(255,45,45)';
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  var ROUTE_COLORS = ['#ff6b5e', '#4da3ff', '#52d98c', '#ffc247', '#c08cff'];

  function create(canvas, opts) {
    var ctx = canvas.getContext('2d');
    var fixed = opts && opts.size ? opts.size : null;      // thumbnails: fixed CSS size, no DOM layout needed
    var W = 1, H = 1, dpr = 1;
    var fx = [], fxLast = null, lastScene = null, gridCache = { key: '', pts: [] }, hatch = null;

    function resize() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (fixed) { w = fixed[0]; h = fixed[1]; }
      if (!w || !h) { w = window.innerWidth || 800; h = window.innerHeight || 600; }
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      W = w; H = h;
      var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    }
    function checkSize() {
      if (fixed) return;
      var w = canvas.clientWidth, h = canvas.clientHeight, d = clamp(window.devicePixelRatio || 1, 1, 2);
      if ((w && h && (w !== W || h !== H)) || d !== dpr || canvas.width !== Math.round(W * dpr)) resize();
    }
    function worldToScreen(cam, x, y) { return [(x - cam.x) * cam.zoom + W / 2, (cam.y - y) * cam.zoom + H / 2]; }
    function screenToWorld(cam, sx, sy) { return [(sx - W / 2) / cam.zoom + cam.x, cam.y - (sy - H / 2) / cam.zoom]; }
    function fitCamera(level, insets) {
      insets = insets || {};
      var b = (BB.Levels && BB.Levels.fitBounds) ? BB.Levels.fitBounds(level) : { minX: -20, maxX: 20, minY: -10, maxY: 10 };
      var l = insets.left || 0, r = insets.right || 0, t = insets.top || 0, bo = insets.bottom || 0;
      var aw = Math.max(60, W - l - r), ah = Math.max(60, H - t - bo);
      var zoom = Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY));
      var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      return { x: cx - (l - r) / (2 * zoom), y: cy + (t - bo) / (2 * zoom), zoom: zoom };
    }

    function surfaceY(g, x) {
      if (BB.Terrain && BB.Terrain.surfaceY) { var s = BB.Terrain.surfaceY(g, x); if (isFinite(s)) return s; }
      return g.length ? g[0][1] : 0;
    }

    // ------------------------------------------------------------------ drawing helpers (screen space)
    var cam = null;
    var hideWater = false;                   // tools/render_check.js: the picture without the water
    var hideFlags = false;                   // tools/render_check.js: the picture without the flags
    function P(x, y) { return [(x - cam.x) * cam.zoom + W / 2, (cam.y - y) * cam.zoom + H / 2]; }
    function line(x1, y1, x2, y2, color, width, dash) {
      var a = P(x1, y1), b = P(x2, y2);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash);
      ctx.stroke(); if (dash) ctx.setLineDash([]);
    }
    function hatchPattern() {
      if (hatch) return hatch;
      var c = document.createElement('canvas'); c.width = c.height = 14;
      var x = c.getContext('2d'); x.strokeStyle = C.terrainHatch; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(-2, 16); x.lineTo(16, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(12, 16); x.lineTo(16, 12); x.stroke();
      hatch = ctx.createPattern(c, 'repeat');
      return hatch;
    }

    function drawBackground(level, time) {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, C.bg0); g.addColorStop(0.6, C.bg0); g.addColorStop(1, C.bg1);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // fine paper grid: every metre when zoomed in, otherwise every 5 m
      var z = cam.zoom, step = z >= 14 ? 1 : 5, x0 = Math.floor((cam.x - W / 2 / z) / step) * step, x1 = cam.x + W / 2 / z;
      var y0 = Math.floor((cam.y - H / 2 / z) / step) * step, y1 = cam.y + H / 2 / z;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = x0; x <= x1; x += step) { if (x % 5 === 0) continue; var sx = Math.round((x - cam.x) * z + W / 2) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, H); }
      for (var y = y0; y <= y1; y += step) { if (y % 5 === 0) continue; var sy = Math.round((cam.y - y) * z + H / 2) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(W, sy); }
      ctx.strokeStyle = C.gridMinor; ctx.stroke();
      ctx.beginPath();
      var mx0 = Math.floor(x0 / 5) * 5, my0 = Math.floor(y0 / 5) * 5;
      for (var xm = mx0; xm <= x1; xm += 5) { var sxm = Math.round((xm - cam.x) * z + W / 2) + 0.5; ctx.moveTo(sxm, 0); ctx.lineTo(sxm, H); }
      for (var ym = my0; ym <= y1; ym += 5) { var sym = Math.round((cam.y - ym) * z + H / 2) + 0.5; ctx.moveTo(0, sym); ctx.lineTo(W, sym); }
      ctx.strokeStyle = C.gridMajor; ctx.stroke();
    }

    function drawTerrainAndWater(level, time) {
      var g = level.ground;
      if (!Array.isArray(g) || g.length < 2) return;
      var pts = g.map(function (p) { return P(p[0], p[1]); });
      // water body first (behind the terrain edge lines)
      if (isNum(level.water) && !hideWater) {
        var wy = P(0, level.water)[1], lava = gapOf(level) === 'lava';
        ctx.fillStyle = lava ? 'rgba(255,120,40,0.34)' : C.water; ctx.fillRect(0, wy, W, H - wy);
        // v3.4: a brighter band under the surface – the river reads as a body of water even where the build grid covers it
        var band = Math.min(H - wy, Math.max(14, cam.zoom * 2.4)), gr = ctx.createLinearGradient(0, wy, 0, wy + band);
        gr.addColorStop(0, lava ? 'rgba(255,170,70,0.5)' : 'rgba(120,205,255,0.5)'); gr.addColorStop(1, lava ? 'rgba(255,170,70,0)' : 'rgba(120,205,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, wy, W, band);
        if (!lava) {                                      // ripple lines below the surface (the terrain is drawn on top, so they only show inside the gap)
          ctx.strokeStyle = 'rgba(200,235,255,0.28)'; ctx.lineWidth = 1.4;
          for (var rl = 1; rl < 12 && wy + rl * cam.zoom * 1.6 < H; rl++) {
            var ry = wy + rl * cam.zoom * 1.6; ctx.beginPath();
            for (var rx = 0; rx <= W; rx += 8) { var ryy = ry + Math.sin(rx * 0.05 + rl * 1.7 + time * 0.9) * 1.6; if (rx === 0) ctx.moveTo(rx, ryy); else ctx.lineTo(rx, ryy); }
            ctx.stroke();
          }
        }
        ctx.beginPath();
        for (var x = 0; x <= W; x += 6) { var yy = wy + Math.sin(x * 0.045 + time * 1.6) * 1.8; if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy); }
        ctx.strokeStyle = lava ? 'rgba(255,190,110,0.9)' : C.waterLine; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[pts.length - 1][0], H + 40); ctx.lineTo(pts[0][0], H + 40); ctx.closePath();
      ctx.fillStyle = C.terrain; ctx.fill();
      ctx.fillStyle = hatchPattern(); ctx.fill();
      // outline
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (var m = 1; m < pts.length; m++) ctx.lineTo(pts[m][0], pts[m][1]);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = C.terrainTop; ctx.lineWidth = 2.6; ctx.stroke();
    }


    // ------------------------------------------------------------------ what lies below the bridge (gap type)
    function gapOf(level) { return (BB.Levels && BB.Levels.gapOf) ? BB.Levels.gapOf(level) : (isNum(level.water) ? 'water' : 'canyon'); }
    /** widest stretch of open valley floor [x0, x1] at height y (flat part of the ground) or null */
    function floorSpan(level) {
      var g = level.ground || [], minY = Infinity, i;
      for (i = 0; i < g.length; i++) if (g[i][1] < minY) minY = g[i][1];
      var best = null, cur = null;
      for (i = 0; i < g.length; i++) {
        if (g[i][1] <= minY + 0.3) { if (!cur) cur = [g[i][0], g[i][0]]; cur[1] = g[i][0]; }
        else { if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur; cur = null; }
      }
      if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur;
      return best && best[1] - best[0] > 1.5 ? { x0: best[0], x1: best[1], y: minY } : null;
    }
    function drawGapScenery(level, time) {
      var gap = gapOf(level), z = cam.zoom, fl = floorSpan(level);
      if (gap === 'ravine' && fl) {
        // soft mist lying in the ravine
        var top = P(0, fl.y + Math.min(9, Math.max(3, (-fl.y) * 0.45)))[1], bot = P(0, fl.y)[1];
        var mg = ctx.createLinearGradient(0, top, 0, bot);
        mg.addColorStop(0, 'rgba(205,225,250,0)'); mg.addColorStop(1, 'rgba(205,225,250,0.22)');
        var a = P(fl.x0 - 3, 0), b = P(fl.x1 + 3, 0);
        ctx.fillStyle = mg; ctx.fillRect(a[0], top, b[0] - a[0], bot - top);
        return;
      }
      if ((gap !== 'road' && gap !== 'rail') || !fl) return;
      var gts = BB.Gates ? BB.Gates.of(level) : [], trainG = gts.filter(function (g) { return g.kind === 'train'; });
      var mixed = gap === 'road' && trainG.length > 0;
      var splitX = mixed ? Math.max(fl.x0 + 3, Math.min.apply(null, trainG.map(function (g) { return g.x0; })) - 0.6) : fl.x1;
      ctx.save();
      function roadPart(xa, xb) {
        var a0 = P(xa, fl.y), a1 = P(xb, fl.y), w = a1[0] - a0[0], h = Math.max(7, z * 0.45), n = Math.max(2, Math.round((xb - xa) / 3.5)), i;
        ctx.fillStyle = '#0a1c38'; ctx.fillRect(a0[0], a0[1] - h, w, h);
        ctx.strokeStyle = 'rgba(223,240,255,0.5)'; ctx.lineWidth = 1.5; ctx.strokeRect(a0[0], a0[1] - h, w, h);
        ctx.strokeStyle = 'rgba(223,240,255,0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); for (i = 1; i < n; i++) { var lx = a0[0] + w * i / n; ctx.moveTo(lx, a0[1] - h * 0.8); ctx.lineTo(lx, a0[1] - h * 0.2); } ctx.stroke();
        ctx.strokeStyle = 'rgba(255,194,71,0.85)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a0[0] + w / 2, a0[1] - h * 0.85); ctx.lineTo(a0[0] + w / 2, a0[1] - h * 0.15); ctx.stroke();
        ctx.strokeStyle = 'rgba(223,240,255,0.65)'; ctx.lineWidth = 2.2;
        [a0[0] + 4, a1[0] - 4].forEach(function (rx) { ctx.beginPath(); ctx.moveTo(rx, a0[1] - h); ctx.lineTo(rx, a0[1] - h - Math.max(8, z * 0.5)); ctx.stroke(); });
      }
      function railPart(xa, xb) {
        var a0 = P(xa, fl.y), a1 = P(xb, fl.y), bh = Math.max(8, z * 0.5), t, j;
        ctx.beginPath(); ctx.moveTo(a0[0] - 6, a0[1]); ctx.lineTo(a0[0] + 6, a0[1] - bh); ctx.lineTo(a1[0] - 6, a0[1] - bh); ctx.lineTo(a1[0] + 6, a0[1]); ctx.closePath();
        ctx.fillStyle = 'rgba(200,215,235,0.16)'; ctx.fill(); ctx.strokeStyle = 'rgba(223,240,255,0.45)'; ctx.lineWidth = 1.6; ctx.stroke();
        var gx = []; trainG.forEach(function (gt) { var q = (gt.x0 + gt.x1) / 2; if (!gx.some(function (r) { return Math.abs(r - q) < 1; })) gx.push(q); });
        var tracks = gx.length || Math.max(1, Math.min(3, Math.round((xb - xa) / 7)));
        for (t = 0; t < tracks; t++) {
          var cx = gx.length ? P(gx[t], fl.y)[0] : a0[0] + (a1[0] - a0[0]) * (t + 0.5) / tracks, rw = Math.max(9, z * 1.15);
          ctx.strokeStyle = 'rgba(223,240,255,0.6)'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(cx - rw * 0.5, a0[1] - bh - 2); ctx.lineTo(cx - rw * 0.5, a0[1] - bh - 4); ctx.moveTo(cx + rw * 0.5, a0[1] - bh - 2); ctx.lineTo(cx + rw * 0.5, a0[1] - bh - 4); ctx.stroke();
          ctx.strokeStyle = 'rgba(223,240,255,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - rw * 0.75, a0[1] - bh); ctx.lineTo(cx + rw * 0.75, a0[1] - bh); ctx.stroke();
          for (j = -1; j <= 1; j += 2) { ctx.beginPath(); ctx.moveTo(cx + j * rw * 0.5, a0[1] - bh); ctx.lineTo(cx + j * rw * 0.5, a0[1] - bh - 5); ctx.stroke(); }
        }
      }
      if (gap === 'road') roadPart(fl.x0, splitX);
      if (gap === 'rail') railPart(fl.x0, fl.x1); else if (mixed) railPart(splitX, fl.x1);
      ctx.restore();
    }
    /** the buildable area: a quiet dashed frame with a label (the grid dots only appear inside) */
    function drawBuildArea(level, scn) {
      if (scn.mode !== 'build' || level.zones && level.zones.length) return;
      var b = level.build;
      if (!b || !isNum(b.minX)) return;
      var a = P(b.minX, b.maxY), c = P(b.maxX, b.minY), w = c[0] - a[0], h = c[1] - a[1];
      ctx.save();
      ctx.fillStyle = 'rgba(160,205,255,0.03)'; ctx.fillRect(a[0], a[1], w, h);
      ctx.setLineDash([10, 8]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(160,205,255,0.4)'; ctx.strokeRect(a[0], a[1], w, h); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(160,205,255,0.7)'; ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('BAUBEREICH', a[0] + 8, a[1] + 7);
      ctx.restore();
    }
    /** traffic lights at the stop lines (gates / lifts) */
    function drawSignals(level, sim) {
      var list = level.signals || [];
      if (!list.length) return;
      var red = !sim || (sim._s && sim._s.holdActive) || true;
      var live = sim && sim._s ? !!sim._s.holdActive : false;
      list.forEach(function (sg) {
        if (!sg || !isNum(sg.x)) return;
        var y = surfaceY(level.ground, sg.x), a = P(sg.x, y), top = a[1] - Math.max(30, cam.zoom * 2.6), bw = Math.max(10, cam.zoom * 0.62);
        ctx.strokeStyle = C.line; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0], top); ctx.stroke();
        ctx.fillStyle = C.bg0; ctx.fillRect(a[0] - bw / 2, top - bw * 1.7, bw, bw * 1.7); ctx.strokeRect(a[0] - bw / 2, top - bw * 1.7, bw, bw * 1.7);
        var r = bw * 0.24;
        ctx.beginPath(); ctx.arc(a[0], top - bw * 1.15, r, 0, TAU); ctx.fillStyle = sim ? (live ? C.bad : 'rgba(255,90,77,0.25)') : 'rgba(255,90,77,0.55)'; ctx.fill();
        ctx.beginPath(); ctx.arc(a[0], top - bw * 0.5, r, 0, TAU); ctx.fillStyle = sim ? (live ? 'rgba(82,217,140,0.25)' : C.ok) : 'rgba(82,217,140,0.25)'; ctx.fill();
        // stop line on the ground
        ctx.strokeStyle = C.accent; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(a[0] - bw * 0.9, a[1]); ctx.lineTo(a[0] + bw * 0.9, a[1]); ctx.stroke();
      });
    }

    // ------------------------------------------------------------------ props
    function towerList(level) {
      var out = [], g = level.ground, an = level.anchors || [];
      for (var i = 0; i < an.length; i++) {
        var a = an[i], sy = surfaceY(g, a[0]);
        if (!(a[1] - sy > 1.5)) continue;
        var bottom = Math.min(sy, surfaceY(g, a[0] - 0.75), surfaceY(g, a[0] + 0.75)) - 0.4;
        out.push([a[0], a[1], Math.max(bottom, a[1] - 90)]);
      }
      return out;
    }
    function drawPylons(level) {
      towerList(level).forEach(function (t) {
        var top = P(t[0], t[1]), bot = P(t[0], t[2]), wT = Math.max(5, cam.zoom * 0.45), wB = Math.max(8, cam.zoom * 0.7);
        ctx.beginPath(); ctx.moveTo(top[0] - wT, top[1]); ctx.lineTo(top[0] + wT, top[1]); ctx.lineTo(bot[0] + wB, bot[1]); ctx.lineTo(bot[0] - wB, bot[1]); ctx.closePath();
        ctx.fillStyle = 'rgba(223,240,255,0.10)'; ctx.fill(); ctx.strokeStyle = C.lineDim; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(top[0] - wT * 1.5, top[1]); ctx.lineTo(top[0] + wT * 1.5, top[1]); ctx.strokeStyle = C.line; ctx.lineWidth = 3; ctx.stroke();
      });
    }
    function drawAnchors(level, bridge) {
      var an = (level.anchors || []).concat((bridge && bridge.found) || []);
      var r = Math.max(5, cam.zoom * 0.3);
      ctx.lineWidth = 2;
      an.forEach(function (a) {
        var p = P(a[0], a[1]);
        if (p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) return;
        ctx.fillStyle = C.bg0; ctx.strokeStyle = C.line;
        ctx.fillRect(p[0] - r, p[1] - r, r * 2, r * 2); ctx.strokeRect(p[0] - r, p[1] - r, r * 2, r * 2);
        ctx.beginPath(); ctx.moveTo(p[0] - r * 0.5, p[1] - r * 0.5); ctx.lineTo(p[0] + r * 0.5, p[1] + r * 0.5); ctx.moveTo(p[0] + r * 0.5, p[1] - r * 0.5); ctx.lineTo(p[0] - r * 0.5, p[1] + r * 0.5); ctx.stroke();
      });
      // foundation plinths
      ((bridge && bridge.found) || []).forEach(function (f) {
        var sf = surfaceY(level.ground, f[0]), a = P(f[0] - 0.85, f[1]), b = P(f[0] + 0.85, sf - 0.3);
        ctx.fillStyle = 'rgba(170,182,200,0.35)'; ctx.strokeStyle = C.concrete; ctx.lineWidth = 2;
        ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      });
    }
    function flag(x, y, color, checker, time) {
      var p = P(x, y), top = P(x, y + 5), h = p[1] - top[1];
      ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
      var w = h * 0.34, fh = h * 0.22, wob = Math.sin(time * 4) * 2;
      ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(top[0] + w, top[1] + fh / 2 + wob); ctx.lineTo(top[0], top[1] + fh); ctx.closePath();
      ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke();
      if (checker) { ctx.fillStyle = C.bg0; ctx.fillRect(top[0] + w * 0.1, top[1] + fh * 0.2, w * 0.25, fh * 0.3); ctx.fillRect(top[0] + w * 0.4, top[1] + fh * 0.5, w * 0.25, fh * 0.3); }
    }
    function drawGoals(level, time, sim) {
      var routes = BB.routesOf ? BB.routesOf(level) : [{ startX: level.startX, flagX: level.flagX, color: '#ff6b5e' }];
      var multi = routes.length > 1;
      routes.forEach(function (rt, i) {
        var col = multi || rt.strict ? (rt.color || ROUTE_COLORS[i % ROUTE_COLORS.length]) : '#eaf5ff';
        var sts = rt.stations && rt.stations.length ? rt.stations : [{ x: rt.flagX, y: surfaceY(level.ground, rt.flagX) }];
        if (!hideFlags) sts.forEach(function (st, k) { flag(st.x, isNum(st.y) ? st.y : surfaceY(level.ground, st.x), col, k === sts.length - 1 && !multi && !rt.strict, time); });
        // start sign
        var sx = rt.startX + 2.5, sp = P(sx, surfaceY(level.ground, sx)), up = Math.max(14, cam.zoom * 1.8);
        ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sp[0], sp[1]); ctx.lineTo(sp[0], sp[1] - up); ctx.stroke();
        var bw = Math.max(18, cam.zoom * 1.6), bh = bw * 0.55;
        ctx.strokeStyle = multi ? col : C.line; ctx.strokeRect(sp[0] - bw / 2, sp[1] - up - bh, bw, bh);
        ctx.beginPath(); ctx.moveTo(sp[0] - bw * 0.3, sp[1] - up - bh / 2); ctx.lineTo(sp[0] + bw * 0.25, sp[1] - up - bh / 2); ctx.moveTo(sp[0] + bw * 0.05, sp[1] - up - bh * 0.8); ctx.lineTo(sp[0] + bw * 0.3, sp[1] - up - bh / 2); ctx.lineTo(sp[0] + bw * 0.05, sp[1] - up - bh * 0.2);
        ctx.strokeStyle = multi ? col : C.line; ctx.lineWidth = 2; ctx.stroke();
      });
      var hit = sim && sim._s && sim._s.checkpointHit;
      (level.checkpoints || []).forEach(function (cp, i) {
        if (cp.hidden) return;
        var y = surfaceY(level.ground, cp.x), a = P(cp.x, y), top = P(cp.x, y + 3.8), w = Math.max(8, cam.zoom * 1.7);
        ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(a[0] - w, a[1]); ctx.lineTo(top[0] - w, top[1]); ctx.lineTo(top[0] + w, top[1]); ctx.lineTo(a[0] + w, a[1]); ctx.stroke();
        ctx.beginPath(); ctx.arc(top[0], top[1] + 8, Math.max(4, cam.zoom * 0.25), 0, TAU); ctx.fillStyle = hit && hit.has(i) ? C.ok : C.bad; ctx.fill();
        ctx.fillStyle = C.accent; ctx.font = '700 ' + Math.max(10, cam.zoom * 0.6) + 'px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('P' + (cp.phase + 1), top[0], top[1] - 6);
      });
    }
    function drawZones(level, scn) {
      if (scn.mode === 'test') return;
      var zs = level.zones;
      if (!Array.isArray(zs) || !zs.length) return;
      zs.forEach(function (z) {
        var a = P(z.x0, z.y1), b = P(z.x1, z.y0);
        ctx.fillStyle = 'rgba(90,170,255,0.10)'; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
        ctx.setLineDash([9, 6]); ctx.strokeStyle = 'rgba(160,215,255,0.85)'; ctx.lineWidth = 2; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.setLineDash([]);
      });
    }

    // build grid: only inside the build zone(s), only at valid points
    function validGrid(level) {
      var zs = (BB.Bridge && BB.Bridge.zonesOf) ? BB.Bridge.zonesOf(level) : null;
      var g = level.ground || [];
      var sig = g.length + ':' + (g.length ? g[Math.floor(g.length / 2)].join(',') : '') + ':' + JSON.stringify(zs) + ':' + (level.anchors || []).length + ':' + level.id + ':' + ((level.prebuilt && level.prebuilt.beams) || []).length;
      if (gridCache.key === sig) return gridCache.pts;
      var pts = [], topY = -Infinity;
      (level.anchors || []).forEach(function (a) { if (a[1] > topY) topY = a[1]; });
      (g || []).forEach(function (q) { if (q[1] > topY) topY = q[1]; });
      if (zs && BB.Bridge && BB.Bridge.checkNode) {
        var seen = Object.create(null);
        zs.forEach(function (z) {
          for (var x = Math.ceil(z.x0); x <= z.x1; x++) for (var y = Math.ceil(z.y0); y <= z.y1; y++) {
            var k = x + ',' + y;
            if (seen[k]) continue; seen[k] = 1;
            if (y <= topY + 9 && !BB.Bridge.checkNode(level, x, y)) pts.push([x, y]);
          }
        });
      }
      gridCache = { key: sig, pts: pts };
      return pts;
    }
    function drawBuildGrid(level, scn) {
      if (!scn.showGrid || scn.mode === 'test' || scn.mode === 'leveledit' || cam.zoom < 7) return;
      var pts = validGrid(level), r = clamp(cam.zoom * 0.06, 1.4, 2.6);
      ctx.fillStyle = 'rgba(223,240,255,0.5)';
      for (var i = 0; i < pts.length; i++) {
        var p = P(pts[i][0], pts[i][1]);
        if (p[0] < -6 || p[0] > W + 6 || p[1] < -6 || p[1] > H + 6) continue;
        var major = pts[i][0] % 5 === 0 && pts[i][1] % 5 === 0;
        if (cam.zoom < 10 && !major) continue;
        var rr = major ? r + 0.9 : r;
        ctx.fillRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2);
      }
    }

    // ------------------------------------------------------------------ bridge parts
    function beamColor(m, stress, show, debris, pre) {
      var c = MAT_COLOR[m] || (BB.MATERIALS && BB.MATERIALS[m] && BB.MATERIALS[m].color) || C.line;
      if (show && !debris && isNum(stress)) c = stressRGB(stress);
      return c;
    }
    function drawBeam(b, show, time) {
      var m = b.m, x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
      var a = P(x1, y1), d = P(x2, y2), dx = d[0] - a[0], dy = d[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      var nx = -dy / len, ny = dx / len, z = cam.zoom;
      var col = beamColor(m, b.stress, show, b.debris, b.pre);
      var mm = BB.MATERIALS && BB.MATERIALS[m], look = (mm && mm.look) || m, own = !!(mm && mm.look);   // campaign materials: drawn like a classic one in their own colour
      ctx.globalAlpha = b.debris ? 0.5 : (b.pre ? 0.75 : 1);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      var st = function (w, c, dash) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(d[0], d[1]); ctx.strokeStyle = c; ctx.lineWidth = w; if (dash) ctx.setLineDash(dash); ctx.stroke(); if (dash) ctx.setLineDash([]); };
      var off = function (o, w, c) { ctx.beginPath(); ctx.moveTo(a[0] + nx * o, a[1] + ny * o); ctx.lineTo(d[0] + nx * o, d[1] + ny * o); ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke(); };
      if (own && m === 'log') {                       // trunks side by side
        var hl = Math.max(4.5, z * 0.22);
        st(hl * 2 + 2, C.bg0); off(hl * 0.66, hl * 0.8, col); off(0, hl * 0.8, col); off(-hl * 0.66, hl * 0.8, col);
        ctx.globalAlpha = 1; return;
      }
      if (own && m === 'chain') { st(Math.max(3.5, z * 0.15), col, [Math.max(3, z * 0.2), Math.max(2.5, z * 0.14)]); ctx.globalAlpha = 1; return; }
      switch (look) {
        case 'road': {
          var h = Math.max(3.5, z * 0.17);
          st(h * 2 + 1.5, C.bg0); off(h, 2, col); off(-h, 2, col);
          if (own) st(h * 1.1, col);
          else if (!show) st(1.5, 'rgba(255,210,100,0.8)', [Math.max(5, z * 0.4), Math.max(5, z * 0.4)]);
          break;
        }
        case 'steelroad': {
          var h2 = Math.max(4.2, z * 0.21);
          st(h2 * 2 + 1.5, C.bg0); off(h2, 2.6, col); off(-h2, 2.6, col); st(1.5, col, [Math.max(5, z * 0.35), Math.max(4, z * 0.25)]);
          break;
        }
        case 'wood': st(Math.max(5, z * 0.3), C.bg0); st(Math.max(3.5, z * 0.22), col); st(1.2, C.bg0, [Math.max(4, z * 0.35), Math.max(4, z * 0.35)]); break;
        case 'steel': st(Math.max(5, z * 0.26), C.bg0); st(Math.max(3, z * 0.17), col); break;
        case 'rail': {
          var h3 = Math.max(4, z * 0.2);
          st(h3 * 2 + 3, C.bg0); off(h3, 2.2, col); off(-h3, 2.2, col);
          var n = Math.max(1, Math.round(len / Math.max(8, z * 0.8)));
          for (var q = 0; q <= n; q++) { var t = q / n, cx = a[0] + dx * t, cy = a[1] + dy * t; ctx.beginPath(); ctx.moveTo(cx + nx * h3 * 1.5, cy + ny * h3 * 1.5); ctx.lineTo(cx - nx * h3 * 1.5, cy - ny * h3 * 1.5); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke(); }
          break;
        }
        case 'concrete': {
          var h4 = Math.max(5, z * 0.32);
          ctx.beginPath(); ctx.moveTo(a[0] + nx * h4, a[1] + ny * h4); ctx.lineTo(d[0] + nx * h4, d[1] + ny * h4); ctx.lineTo(d[0] - nx * h4, d[1] - ny * h4); ctx.lineTo(a[0] - nx * h4, a[1] - ny * h4); ctx.closePath();
          ctx.fillStyle = show ? col : 'rgba(170,182,200,0.28)'; ctx.fill(); ctx.strokeStyle = C.concrete; ctx.lineWidth = 2; ctx.stroke();
          break;
        }
        case 'rope': case 'cable': {
          var w = m === 'cable' ? Math.max(2.4, z * 0.1) : Math.max(1.6, z * 0.07);
          if (b.slack > 0.05) {
            var sag = Math.min(b.slack * 0.5, len / z * 0.5) * z, mx = (a[0] + d[0]) / 2, my = (a[1] + d[1]) / 2 + sag;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(mx, my + sag, d[0], d[1]); ctx.strokeStyle = col; ctx.lineWidth = w; if (m === 'rope') ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
          } else st(w, col, m === 'rope' ? [6, 3] : null);
          break;
        }
        case 'spring': {
          var n2 = Math.max(5, Math.round(len / Math.max(6, z * 0.3))), amp = Math.max(4, z * 0.22);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]);
          for (var k = 1; k < n2; k++) { var tk = k / n2, o = (k % 2 ? 1 : -1) * amp; ctx.lineTo(a[0] + dx * tk + nx * o, a[1] + dy * tk + ny * o); }
          ctx.lineTo(d[0], d[1]); ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.stroke();
          break;
        }
        case 'hydraulic': {
          var barrel = Math.min(len * 0.6, (b.restMin || len / z) * z * 0.55), bx = a[0] + dx / len * barrel, by = a[1] + dy / len * barrel;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(bx, by); ctx.strokeStyle = C.bg0; ctx.lineWidth = Math.max(8, z * 0.42); ctx.stroke(); ctx.strokeStyle = col; ctx.lineWidth = Math.max(5.5, z * 0.3); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(d[0], d[1]); ctx.strokeStyle = '#eaf5ff'; ctx.lineWidth = Math.max(2.5, z * 0.12); ctx.stroke();
          break;
        }
        default: st(3, col);
      }
      ctx.globalAlpha = 1;
    }
    function joint(x, y, kind) {
      var p = P(x, y);
      if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) return;
      var r = Math.max(3.6, cam.zoom * (kind === 'debris' ? 0.12 : 0.17));
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, TAU);
      ctx.fillStyle = kind === 'split' ? C.accent : (kind === 'debris' ? 'rgba(223,240,255,0.5)' : C.bg0); ctx.fill();
      ctx.strokeStyle = kind === 'split' ? '#fff' : C.line; ctx.lineWidth = 2; ctx.stroke();
      if (kind === 'split') { ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.4, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); }
    }
    function drawBridgeBuild(level, bridge, scn, time) {
      var beams = (bridge && bridge.beams) || [], pre = (level.prebuilt && level.prebuilt.beams) || [], i, e;
      var seen = Object.create(null), ak = Object.create(null);
      (level.anchors || []).concat((bridge && bridge.found) || []).forEach(function (a) { ak[a[0] + ',' + a[1]] = 1; });
      pre.forEach(function (b) {
        if (b.o) {            // solid obstacle: hatched bar
          var a = P(b.x1, b.y1), d = P(b.x2, b.y2), h = Math.max(5, cam.zoom * 0.3);
          ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(d[0], d[1]); ctx.strokeStyle = C.accent; ctx.lineWidth = h * 2; ctx.stroke();
          ctx.setLineDash([h, h]); ctx.strokeStyle = C.bg0; ctx.stroke(); ctx.setLineDash([]);
        } else drawBeam({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m, pre: true, stress: 0 }, false, time);
      });
      var qk = scn.quick && scn.quick.stress ? scn.quick : null;
      beams.forEach(function (b, bi) {
        if (!b || !isNum(b.x1)) return;
        var broke = qk && qk.broken && qk.broken.indexOf(bi) >= 0;
        drawBeam({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m, stress: qk ? (broke ? 1 : qk.stress[bi]) : 0, debris: false, restMin: Math.hypot(b.x2 - b.x1, b.y2 - b.y1) }, !!qk, time);
      });
      pre.concat(beams).forEach(function (b) {
        if (b.o) return;
        for (e = 0; e < 2; e++) {
          var x = e ? b.x2 : b.x1, y = e ? b.y2 : b.y1, sp = e ? b.s2 : b.s1, k = x + ',' + y + (sp ? '#' : '');
          if (seen[k] || ak[x + ',' + y]) continue; seen[k] = 1;
          if (sp) { var l = Math.hypot(b.x2 - b.x1, b.y2 - b.y1), ux = (e ? b.x1 - b.x2 : b.x2 - b.x1) / l, uy = (e ? b.y1 - b.y2 : b.y2 - b.y1) / l; joint(x + ux * 0.32, y + uy * 0.32, 'split'); } else joint(x, y, 'node');
        }
      });
      // hydraulic phase badges
      beams.forEach(function (b) {
        if (!(BB.MATERIALS[b.m] && BB.MATERIALS[b.m].hyd)) return;
        var p = P((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2), ph = b.ph || ['hold', 'out'];
        tag(p[0], p[1] - Math.max(18, cam.zoom * 0.9), ph.map(function (a) { return a === 'out' ? '↑' : a === 'in' ? '↓' : '–'; }).join(' '), C.accent, '#1b1500');
      });
    }
    function drawBridgeSim(level, sim, scn, time) {
      var beams = sim.beams || [], intact = new Set(), show = !!scn.showStress;
      var pre = (level.prebuilt && level.prebuilt.beams) || [];
      pre.forEach(function (b) {
        if (!b.o) return;
        var a = P(b.x1, b.y1), d = P(b.x2, b.y2), h = Math.max(5, cam.zoom * 0.3);
        ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(d[0], d[1]); ctx.strokeStyle = C.accent; ctx.lineWidth = h * 2; ctx.stroke();
        ctx.setLineDash([h, h]); ctx.strokeStyle = C.bg0; ctx.stroke(); ctx.setLineDash([]);
      });
      beams.forEach(function (b) {
        if (!b || b.broken || !b.a || !b.b) return;
        var pa = b.a, pb = b.b;
        if (!isNum(pa.x) || !isNum(pb.x)) return;
        var len = Math.hypot(pb.x - pa.x, pb.y - pa.y), slack = (b.tensionOnly && isNum(b.rest) && b.rest > len + 0.01) ? b.rest - len : 0;
        drawBeam({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, m: b.m, stress: b.stress, debris: b.debris, pre: !!b.pre, slack: slack, restMin: b.restMin }, show, time);
        if (!b.debris) { intact.add(pa); intact.add(pb); }
      });
      (sim.joints || []).forEach(function (p) { if (p && !p.anchor && p.deg > 0 && isNum(p.x)) joint(p.x, p.y, intact.has(p) ? 'node' : 'debris'); });
    }
    /** Debug display: the load of every beam in percent, written at its middle. */
    function drawDebugLabels(sim) {
      ctx.font = '700 11px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      (sim.beams || []).forEach(function (b) {
        if (!b || b.broken || b.debris || !b.a || !b.b || !isNum(b.stress) || b.stress < 0.02) return;
        var q = P((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2), t = String(Math.round(b.stress * 100));
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(7,26,53,0.92)'; ctx.strokeText(t, q[0], q[1]); ctx.fillStyle = stressRGB(b.stress); ctx.fillText(t, q[0], q[1]);
      });
    }
    function drawPistons(level, sim) {
      var list = [];
      if (sim && sim._s && sim._s.pistons) sim._s.pistons.forEach(function (p) { list.push([p.pivot.x, p.pivot.y, p.head.x, p.head.y, p.minLen]); });
      else (level.pistons || []).forEach(function (d) { var r = (+d.angleDeg || 0) * Math.PI / 180, l = isNum(d.startLen) ? d.startLen : d.minLen || 1; list.push([d.pivotX, d.pivotY, d.pivotX + Math.cos(r) * l, d.pivotY + Math.sin(r) * l, d.minLen || 1]); });
      list.forEach(function (q) {
        var a = P(q[0], q[1]), d = P(q[2], q[3]), dx = d[0] - a[0], dy = d[1] - a[1], len = Math.hypot(dx, dy) || 1, barrel = Math.min(len, Math.max(0.5, q[4] * 0.85) * cam.zoom);
        ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0] + dx / len * barrel, a[1] + dy / len * barrel); ctx.strokeStyle = C.bg0; ctx.lineWidth = Math.max(10, cam.zoom * 0.62); ctx.stroke(); ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(7, cam.zoom * 0.46); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(a[0] + dx / len * barrel, a[1] + dy / len * barrel); ctx.lineTo(d[0], d[1]); ctx.strokeStyle = '#eaf5ff'; ctx.lineWidth = Math.max(3.5, cam.zoom * 0.2); ctx.stroke();
        ctx.fillStyle = C.bg0; ctx.strokeStyle = C.line; ctx.lineWidth = 2; var r = Math.max(5, cam.zoom * 0.3);
        ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, TAU); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.arc(d[0], d[1], r * 0.8, 0, TAU); ctx.fill(); ctx.stroke();
      });
    }

    // ------------------------------------------------------------------ vehicles & ships (outline drawings, local frame in metres)
    var WHEEL_ONLY = { bike: 1, motorcycle: 1 };
    function profile(type, def) {
      var L = def.length, h = def.height, hl = L / 2;
      switch (type) {
        case 'car': return [[-hl, 0.35], [-hl, 0.95], [-hl * 0.55, 1.0], [-hl * 0.28, 1.5], [hl * 0.3, 1.5], [hl * 0.62, 1.0], [hl, 0.95], [hl, 0.35]];
        case 'bus': return [[-hl, 0.4], [-hl, h], [hl - 0.4, h], [hl, h - 0.8], [hl, 0.4]];
        case 'truck': return [[-hl, 0.5], [-hl, h], [hl * 0.25, h], [hl * 0.25, 1.9], [hl * 0.5, 1.9], [hl * 0.62, 1.2], [hl, 1.2], [hl, 0.5]];
        case 'tanker': return [[-hl, 0.5], [-hl, 1.0], [hl * 0.42, 1.0], [hl * 0.42, 2.1], [hl * 0.6, 2.4], [hl, 1.6], [hl, 0.5]];
        case 'crane': return [[-hl, 0.5], [-hl, 1.5], [-hl * 0.1, 1.5], [hl * 0.3, 2.8], [hl * 0.6, 2.8], [hl * 0.6, 1.2], [hl, 1.2], [hl, 0.5]];
        case 'train': return [[-hl, 0.7], [-hl, h - 0.4], [hl * 0.5, h - 0.4], [hl - 3.4, h - 0.4], [hl - 3.4, h - 0.9], [hl - 0.6, h - 1.1], [hl, 1.4], [hl, 0.7]];
        default: return [[-hl, 0.4], [-hl, h], [hl, h], [hl, 0.4]];
      }
    }
    function drawVehicle(v, time, mapCol) {
      var def = v.def || (BB.VEHICLES && BB.VEHICLES[v.type]) || { length: 4, height: 1.4, wheelRadius: 0.35, axles: [] }, p = v.pose;
      var s = P(p.x, p.y), z = cam.zoom, a = isNum(p.angle) ? p.angle : 0;
      ctx.save(); ctx.translate(s[0], s[1]); ctx.scale(z, -z); ctx.rotate(a);
      var lw = 2 / z; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var col = (v.color && v.color !== def.color) ? v.color : null;
      if (!WHEEL_ONLY[v.type]) {
        var pr = profile(v.type, def);
        ctx.beginPath(); ctx.moveTo(pr[0][0], pr[0][1]); for (var i = 1; i < pr.length; i++) ctx.lineTo(pr[i][0], pr[i][1]); ctx.closePath();
        ctx.fillStyle = 'rgba(10,33,66,0.82)'; ctx.fill(); ctx.strokeStyle = C.line; ctx.stroke();
        // windows
        ctx.strokeStyle = C.lineDim;
        var L = def.length;
        if (v.type === 'bus' || v.type === 'train') { var n = v.type === 'bus' ? 6 : 14, w0 = (L - 2) / n; for (var k = 0; k < n; k++) ctx.strokeRect(-L / 2 + 1 + k * w0 + 0.1, def.height * 0.55, w0 - 0.35, def.height * 0.28); }
        else if (v.type === 'car') { ctx.beginPath(); ctx.moveTo(-L * 0.25, 1.05); ctx.lineTo(-L * 0.12, 1.38); ctx.lineTo(L * 0.26, 1.38); ctx.lineTo(L * 0.4, 1.05); ctx.closePath(); ctx.stroke(); }
        else if (v.type === 'tanker') { ctx.beginPath(); ctx.ellipse(-L * 0.12, 1.6, L * 0.34, 0.75, 0, 0, TAU); ctx.stroke(); }
        else if (v.type === 'truck') { ctx.strokeRect(L * 0.27, 1.5, L * 0.12, 0.45); ctx.strokeRect(-L / 2 + 0.3, 0.8, L * 0.74, def.height - 1.1); }
        else if (v.type === 'crane') { ctx.beginPath(); ctx.moveTo(-L * 0.2, 1.7); ctx.lineTo(L * 0.34, 3.8); ctx.strokeStyle = C.line; ctx.lineWidth = lw * 2.2; ctx.stroke(); ctx.lineWidth = lw; }
        if (col) { ctx.fillStyle = col; ctx.fillRect(-L / 2 + 0.2, 0.45, L - 0.4, 0.22); }
      } else {
        // bicycle / motorcycle: frame lines + rider
        var rr = def.wheelRadius, fx0 = def.axles[0], fx1 = def.axles[1];
        ctx.strokeStyle = col || C.line; ctx.lineWidth = lw * 1.6;
        ctx.beginPath(); ctx.moveTo(fx0, 0); ctx.lineTo(0.0, 0.55); ctx.lineTo(fx1 - 0.1, 0.5); ctx.moveTo(0.0, 0.55); ctx.lineTo(fx0 + 0.15, 0.7); ctx.moveTo(fx1 - 0.1, 0.5); ctx.lineTo(fx1 * 0.95, 0.95); ctx.stroke();
        ctx.strokeStyle = C.line; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(0.05, 0.7); ctx.lineTo(-0.02, 1.15); ctx.lineTo(fx1 * 0.55, 1.0); ctx.stroke();
        ctx.beginPath(); ctx.arc(-0.02, 1.4, 0.2, 0, TAU); ctx.fillStyle = 'rgba(10,33,66,0.9)'; ctx.fill(); ctx.stroke();
      }
      // wheels
      var wl = v.wheels || [];
      for (var wi = 0; wi < wl.length; wi++) {
        var w = wl[wi]; if (!w || !w.p) continue;
        var ddx = w.p.x - p.x, ddy = w.p.y - p.y, ca = Math.cos(a), sa = Math.sin(a);
        var lx = ddx * ca + ddy * sa, ly = -ddx * sa + ddy * ca, r = w.r || def.wheelRadius, rot = (isNum(w.angle) ? w.angle : 0) - a;
        ctx.save(); ctx.translate(lx, ly); ctx.rotate(rot);
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = C.bg0; ctx.fill(); ctx.strokeStyle = C.line; ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-r * 0.8, 0); ctx.lineTo(r * 0.8, 0); ctx.moveTo(0, -r * 0.8); ctx.lineTo(0, r * 0.8); ctx.lineWidth = lw * 0.8; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
    /** Passage gate ("Durchfahrt"): dashed frame in the bridge plane + the vessel as a front-view outline behind it. */
    function drawGate(g, live, level, time) {
      var wl = isNum(level.water) ? level.water : g.y0, clear = Math.round((g.y1 - (g.kind === 'ship' ? wl : g.y0)) * 2) / 2;
      var state = live ? live.state : 'idle', zc = live ? live.zc : g.zStart;
      var a0 = P(g.x0, g.y1), a1 = P(g.x1, g.y0), w = a1[0] - a0[0], h = a1[1] - a0[1];
      var col = state === 'blocked' ? C.bad : state === 'done' ? 'rgba(160,215,190,0.75)' : C.accent;
      // vessel silhouette (it grows a little while it approaches, then passes the frame)
      var near = clamp(1 - Math.abs(Math.min(zc, 0)) / 36, 0.12, 1), alpha = state === 'done' ? 0.25 : 0.2 + 0.6 * near;
      var cx = (a0[0] + a1[0]) / 2, base = a1[1], topY = a0[1], sw = Math.min(w * 0.7, cam.zoom * 7), sc = 0.78 + 0.22 * near;
      ctx.save(); ctx.globalAlpha = alpha; ctx.lineWidth = 1.8; ctx.strokeStyle = C.line; ctx.fillStyle = 'rgba(10,33,66,0.55)'; ctx.lineJoin = 'round';
      if (g.kind === 'ship') {
        var hullH = Math.min(cam.zoom * 1.3, (base - topY) * 0.3) * sc, bw = sw * sc;
        ctx.beginPath(); ctx.moveTo(cx - bw / 2, base - hullH); ctx.lineTo(cx - bw * 0.36, base + 2); ctx.lineTo(cx + bw * 0.36, base + 2); ctx.lineTo(cx + bw / 2, base - hullH); ctx.closePath(); ctx.fill(); ctx.stroke();
        var cabH = Math.min((base - topY) * 0.3, cam.zoom * 2.4) * sc;
        ctx.strokeRect(cx - bw * 0.3, base - hullH - cabH, bw * 0.6, cabH);
        if (base - topY > cam.zoom * 4.5) { var mt = topY + 0.3 * cam.zoom; ctx.beginPath(); ctx.moveTo(cx, base - hullH - cabH); ctx.lineTo(cx, mt); ctx.moveTo(cx - bw * 0.22, mt + cam.zoom * 0.7); ctx.lineTo(cx + bw * 0.22, mt + cam.zoom * 0.7); ctx.stroke(); }
      } else {
        var vw = Math.min(w * 0.55, cam.zoom * (g.kind === 'train' ? 3.4 : 2.8)) * sc, vh = (base - topY) * 0.9;
        ctx.beginPath(); ctx.rect(cx - vw / 2, base - vh, vw, vh); ctx.fill(); ctx.stroke();
        ctx.strokeRect(cx - vw * 0.36, base - vh * 0.88, vw * 0.72, vh * 0.34);
        ctx.beginPath(); ctx.arc(cx - vw * 0.3, base - vh * 0.06, Math.max(2, cam.zoom * 0.28), 0, TAU); ctx.arc(cx + vw * 0.3, base - vh * 0.06, Math.max(2, cam.zoom * 0.28), 0, TAU); ctx.stroke();
      }
      ctx.restore();
      // frame
      ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.setLineDash([9, 6]); ctx.strokeRect(a0[0], a0[1], w, h);
      ctx.setLineDash([]); ctx.lineWidth = 2.4; ctx.beginPath();
      ctx.moveTo(a0[0], a0[1] + 10); ctx.lineTo(a0[0], a0[1]); ctx.lineTo(a0[0] + 10, a0[1]); ctx.moveTo(a1[0] - 10, a0[1]); ctx.lineTo(a1[0], a0[1]); ctx.lineTo(a1[0], a0[1] + 10); ctx.stroke();
      var txt = (g.label || ('Durchfahrt ' + String(clear).replace('.', ',') + ' m')) + (state === 'blocked' ? ' – blockiert!' : '');
      ctx.font = '600 12px -apple-system, "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tw = ctx.measureText(txt).width + 14, tx = (a0[0] + a1[0]) / 2, ty = a0[1] - 12;
      ctx.fillStyle = 'rgba(7,26,53,0.88)'; ctx.fillRect(tx - tw / 2, ty - 10, tw, 20); ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(tx - tw / 2 + 0.5, ty - 9.5, tw - 1, 19);
      ctx.fillStyle = col === C.accent ? '#ffe3a3' : '#ffffff'; ctx.fillText(txt, tx, ty + 1);
      // clearance arrow
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; var ax = a0[0] + w + 9;
      ctx.beginPath(); ctx.moveTo(ax, a0[1]); ctx.lineTo(ax, a1[1]); ctx.moveTo(ax - 4, a0[1] + 6); ctx.lineTo(ax, a0[1]); ctx.lineTo(ax + 4, a0[1] + 6); ctx.moveTo(ax - 4, a1[1] - 6); ctx.lineTo(ax, a1[1]); ctx.lineTo(ax + 4, a1[1] - 6); ctx.stroke();
      ctx.restore();
    }

    // ------------------------------------------------------------------ FX
    function pushFx(p) { if (fx.length > 260) fx.shift(); fx.push(p); }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    var CONF = ['#ff6b5e', '#ffc247', '#52d98c', '#4da3ff', '#c08cff'];
    function addEvents(events) {
      if (!events || !events.length) return;
      events.forEach(function (e) {
        if (!e) return;
        try {
          if (e.type === 'break') for (var i = 0; i < 14; i++) pushFx({ k: 'chip', x: e.x + rnd(-0.2, 0.2), y: e.y + rnd(-0.2, 0.2), vx: rnd(-4, 4), vy: rnd(1, 6.5), life: rnd(0.8, 1.5), max: 1.5, c: MAT_COLOR[e.m] || '#fff', g: 1 });
          else if (e.type === 'splash') { var wy = lastScene && lastScene.level && isNum(lastScene.level.water) ? lastScene.level.water : e.y; for (var j = 0; j < 16; j++) pushFx({ k: 'drop', x: e.x + rnd(-0.4, 0.4), y: wy, vx: rnd(-2.4, 2.4), vy: rnd(2.5, 6.5), life: rnd(0.7, 1.2), max: 1.2, c: '#bfe3ff', g: 1, water: wy }); pushFx({ k: 'ring', x: e.x, y: wy, vx: 0, vy: 0, life: 0.9, max: 0.9, c: '#bfe3ff', g: 0 }); }
          else if (e.type === 'finish' && lastScene && lastScene.level) { var lv = lastScene.level, routes = BB.routesOf ? BB.routesOf(lv) : [{ flagX: lv.flagX }]; routes.forEach(function (rt) { var y = surfaceY(lv.ground, rt.flagX) + 5.4; for (var q = 0; q < 18; q++) pushFx({ k: 'conf', x: rt.flagX + 1 + rnd(-0.6, 0.6), y: y, vx: rnd(-3, 3), vy: rnd(2, 5.5), life: rnd(1.6, 2.6), max: 2.6, c: CONF[(Math.random() * 5) | 0], g: 0.3 }); }); }
        } catch (err) { /* effects must never break the game */ }
      });
    }
    function updateFx(dt, level) {
      var g = level && level.ground, water = level && isNum(level.water) ? level.water : null;
      for (var i = fx.length - 1; i >= 0; i--) {
        var p = fx[i]; p.life -= dt; var dead = p.life <= 0;
        if (!dead) {
          p.vy -= 9.81 * p.g * dt; if (p.k === 'conf') { p.vx *= 1 - 1.2 * dt; p.vy = Math.max(p.vy, -1.6); }
          p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.k === 'drop' && p.vy < 0 && p.y < p.water) dead = true;
          if (p.k === 'chip' && water !== null && p.y < water) { p.vx *= 0.9; p.vy = Math.max(p.vy, -1); }
          if (p.k === 'chip' && g) { var sy = surfaceY(g, p.x); if (p.y < sy && p.y > sy - 1.5) { p.y = sy; p.vy *= -0.3; p.vx *= 0.55; } }
        }
        if (dead) { fx[i] = fx[fx.length - 1]; fx.pop(); }
      }
    }
    function drawFx() {
      for (var i = 0; i < fx.length; i++) {
        var p = fx[i], a = clamp(p.life / p.max, 0, 1), s = P(p.x, p.y);
        ctx.globalAlpha = Math.min(1, a * 2.5); ctx.fillStyle = p.c; ctx.strokeStyle = p.c;
        if (p.k === 'ring') { var rx = Math.max(4, cam.zoom * 0.4) * (1 + (1 - a) * 4); ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(s[0], s[1], rx, rx * 0.22, 0, 0, TAU); ctx.stroke(); }
        else if (p.k === 'conf') ctx.fillRect(s[0] - 3, s[1] - 2, 6, 4);
        else ctx.fillRect(s[0] - 2, s[1] - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    // ------------------------------------------------------------------ overlays
    function tag(x, y, text, bg, fg) {
      ctx.font = '700 13px system-ui, sans-serif';
      var w = ctx.measureText(text).width + 14, h = 22, rx = x - w / 2, ry = y - h / 2, r = 5;
      ctx.beginPath(); ctx.moveTo(rx + r, ry); ctx.arcTo(rx + w, ry, rx + w, ry + h, r); ctx.arcTo(rx + w, ry + h, rx, ry + h, r); ctx.arcTo(rx, ry + h, rx, ry, r); ctx.arcTo(rx, ry, rx + w, ry, r); ctx.closePath();
      ctx.fillStyle = bg; ctx.fill(); ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 1);
    }
    function fmtLen(l) { return (Math.round(l * 10) / 10).toString().replace('.', ',') + ' m'; }
    function drawOverlays(scn) {
      var level = scn.level, mode = scn.mode || 'build', z = cam.zoom;
      if (scn.deleteHighlight !== null && scn.deleteHighlight !== undefined && scn.bridge && scn.bridge.beams) {
        var db = scn.bridge.beams[scn.deleteHighlight];
        if (db) { var d1 = P(db.x1, db.y1), d2 = P(db.x2, db.y2); ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,90,77,' + (0.5 + 0.2 * Math.sin(scn.time * 8)) + ')'; ctx.lineWidth = Math.max(10, z * 0.8); ctx.beginPath(); ctx.moveTo(d1[0], d1[1]); ctx.lineTo(d2[0], d2[1]); ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]); }
      }
      if (scn.overlay && BB.Overlay) BB.Overlay.draw(ctx, P, z, scn.overlay, scn.time);
      var pv = scn.preview;
      if (pv && isNum(pv.x1) && isNum(pv.x2)) {
        var a1 = P(pv.x1, pv.y1), a2 = P(pv.x2, pv.y2);
        ctx.lineCap = 'round';
        if (pv.valid) {
          ctx.globalAlpha = 0.8; drawBeam({ x1: pv.x1, y1: pv.y1, x2: pv.x2, y2: pv.y2, m: pv.m, stress: 0 }, false, 0); ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff'; ctx.strokeStyle = C.bg0; ctx.lineWidth = 2.5;
          [a1, a2].forEach(function (q) { ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(6, z * 0.2), 0, TAU); ctx.fill(); ctx.stroke(); });
        } else {
          ctx.strokeStyle = C.bad; ctx.lineWidth = Math.max(4, z * 0.28); ctx.setLineDash([10, 7]); ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(a2[0], a2[1], 12, 0, TAU); ctx.stroke();
        }
        var len = isNum(pv.length) ? pv.length : Math.hypot(pv.x2 - pv.x1, pv.y2 - pv.y1);
        var mx = (a1[0] + a2[0]) / 2, my = (a1[1] + a2[1]) / 2, nx = -(a2[1] - a1[1]), ny = a2[0] - a1[0], nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl; if (ny > 0) { nx = -nx; ny = -ny; }
        tag(mx + nx * 28, my + ny * 28, fmtLen(len), pv.valid ? '#eaf5ff' : C.bad, pv.valid ? '#0a2142' : '#fff');
      }
      if (scn.hoverNode && isNum(scn.hoverNode[0])) {
        var hp = P(scn.hoverNode[0], scn.hoverNode[1]), hr = Math.max(13, 0.62 * z) * (1 + 0.07 * Math.sin(scn.time * 6));
        ctx.beginPath(); ctx.arc(hp[0], hp[1], hr, 0, TAU); ctx.fillStyle = 'rgba(255,194,71,0.18)'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.accent; ctx.stroke();
      }
      if (scn.hoverFoundation) {
        var hf = scn.hoverFoundation, hSurf = isNum(hf[4]) ? hf[4] : hf[1] - 1.2, hBot = Math.min(hSurf, hf[1] - 0.3);
        var f1 = P(hf[0] - 0.85, hf[1]), f2 = P(hf[0] + 0.85, hBot), okc = hf[2];
        ctx.fillStyle = okc ? 'rgba(82,217,140,0.38)' : 'rgba(255,90,77,0.38)'; ctx.strokeStyle = okc ? '#bff3d5' : C.bad; ctx.lineWidth = 2.5;
        ctx.fillRect(f1[0], f1[1], f2[0] - f1[0], f2[1] - f1[1]); ctx.strokeRect(f1[0], f1[1], f2[0] - f1[0], f2[1] - f1[1]);
        if (!okc) { ctx.beginPath(); ctx.moveTo(f1[0] + 5, f1[1] + 5); ctx.lineTo(f2[0] - 5, f2[1] - 5); ctx.moveTo(f2[0] - 5, f1[1] + 5); ctx.lineTo(f1[0] + 5, f2[1] - 5); ctx.stroke(); }
        var ft = okc ? 'Fundament setzen' : (hf[3] || 'Hier nicht möglich');
        ctx.font = '600 12.5px -apple-system, "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var ftw = ctx.measureText(ft).width + 14, ftx = (f1[0] + f2[0]) / 2, fty = f1[1] - 24;
        ctx.fillStyle = 'rgba(7,26,53,0.92)'; ctx.fillRect(ftx - ftw / 2, fty - 11, ftw, 22); ctx.strokeStyle = okc ? C.ok : C.bad; ctx.lineWidth = 1.2; ctx.strokeRect(ftx - ftw / 2 + 0.5, fty - 10.5, ftw - 1, 21);
        ctx.fillStyle = '#fff'; ctx.fillText(ft, ftx, fty + 1);
      }
      if (mode === 'leveledit' && scn.leveledit) {
        var le = scn.leveledit, g = level.ground;
        if (le.rect) { var r0 = P(le.rect.x0, le.rect.y1), r1 = P(le.rect.x1, le.rect.y0); ctx.fillStyle = 'rgba(90,170,255,0.25)'; ctx.fillRect(r0[0], r0[1], r1[0] - r0[0], r1[1] - r0[1]); ctx.setLineDash([9, 6]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.strokeRect(r0[0], r0[1], r1[0] - r0[0], r1[1] - r0[1]); ctx.setLineDash([]); }
        if (Array.isArray(g)) {
          var active = le.tool === 'terrain' || le.tool === 'erase', hv = isNum(le.hoverVertex) ? le.hoverVertex : -1, r = active ? 6.5 : 4.5;
          ctx.globalAlpha = active ? 1 : 0.6; ctx.beginPath();
          for (var gi = 0; gi < g.length; gi++) { if (gi === hv || !g[gi]) continue; var gp = P(g[gi][0], g[gi][1]); if (gp[0] < -20 || gp[0] > W + 20 || gp[1] < -20 || gp[1] > H + 20) continue; ctx.moveTo(gp[0] + r, gp[1]); ctx.arc(gp[0], gp[1], r, 0, TAU); }
          ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = C.bg0; ctx.stroke(); ctx.globalAlpha = 1;
          if (hv >= 0 && g[hv]) { var hq = P(g[hv][0], g[hv][1]); ctx.beginPath(); ctx.arc(hq[0], hq[1], 11, 0, TAU); ctx.fillStyle = le.tool === 'erase' ? C.bad : C.accent; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        }
        // editor grid: dots on the ground line and in the air near the build area
        var b = level.build;
        if (b && z >= 8) {
          ctx.fillStyle = 'rgba(223,240,255,0.55)';
          for (var x = Math.ceil(b.minX); x <= b.maxX; x++) for (var y = Math.ceil(b.minY); y <= b.maxY; y++) {
            var sy = surfaceY(g, x); if (y < sy - 1e-6) continue;
            var q = P(x, y); if (q[0] < -4 || q[0] > W + 4 || q[1] < -4 || q[1] > H + 4) continue;
            ctx.fillRect(q[0] - 1.3, q[1] - 1.3, 2.6, 2.6);
          }
        }
      }
    }

    // ------------------------------------------------------------------ frame
    function draw(scn) {
      if (!scn) return;
      checkSize();
      var level = scn.level || (scn.sim && scn.sim.level) || null;
      cam = scn.camera && isNum(scn.camera.zoom) && scn.camera.zoom > 0 ? scn.camera : (level ? fitCamera(level, null) : { x: 0, y: 0, zoom: 20 });
      lastScene = scn;
      var time = isNum(scn.time) ? scn.time : 0, dt = fxLast === null ? 0 : time - fxLast; if (!(dt >= 0) || dt > 0.2) dt = 0; fxLast = time;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (!level) { ctx.fillStyle = C.bg0; ctx.fillRect(0, 0, W, H); return; }
      var mode = scn.mode || 'build', sim = mode === 'test' && scn.sim ? scn.sim : null;
      updateFx(dt, level);
      drawBackground(level, time);
      drawTerrainAndWater(level, time);
      drawGapScenery(level, time);
      drawBuildArea(level, scn);
      drawZones(level, scn);
      (BB.Gates ? BB.Gates.of(level) : []).forEach(function (g, i) { drawGate(g, sim && sim.gates ? sim.gates[i] : null, level, time); });
      drawBuildGrid(level, scn);
      drawPylons(level);
      drawGoals(level, time, sim);
      if (BB.Overlay && BB.Overlay.drawRoutes) BB.Overlay.drawRoutes(ctx, P, cam.zoom, level, { lines: true, preview: mode === 'build', sim: sim, hide: hideFlags });
      drawPistons(level, sim);
      drawSignals(level, sim);
      if (sim) drawBridgeSim(level, sim, scn, time); else drawBridgeBuild(level, scn.bridge, scn, time);
      if (sim && scn.debug) drawDebugLabels(sim);
      drawAnchors(level, scn.bridge);
      if (sim) {
        (sim.vehicles || []).forEach(function (v) { if (v && v.state !== 'waiting' && v.visible !== false && !v.removed && v.pose && isNum(v.pose.x)) drawVehicle(v, time); });
        var cg = sim._s && sim._s.cargo ? sim._s.cargo : [];
        cg.forEach(function (c) { if (!c.p || !c.p.on) return; var s = P(c.p.x, c.p.y), h = cam.zoom * 0.32; ctx.fillStyle = 'rgba(10,33,66,0.9)'; ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.fillRect(s[0] - h, s[1] - h, h * 2, h * 2); ctx.strokeRect(s[0] - h, s[1] - h, h * 2, h * 2); ctx.beginPath(); ctx.moveTo(s[0] - h, s[1] - h); ctx.lineTo(s[0] + h, s[1] + h); ctx.moveTo(s[0] + h, s[1] - h); ctx.lineTo(s[0] - h, s[1] + h); ctx.stroke(); });
      }
      drawFx();
      if (isNum(level.wind) && level.wind) {      // wind: a few drifting dashes
        ctx.strokeStyle = 'rgba(223,240,255,0.22)'; ctx.lineWidth = 1.5;
        for (var i = 0; i < 14; i++) { var u = ((i * 0.137 + time * 0.05 * level.wind * (0.6 + (i % 3) * 0.2)) % 1 + 1) % 1, yy = H * (0.08 + (i * 0.071) % 0.5), xx = u * W; ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + 34 * Math.sign(level.wind), yy); ctx.stroke(); }
      }
      drawOverlays(scn);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    resize();
    return {
      canvas: canvas, is3d: false, isBlueprint: true, resize: resize, draw: draw, worldToScreen: worldToScreen, screenToWorld: screenToWorld, fitCamera: fitCamera,
      addEvents: addEvents, clearEffects: function () { fx.length = 0; },
      debugHide: function (what, hide) { if (what === 'flags') hideFlags = !!hide; if (what === 'water') hideWater = !!hide; },
      get width() { return W; }, get height() { return H; },
    };
  }

  /** Small blueprint drawing of a level (terrain, water, goals – no bridge), for level cards and previews. */
  function thumbnail(level, w, h) {
    var c = document.createElement('canvas');
    var R = create(c, { size: [w, h] });
    var cam = R.fitCamera(level, { top: 6, left: 6, right: 6, bottom: 6 });
    R.draw({ mode: 'build', level: level, camera: cam, time: 0, bridge: { beams: [] }, showGrid: false });
    return c;
  }

  BB.RenderBP = { create: create, thumbnail: thumbnail, MAT_COLOR: MAT_COLOR, stressRGB: stressRGB };
})(globalThis.BB = globalThis.BB || {});
