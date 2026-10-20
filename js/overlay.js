/*
 * Brückenbauer – overlay.js
 * ----------------------------------------------------------------------------
 * Build-mode overlays that look the same in all three renderers (architect view, scene view, classic 2D):
 * selection highlight and box, ghosts of moved / pasted / rotated / traced parts (green = fits, red = does not fit),
 * short labels. The renderers hand in their own canvas context and a world → screen function.
 *
 *   BB.Overlay.draw(ctx, P, pxPerMetre, overlay, time)
 *   overlay = { sel: [[x1,y1,x2,y2]…], box: {x0,y0,x1,y1}, ghost: { items:[{x1,y1,x2,y2,valid,skip}], ok, label },
 *               guide: [[x,y]…] (dotted helper polyline, e.g. the circle of an arc), labels: [{x,y,text,kind}] }
 * Pure canvas 2D, no DOM access.
 */
(function (BB) {
  'use strict';

  var TAU = Math.PI * 2;
  var OK = '82,217,140', BAD = '255,90,77', ACC = '255,194,71';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function tag(ctx, x, y, text, bg, fg) {
    ctx.save();
    ctx.font = '700 13px -apple-system, "Segoe UI", system-ui, sans-serif';
    var w = ctx.measureText(text).width + 16, h = 24, rx = x - w / 2, ry = y - h / 2, r = 6;
    ctx.beginPath();
    ctx.moveTo(rx + r, ry); ctx.arcTo(rx + w, ry, rx + w, ry + h, r); ctx.arcTo(rx + w, ry + h, rx, ry + h, r); ctx.arcTo(rx, ry + h, rx, ry, r); ctx.arcTo(rx, ry, rx + w, ry, r);
    ctx.closePath();
    ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  function seg(ctx, a, b, color, width, dash) {
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  function dot(ctx, p, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, TAU);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke();
  }

  function draw(ctx, P, z, ov, time) {
    if (!ov) return;
    var i, it, a, b, w = Math.max(9, z * 0.5);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // selection: soft amber halo along every selected beam, white dashes on top, rings on the joints
    if (ov.sel && ov.sel.length) {
      var seen = Object.create(null), pulse = 0.5 + 0.1 * Math.sin((time || 0) * 5);
      for (i = 0; i < ov.sel.length; i++) {
        it = ov.sel[i]; a = P(it[0], it[1]); b = P(it[2], it[3]);
        seg(ctx, a, b, 'rgba(' + ACC + ',' + pulse + ')', w * 1.5);
      }
      for (i = 0; i < ov.sel.length; i++) {
        it = ov.sel[i]; a = P(it[0], it[1]); b = P(it[2], it[3]);
        seg(ctx, a, b, 'rgba(255,255,255,0.95)', 1.6, [6, 5]);
      }
      for (i = 0; i < ov.sel.length; i++) {
        it = ov.sel[i];
        [[it[0], it[1]], [it[2], it[3]]].forEach(function (q) {
          var k = q[0] + ',' + q[1];
          if (seen[k]) return; seen[k] = 1;
          dot(ctx, P(q[0], q[1]), Math.max(4.5, z * 0.2), 'rgba(' + ACC + ',1)', '#ffffff', 2);
        });
      }
    }

    // selection box
    if (ov.box) {
      a = P(ov.box.x0, ov.box.y1); b = P(ov.box.x1, ov.box.y0);
      ctx.fillStyle = 'rgba(120,190,255,0.13)'; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(205,230,255,0.95)'; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.setLineDash([]);
    }

    // helper polyline (circle of an arc …)
    if (ov.guide && ov.guide.length > 1) {
      ctx.beginPath();
      for (i = 0; i < ov.guide.length; i++) { a = P(ov.guide[i][0], ov.guide[i][1]); if (i) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); }
      ctx.strokeStyle = 'rgba(205,230,255,0.45)'; ctx.lineWidth = 1.4; ctx.setLineDash([3, 6]); ctx.stroke(); ctx.setLineDash([]);
    }

    // ghost: where the moved / pasted / traced parts would stand
    if (ov.ghost && ov.ghost.items && ov.ghost.items.length) {
      var G = ov.ghost, nodes = Object.create(null), anyBad = false;
      for (i = 0; i < G.items.length; i++) {
        it = G.items[i];
        if (!isNum(it.x1) || !isNum(it.x2) || it.skip) continue;
        var col = it.valid ? OK : BAD;
        if (!it.valid) anyBad = true;
        a = P(it.x1, it.y1); b = P(it.x2, it.y2);
        seg(ctx, a, b, 'rgba(10,25,50,0.35)', w + 3);
        seg(ctx, a, b, 'rgba(' + col + ',' + (it.valid ? 0.62 : 0.78) + ')', w);
        if (!it.valid) seg(ctx, a, b, 'rgba(255,255,255,0.8)', 1.4, [5, 5]);
        [it.x1 + ',' + it.y1, it.x2 + ',' + it.y2].forEach(function (k) { nodes[k] = nodes[k] === false ? false : it.valid; });
      }
      Object.keys(nodes).forEach(function (k) {
        var xy = k.split(',');
        dot(ctx, P(+xy[0], +xy[1]), Math.max(4, z * 0.17), '#ffffff', nodes[k] ? 'rgb(' + OK + ')' : 'rgb(' + BAD + ')', 2.2);
      });
      if (G.label) {
        var sx = 0, sy = 0, n = 0;
        G.items.forEach(function (q) { if (isNum(q.x1) && !q.skip) { sx += (q.x1 + q.x2) / 2; sy += (q.y1 + q.y2) / 2; n++; } });
        if (n) { var c = P(sx / n, sy / n); tag(ctx, c[0], c[1] - Math.max(30, z * 1.4), G.label, anyBad ? 'rgb(' + BAD + ')' : 'rgba(234,245,255,0.96)', anyBad ? '#fff' : '#0a2142'); }
      }
    }

    // free labels
    if (ov.labels) {
      for (i = 0; i < ov.labels.length; i++) {
        var lb = ov.labels[i], p = P(lb.x, lb.y);
        tag(ctx, p[0], p[1], lb.text, lb.kind === 'bad' ? 'rgb(' + BAD + ')' : lb.kind === 'ok' ? 'rgba(46,160,96,0.95)' : 'rgba(234,245,255,0.96)', lb.kind === 'bad' || lb.kind === 'ok' ? '#fff' : '#0a2142');
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------------------------------------------------
  // v3.4: routes – numbered flags, dashed route line with arrows (architect view), vehicle silhouettes at the start
  // ------------------------------------------------------------------------------------------------------------
  function groundAt(level, x) {
    var g = level && level.ground;
    if (!g || !g.length) return 0;
    var y = BB.Terrain && BB.Terrain.surfaceY ? BB.Terrain.surfaceY(g, x) : NaN;
    return isNum(y) ? y : g[0][1];
  }
  function badge(ctx, x, y, text, bg, fg, done) {
    var r = 12;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = done ? '#2ea060' : bg; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.fillStyle = fg; ctx.font = '800 13px -apple-system, "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (done) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(x - 5, y + 0.5); ctx.lineTo(x - 1.5, y + 4); ctx.lineTo(x + 5.5, y - 4); ctx.stroke(); }
    else ctx.fillText(text, x, y + 1);
    ctx.restore();
  }
  function arrow(ctx, a, b, color, size) {
    var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    ctx.beginPath();
    ctx.moveTo(mx + ux * size, my + uy * size);
    ctx.lineTo(mx - ux * size * 0.7 - uy * size * 0.8, my - uy * size * 0.7 + ux * size * 0.8);
    ctx.lineTo(mx - ux * size * 0.7 + uy * size * 0.8, my - uy * size * 0.7 - ux * size * 0.8);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  /** side-view silhouette of a vehicle standing on the ground at (x, y): length / height in metres, drawn in the given colour */
  function silhouette(ctx, P, z, key, x, y, color, alpha) {
    var def = (BB.VEHICLES && BB.VEHICLES[key]) || { length: 4, height: 1.5, wheelRadius: 0.35, axles: [-1.2, 1.2] };
    var L = def.length, H = def.height, r = def.wheelRadius || 0.35;
    var a = P(x - L / 2, y + r * 0.6), b = P(x + L / 2, y + H), w = b[0] - a[0], h = a[1] - b[1];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.6;
    var rr = Math.min(8, h * 0.28);
    ctx.beginPath();
    ctx.moveTo(a[0] + rr, b[1]); ctx.arcTo(b[0], b[1], b[0], a[1], rr); ctx.arcTo(b[0], a[1], a[0], a[1], rr * 0.4); ctx.arcTo(a[0], a[1], a[0], b[1], rr * 0.4); ctx.arcTo(a[0], b[1], b[0], b[1], rr);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';                     // windows / cargo stripe
    if (key === 'car' || key === 'oldcar' || key === 'bus' || key === 'train' || key === 'loco') ctx.fillRect(a[0] + w * 0.12, b[1] + h * 0.16, w * 0.76, h * 0.26);
    ctx.fillStyle = '#20252b';
    var axles = def.axles && def.axles.length ? def.axles : [-L * 0.3, L * 0.3];
    for (var i = 0; i < axles.length; i++) { var c = P(x + axles[i], y + r); ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(3, r * z), 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.restore();
  }
  /**
   * opts: { lines: dashed route line with arrows, preview: silhouettes at the start (build mode), sim: running simulation (ticks reached flags) }
   */
  function drawRoutes(ctx, P, z, level, opts) {
    if (!level || !BB.routesOf) return;
    opts = opts || {};
    var routes = BB.routesOf(level), multi = routes.length > 1, sim = opts.sim || null, entries = level.vehicles || [];
    if (opts.hide) return;
    ctx.save();
    routes.forEach(function (rt, ri) {
      var col = rt.color, sts = rt.stations || [], numbered = multi || sts.length > 1 || rt.strict;
      var sy = groundAt(level, rt.startX + 2.5);
      if (opts.lines) {
        var pts = [[rt.startX + 2.5, sy + 0.6]].concat(sts.map(function (q) { return [q.x, (isNum(q.y) ? q.y : groundAt(level, q.x)) + 0.6]; }));
        for (var k = 0; k + 1 < pts.length; k++) {
          var a = P(pts[k][0], pts[k][1]), b = P(pts[k + 1][0], pts[k + 1][1]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
          ctx.setLineDash([9, 7]); ctx.lineWidth = 2.4; ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
          arrow(ctx, a, b, col, 7);
        }
      }
      // start chip
      var sp = P(rt.startX + 2.5, sy + 2.9);
      if (numbered) tag(ctx, sp[0], sp[1], 'Start', 'rgba(255,255,255,0.94)', '#17324f');
      // station badges
      sts.forEach(function (st, k) {
        var last = k === sts.length - 1, fy = isNum(st.y) ? st.y : groundAt(level, st.x);
        var done = !!(sim && sim.vehicles && sim.vehicles.some(function (v) { return v.route === ri && v.stIdx >= st.n; }));
        var pp = P(st.x, fy + 6.1);
        if (numbered) badge(ctx, pp[0], pp[1], last ? '★' : String(st.n), col, '#ffffff', done && !last);
      });
      // silhouette of the first vehicle of the route at the start (build mode)
      if (opts.preview) {
        var first = null, count = 0;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i], key = typeof e === 'string' ? e : (e && e.t), r = e && typeof e === 'object' && isNum(e.r) ? e.r : 0;
          if (r !== ri || !(BB.VEHICLES && BB.VEHICLES[key])) continue;
          count++;
          if (!first) first = { key: key, color: e && typeof e === 'object' && e.c ? e.c : null };
        }
        if (first) {
          var def = BB.VEHICLES[first.key], c = first.color || (multi ? col : (def.color || col));
          silhouette(ctx, P, z, first.key, rt.startX - def.length / 2, groundAt(level, rt.startX - 2), c, 0.9);
          if (count > 1) { var tp = P(rt.startX - def.length / 2, groundAt(level, rt.startX - 2) + def.height + 0.9); tag(ctx, tp[0], tp[1], '× ' + count, 'rgba(255,255,255,0.94)', '#17324f'); }
        }
      }
    });
    ctx.restore();
  }

  BB.Overlay = { draw: draw, drawRoutes: drawRoutes };
})(globalThis.BB = globalThis.BB || {});
