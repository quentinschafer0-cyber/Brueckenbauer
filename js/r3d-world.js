/*
 * Brückenbauer – r3d-world.js
 * ----------------------------------------------------------------------------
 * Static scenery of the 3D scene view, built once per level: terrain block with clean strata, soft
 * rolling background hills in three depth layers with haze, calm water, a few trees / rocks, clouds, sky
 * texture, anchors, pylons, flags, signs, checkpoints, zones and solid obstacles.
 * Design rule: few colours (see THEMES in r3d-util.js), smooth edges, little random noise, little decoration.
 */
(function (BB) {
  'use strict';

  var R3 = BB.R3 = BB.R3 || {};
  var U = R3.u, M = R3.m, Parts = U.Parts, hex = U.hex, shade = U.shade, mix = U.mix, clamp = U.clamp;

  var FRONT_Z = 1.35;       // front plane of the bridge members = picking plane
  var TERR_FRONT = 1.75;    // front face of the terrain block (levels without passage gates)
  var TERR_FRONT_GATE = 9.5; // … and with gates: the channel runs through the picture, so the block is deeper
  function terrFront(level) { return (BB.Gates && level && BB.Gates.of(level).length) ? TERR_FRONT_GATE : TERR_FRONT; }
  var TERR_BACK = -60;
  var ZR_TAIL = [0.0, -5, -14, -30, -60];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function surfaceAt(g, x) {
    if (BB.Terrain && BB.Terrain.surfaceY) { var s = BB.Terrain.surfaceY(g, x); if (isFinite(s)) return s; }
    return g.length ? g[0][1] : 0;
  }

  /** Gentle swell of the land behind the road lane (smooth sums of sines, no random noise). */
  function hillOff(x, z, seed, amp) {
    if (z >= -4) return 0;
    var t = clamp((-4 - z) / 52, 0, 1);
    var w = 0.5 + 0.28 * Math.sin(x * 0.021 + seed * 0.7 + z * 0.043) + 0.22 * Math.sin(x * 0.0073 - z * 0.031 + seed);
    return amp * t * t * w;
  }

  // ---------------------------------------------------------------------------------------------
  // terrain: clean layers (grass lip, light soil, soil, deep soil)
  // ---------------------------------------------------------------------------------------------
  function buildTerrain(level, T, seed, Q) {
    var g = level.ground, P = new Parts(), n = g.length, i, r;
    var TF = terrFront(level), ZR = [TF].concat(ZR_TAIL);
    var t = T.t, gx0 = g[0][0], minY = Math.min.apply(null, g.map(function (p) { return p[1]; })), bottom = minY - 80;
    var amp = T.id === 'sky' ? 2.5 : (T.id === 'desert' || T.id === 'volcano') ? 7 : 5;
    var fog = t.fog, grass = t.grass, soil = t.soil, cliff = t.cliff;
    var bands = [0, 0.45, 3.2, 9, 20, 80];
    var bandCol = [grass[2], soil[0], soil[1], soil[2], shade(soil[2], 0.82)];
    for (i = 0; i + 1 < n; i++) {
      var ax = g[i][0], ay = g[i][1], bx = g[i + 1][0], by = g[i + 1][1], dx = bx - ax, dy = by - ay;
      var slope = Math.abs(dy) / Math.max(1e-6, Math.abs(dx)), steep = slope > 0.9;
      for (r = 0; r + 1 < ZR.length; r++) {
        var z0 = ZR[r], z1 = ZR[r + 1];
        var A0 = [ax, ay + hillOff(ax, z0, seed, amp), z0], B0 = [bx, by + hillOff(bx, z0, seed, amp), z0];
        var A1 = [ax, ay + hillOff(ax, z1, seed, amp), z1], B1 = [bx, by + hillOff(bx, z1, seed, amp), z1];
        var base = steep ? (slope > 3 ? cliff[1] : cliff[0]) : (slope > 0.35 ? grass[1] : grass[0]);
        var c = U.mix(base, fog, clamp(r / (ZR.length - 1) * 0.5, 0, 0.5));
        if (steep && Math.abs(dy) > 2.4) {
          // v3.4: rock walls with strata – horizontal layers of alternating tint (the gorge reads as a gorge, not as a grey slab)
          var nS = Math.max(2, Math.round(Math.abs(dy) / 1.7));
          for (var sI = 0; sI < nS; sI++) {
            var t0 = sI / nS, t1 = (sI + 1) / nS;
            var yA0 = ay + dy * t0, yA1 = ay + dy * t1, xA0 = ax + dx * t0, xA1 = ax + dx * t1;
            var layer = (Math.floor((Math.min(yA0, yA1) + 400) / 1.7) + i) % 5;
            var tint = layer === 0 ? U.mix(c, soil[1], 0.38) : layer === 2 ? shade(c, 0.88) : layer === 3 ? U.mix(c, soil[0], 0.22) : c;
            var q0 = [xA0, yA0 + hillOff(xA0, z0, seed, amp), z0], q1 = [xA1, yA1 + hillOff(xA1, z0, seed, amp), z0];
            var q2 = [xA1, yA1 + hillOff(xA1, z1, seed, amp), z1], q3 = [xA0, yA0 + hillOff(xA0, z1, seed, amp), z1];
            P._quad(q0, q1, q2, q3, dx < 0.0001 ? shade(tint, 0.92) : tint);
          }
        } else if (dx < 0.0001) P._quad(A0, B0, B1, A1, shade(c, 0.92));
        else { P._tri(A0, B0, B1, c); P._tri(A0, B1, A1, c); }
      }
      if (dx > 0.0001) {
        for (var b = 0; b + 1 < bands.length; b++) {
          var f = TF, col = bandCol[b];
          P._quad([ax, ay - bands[b], f], [bx, by - bands[b], f], [bx, by - bands[b + 1], f], [ax, ay - bands[b + 1], f], hex(col));
        }
        P._quad([ax, ay - bands[bands.length - 1], TF], [bx, by - bands[bands.length - 1], TF], [bx, bottom, TF], [ax, bottom, TF], shade(soil[2], 0.7));
        P._quad([bx, by + hillOff(bx, TERR_BACK, seed, amp), TERR_BACK], [ax, ay + hillOff(ax, TERR_BACK, seed, amp), TERR_BACK], [ax, bottom, TERR_BACK], [bx, bottom, TERR_BACK], U.mix(fog, '#000000', 0.06));
      }
    }
    P._quad([gx0, bottom, TF], [g[n - 1][0], bottom, TF], [g[n - 1][0], bottom, TERR_BACK], [gx0, bottom, TERR_BACK], shade(soil[2], 0.5));
    var mesh = new THREE.Mesh(P.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.receiveShadow = true; mesh.castShadow = !!Q.terrainShadow;
    return { mesh: mesh, hill: function (x, z) { return hillOff(x, z, seed, amp); }, amp: amp };
  }

  // ---------------------------------------------------------------------------------------------
  // decor: a few trees / rocks, placed on a loose grid behind the road
  // ---------------------------------------------------------------------------------------------
  /**
   * Zones where the ground is a gap / valley / river bed: x ranges where the surface lies at least 2.5 m below the rim of the
   * surroundings (±24 m) or below the water. No tree, rock or bush may stand in them (v3.4) – they would stand in the water or on
   * the bed of the gap. Returned as [{ x0, x1 }] with a small margin.
   */
  function gapZones(level) {
    var g = level.ground, out = [];
    if (!g || g.length < 2) return out;
    var xa = g[0][0], xb = g[g.length - 1][0], step = 1, n = Math.floor((xb - xa) / step) + 1, ys = [], k, j;
    for (k = 0; k < n; k++) ys.push(surfaceAt(g, xa + k * step));
    var cur = null;
    for (k = 0; k < n; k++) {
      var rim = -Infinity;
      for (j = Math.max(0, k - 24); j <= Math.min(n - 1, k + 24); j++) if (ys[j] > rim) rim = ys[j];
      var below = rim - ys[k] >= 2.5 || (isNum(level.water) && ys[k] < level.water + 0.3);
      var x = xa + k * step;
      if (below) { if (!cur) cur = { x0: x, x1: x }; else cur.x1 = x; }
      else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out.map(function (z) { return { x0: z.x0 - 1.5, x1: z.x1 + 1.5 }; });
  }
  function inZones(zs, x, pad) { for (var i = 0; i < zs.length; i++) if (x >= zs[i].x0 - pad && x <= zs[i].x1 + pad) return true; return false; }

  /**
   * The decor of a level as a plan (pure data, also used by tools/check_water.js): [{ x, z, kind: 'tree' | 'rock' | 'bush', s, sd, rim }].
   * 1) a loose row of trees / rocks on level ground behind the road, never in a gap zone or under water, never at start / stations;
   * 2) vegetation on the rim of every gap (trees, bushes, rocks 3–14 m from the edge) so that a gorge reads as a gorge.
   */
  function decorPlan(level, T, seed, Q) {
    var g = level.ground, r = U.mulberry32(seed * 7 + 1), n = g.length, t = T.t, types = t.trees, plan = [];
    var zones = gapZones(level), routes = BB.routesOf ? BB.routesOf(level) : [{ startX: level.startX, flagX: level.flagX, stations: [] }];
    var keep = [];
    routes.forEach(function (rt) { keep.push(rt.startX + 2.5); (rt.stations || [{ x: rt.flagX }]).forEach(function (st) { keep.push(st.x); }); });
    keep.push(level.startX || 0, level.flagX || 0);
    function nearKeep(x, d) { for (var i = 0; i < keep.length; i++) if (Math.abs(x - keep[i]) < d) return true; return false; }
    function flat(x, tol) { var sy = surfaceAt(g, x); return Math.abs(surfaceAt(g, x - 2) - sy) <= tol && Math.abs(surfaceAt(g, x + 2) - sy) <= tol; }
    var spacing = 15 / Math.max(0.3, Q.decor), count = 0, maxCount = Math.round(70 * Q.decor);
    var x0 = g[0][0] + 6, x1 = g[n - 1][0] - 6;
    for (var x = x0; x < x1 && count < maxCount; x += spacing * (0.7 + r() * 0.7)) {
      var sy = surfaceAt(g, x);
      if (!flat(x, 0.9)) continue;                                                       // only on level ground
      if (nearKeep(x, 4)) continue;
      if (inZones(zones, x, 1) || (isNum(level.water) && sy < level.water + 0.6)) continue;   // never in a gap, never in the water
      var row = r(), z = row < 0.25 ? -(4 + r() * 1.2) : -(8 + r() * 26);
      var s = z > -6 ? 0.7 + r() * 0.2 : 1 + r() * 0.8, sd = Math.floor(r() * 1e6);
      plan.push({ x: x, z: z, kind: (r() < 0.2 || types === 'none') ? 'rock' : 'tree', s: s, sd: sd, rim: false });
      count++;
    }
    // vegetation on the rims of the gaps
    var rr = U.mulberry32(seed * 13 + 5);
    zones.forEach(function (zn) {
      [[zn.x0, -1], [zn.x1, 1]].forEach(function (e) {
        var placed = 0;
        for (var a = 0; a < 14 && placed < 4; a++) {
          var d = 3 + rr() * 11, x = e[0] + e[1] * d;
          if (!flat(x, 1.2) || nearKeep(x, 3) || inZones(zones, x, 0.5) || x < g[0][0] + 2 || x > g[n - 1][0] - 2) continue;
          var kind = placed % 3 === 2 ? 'rock' : (placed % 3 === 1 ? 'bush' : 'tree');
          if (types === 'none' && kind !== 'rock') kind = 'rock';
          plan.push({ x: x, z: -(3.8 + rr() * 3.5), kind: kind, s: kind === 'bush' ? 0.42 + rr() * 0.18 : 0.75 + rr() * 0.35, sd: Math.floor(rr() * 1e6), rim: true });
          placed++;
        }
      });
    });
    return plan;
  }
  /** convenience for the tests: the plan of a level with the theme / seed / quality the scene uses */
  function planFor(level, qualityName) {
    var T = U.themeFor(level), seed = (U.strHash(level.id || 'x') % 9973) + 3, Q = (BB.R3 && BB.R3.QUALITY && BB.R3.QUALITY[qualityName || 'mid']) || { decor: 0.7 };
    return decorPlan(level, T, seed, Q);
  }

  function buildDecor(level, T, seed, Q, terr) {
    var g = level.ground, P = new Parts(), t = T.t, types = t.trees;
    var plan = decorPlan(level, T, seed, Q);
    plan.forEach(function (d) {
      var sy = surfaceAt(g, d.x), y = sy + terr.hill(d.x, d.z);
      if (d.kind === 'rock') P.merge(M.rockParts(d.sd, t.rock, 0.7 + d.s * 0.5), d.x, y, d.z);
      else P.merge(M.treeParts(types, d.sd, t.treeCols, t.trunk, d.s), d.x, y, d.z);
    });
    if (!P.pos.length) return null;
    var mesh = new THREE.Mesh(P.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.castShadow = !!Q.decorShadow; mesh.receiveShadow = false;
    return mesh;
  }

  // ---------------------------------------------------------------------------------------------
  // hills: soft, large, flat-coloured silhouettes in three depth layers, hazier the farther away
  // ---------------------------------------------------------------------------------------------
  function buildHills(level, T, seed, Q) {
    var g = level.ground, x0 = g[0][0] - 260, x1 = g[g.length - 1][0] + 260;
    var ys = g.map(function (p) { return p[1]; }).sort(function (a, b) { return b - a; });
    var yRef = ys.length ? ys[Math.floor(ys.length * 0.25)] : 0, t = T.t;
    var pos = [], col = [], idx = [], vi = 0;
    var layers = Q.hillLayers >= 2 ? 3 : 2;
    for (var k = layers - 1; k >= 0; k--) {
      var zf = -80 - k * 70, step = 10, c0 = hex(t.hills[Math.min(k, 2)]), cTop = shade(c0, 1.07);
      var cols = Math.round((x1 - x0) / step), base = yRef - 90;
      for (var i = 0; i <= cols; i++) {
        var x = x0 + i * step;
        var h = yRef + 4 + k * 5 + (14 + k * 4) * (0.5 + 0.5 * Math.sin(x * 0.011 + seed + k * 2.1)) + 6 * (0.5 + 0.5 * Math.sin(x * 0.027 + seed * 1.7 + k));
        if (T.id === 'sky') h -= 12;
        // smooth normals pointing up/forward are faked through the colour: lighter towards the crest
        pos.push(x, base, zf, x, h, zf);
        col.push(c0[0], c0[1], c0[2], cTop[0], cTop[1], cTop[2]);
        if (i > 0) { var a = vi - 2, b = vi - 1, c = vi, d = vi + 1; idx.push(a, c, b, b, c, d); }
        vi += 2;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true }));
    var grp = new THREE.Group(); grp.add(mesh);
    if (t.lava) {
      var vx = (level.startX + level.flagX) / 2 + 60, vz = -170, vh = 62, cone = new Parts();
      cone.cone(vx, yRef - 60, vz, 70, vh + 54, shade(t.hills[0], 0.78), { n: 20, rot: 0.3 });
      cone.cone(vx, yRef + vh - 14, vz, 16, 10, '#f09a3a', { n: 20, rot: 0.3 });
      grp.add(new THREE.Mesh(cone.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, fog: true })));
    }
    return grp;
  }

  // ---------------------------------------------------------------------------------------------
  // sky
  // ---------------------------------------------------------------------------------------------
  function skyTexture(T) {
    var c = document.createElement('canvas');
    c.width = 8; c.height = 512;
    var x = c.getContext('2d'), t = T.t;
    var gr = x.createLinearGradient(0, 0, 0, 512);
    gr.addColorStop(0, t.skyTop); gr.addColorStop(1, t.skyBottom);
    x.fillStyle = gr; x.fillRect(0, 0, 8, 512);
    if (t.stars) {
      var r = U.mulberry32(5), c2 = document.createElement('canvas'); c2.width = 256; c2.height = 512;
      var y = c2.getContext('2d'); y.drawImage(c, 0, 0, 256, 512);
      for (var i = 0; i < 60; i++) { y.globalAlpha = 0.35 + r() * 0.5; y.fillStyle = '#fff'; y.fillRect(r() * 256, r() * 280, 1.5, 1.5); }
      y.globalAlpha = 1; y.fillStyle = '#f4efd8'; y.beginPath(); y.arc(205, 74, 14, 0, 6.3); y.fill();
      y.fillStyle = t.skyTop; y.beginPath(); y.arc(211, 69, 12, 0, 6.3); y.fill();
      return new THREE.CanvasTexture(c2);
    }
    return new THREE.CanvasTexture(c);
  }

  function buildClouds(level, T, seed, Q) {
    var g = level.ground, x0 = g[0][0] - 60, x1 = g[g.length - 1][0] + 60, r = U.mulberry32(seed + 77), out = [];
    var top = Math.max.apply(null, g.map(function (p) { return p[1]; }));
    var n = Math.min(Q.clouds || 6, 6);
    for (var i = 0; i < n; i++) {
      var geo = M.cloudParts(seed + i * 17, T.t.cloud).geometry();
      var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, transparent: true, opacity: T.t.night ? 0.5 : 0.92 }));
      var sc = 1.4 + r() * 1.4;
      mesh.scale.set(sc, sc, sc);
      mesh.position.set(x0 + r() * (x1 - x0), top + 30 + r() * 26, -90 - r() * 90);
      mesh.userData = { speed: 0.35 + r() * 0.7, x0: x0, x1: x1 };
      out.push(mesh);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // water: one calm surface with a gentle swell and smooth shading (no triangle pattern)
  // ---------------------------------------------------------------------------------------------
  function buildWater(level, T, Q) {
    if (!isNum(level.water)) return null;
    var g = level.ground, x0 = g[0][0], x1 = g[g.length - 1][0];
    var segX = clamp(Math.round((x1 - x0) / 2.5), 12, Q.waterSeg || 90), segZ = 6;
    var z0 = terrFront(level) - 0.04, z1 = -50, lava = !!T.t.lava || (BB.Levels && BB.Levels.gapOf && BB.Levels.gapOf(level) === 'lava');
    var nv = (segX + 1) * (segZ + 1), pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
    var body = hex(T.t.water), top = hex(T.t.waterTop);
    for (var j = 0; j <= segZ; j++) for (var i = 0; i <= segX; i++) {
      var v = j * (segX + 1) + i, t = j / segZ;
      var cc = [U.lerp(body[0], top[0], 0.45 * (1 - t)), U.lerp(body[1], top[1], 0.45 * (1 - t)), U.lerp(body[2], top[2], 0.45 * (1 - t))];
      col[v * 3] = cc[0]; col[v * 3 + 1] = cc[1]; col[v * 3 + 2] = cc[2];
      if (i < segX && j < segZ) { var a = v, b = v + 1, c = v + segX + 1, d = v + segX + 2; idx.push(a, b, c, b, d, c); }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    var mat = lava
      ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.96, side: THREE.DoubleSide, depthWrite: false, fog: false })
      : new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.84, side: THREE.DoubleSide, depthWrite: false });
    var surface = new THREE.Mesh(geo, mat); surface.renderOrder = 3; surface.frustumCulled = false;
    // front glass (cut face of the water body)
    var fv = (segX + 1) * 2, fp = new Float32Array(fv * 3), fn = new Float32Array(fv * 3), fc = new Float32Array(fv * 3), fi = [];
    for (var q = 0; q <= segX; q++) {
      fn[q * 6 + 2] = 1; fn[q * 6 + 5] = 1;
      fc[q * 6] = top[0]; fc[q * 6 + 1] = top[1]; fc[q * 6 + 2] = top[2];
      var dp = hex(U.mix(T.t.water, '#0c2236', lava ? 0.1 : 0.4));
      fc[q * 6 + 3] = dp[0]; fc[q * 6 + 4] = dp[1]; fc[q * 6 + 5] = dp[2];
      if (q < segX) { fi.push(q * 2, q * 2 + 1, q * 2 + 2, q * 2 + 1, q * 2 + 3, q * 2 + 2); }
    }
    var fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(fp, 3).setUsage(THREE.DynamicDrawUsage));
    fgeo.setAttribute('normal', new THREE.BufferAttribute(fn, 3));
    fgeo.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    fgeo.setIndex(fi);
    var fmat = lava
      ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, fog: false })
      : new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.66, side: THREE.DoubleSide, depthWrite: false });
    var front = new THREE.Mesh(fgeo, fmat); front.renderOrder = 2; front.frustumCulled = false;
    var amp = lava ? 0.12 : 0.15;
    function wave(px, pz, time) { return (Math.sin(px * 0.28 + time * 1.1) * 0.6 + Math.sin(px * 0.11 - time * 0.7 + pz * 0.5) * 0.4) * amp; }
    function slopeX(px, pz, time) { return (Math.cos(px * 0.28 + time * 1.1) * 0.28 * 0.6 + Math.cos(px * 0.11 - time * 0.7 + pz * 0.5) * 0.11 * 0.4) * amp; }
    var w = {
      surface: surface, front: front, y: level.water, lava: lava,
      update: function (time, y) {
        for (var j2 = 0; j2 <= segZ; j2++) {
          var tz = j2 / segZ, z = z0 + (z1 - z0) * Math.pow(tz, 1.4);
          for (var i2 = 0; i2 <= segX; i2++) {
            var vv = j2 * (segX + 1) + i2, x = x0 + (x1 - x0) * i2 / segX;
            pos[vv * 3] = x; pos[vv * 3 + 1] = y + wave(x, z, time); pos[vv * 3 + 2] = z;
            var sx = slopeX(x, z, time), nl = Math.hypot(sx, 1);
            nor[vv * 3] = -sx / nl; nor[vv * 3 + 1] = 1 / nl; nor[vv * 3 + 2] = 0;
          }
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
        for (var q2 = 0; q2 <= segX; q2++) {
          var x2 = x0 + (x1 - x0) * q2 / segX;
          fp[q2 * 6] = x2; fp[q2 * 6 + 1] = y + wave(x2, z0, time) * 0.7; fp[q2 * 6 + 2] = z0;
          fp[q2 * 6 + 3] = x2; fp[q2 * 6 + 4] = y - 80; fp[q2 * 6 + 5] = z0;
        }
        fgeo.attributes.position.needsUpdate = true;
      },
    };
    w.update(0, level.water);
    return w;
  }

  // ---------------------------------------------------------------------------------------------
  // props: anchors, pylons, signs, flags, checkpoints, zones, obstacles, piston bases
  // ---------------------------------------------------------------------------------------------
  function tower(level) {
    var out = [], g = level.ground, an = level.anchors || [];
    for (var i = 0; i < an.length; i++) {
      var a = an[i], sy = surfaceAt(g, a[0]);
      if (!(a[1] - sy > 1.5)) continue;
      var bottom = Math.min(sy, surfaceAt(g, a[0] - 0.75), surfaceAt(g, a[0] + 0.75)) - 0.8;
      bottom = Math.max(bottom, a[1] - 90);
      out.push({ x: a[0], y: a[1], bottom: bottom });
    }
    return out;
  }

  /** the towers that hold stays / cables look like the epoch: tree, column, stone tower, riveted lattice */
  function towerStyle(level) {
    var e = level && level.world && BB.TIME && BB.TIME.get ? BB.TIME.get(level.world) : null;
    return e ? ({ stone: 'tree', antique: 'antique', medieval: 'medieval', industry: 'industry' }[e.theme] || null) : null;
  }
  /** flag style of the level's epoch (Zeitreise) */
  function flagStyle(level) {
    var e = level && level.world && BB.TIME && BB.TIME.get ? BB.TIME.get(level.world) : null;
    return e ? ({ stone: 'stone', antique: 'antique', medieval: 'medieval' }[e.theme] || null) : null;
  }

  function buildProps(level, T, seed, Q) {
    var grp = new THREE.Group(), anim = { flags: [], flagObjs: [], lamps: [], cps: [], holdLamps: [] };
    var g = level.ground, i;
    var lambert = function () { return new THREE.MeshLambertMaterial({ vertexColors: true }); };
    var an = level.anchors || [];
    if (an.length) {
      var plates = new THREE.InstancedMesh(M.plateGeometry(0.95), lambert(), an.length), m4 = new THREE.Matrix4();
      for (i = 0; i < an.length; i++) { m4.makeTranslation(an[i][0], an[i][1], 0); plates.setMatrixAt(i, m4); }
      plates.castShadow = true; plates.receiveShadow = true;
      grp.add(plates);
    }
    tower(level).forEach(function (t) {
      var h = t.y - t.bottom - 0.5;
      var m = new THREE.Mesh(M.pylonGeometry(h, 1.0, 1.4, towerStyle(level)), lambert());
      m.position.set(t.x, t.bottom, 0); m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
    });
    var routes = (BB.routesOf ? BB.routesOf(level) : [{ startX: level.startX, flagX: level.flagX, color: '#e8453c' }]);
    var multi = routes.length > 1;
    // v3.4: every route has a start sign and its stations (flags) – at the real height of the flag base (ground or bridge deck),
    // in the style of the epoch; the goal flag is chequered (in the route colour above it when there are several routes / stations)
    var fstyle = flagStyle(level);
    var colMat = function () { return new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); };
    routes.forEach(function (rt, ri) {
      var sy = surfaceAt(g, rt.startX + 2.5);
      var sign = new THREE.Mesh(M.signGeometry(multi || rt.strict ? rt.color : null), lambert());
      sign.position.set(rt.startX + 2.5, sy, -2.6); sign.castShadow = true;
      grp.add(sign);
      var sts = rt.stations && rt.stations.length ? rt.stations : [{ x: rt.flagX, y: surfaceAt(g, rt.flagX), n: 1 }];
      sts.forEach(function (st, k) {
        var last = k === sts.length - 1, fy = isFinite(st.y) ? st.y : surfaceAt(g, st.x);
        var pole = new THREE.Mesh(M.flagPole(fstyle).geometry(), lambert());
        pole.position.set(st.x, fy, -2.3); pole.castShadow = true; grp.add(pole); anim.flagObjs.push(pole);
        var mode = last ? ((multi || rt.strict) ? 'goal' : 'check') : 'plain';
        var cloth = new THREE.Mesh(M.flagCloth(rt.color, mode, fstyle).geometry(), colMat());
        cloth.position.set(st.x, fy, -2.3); cloth.castShadow = true; grp.add(cloth);
        anim.flags.push(cloth); anim.flagObjs.push(cloth);
      });
    });
    (level.checkpoints || []).forEach(function (cp) {
      if (cp.hidden) { var dummy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial({ color: 0 })); dummy.visible = false; grp.add(dummy); anim.lamps.push(dummy); return; }
      var cy = surfaceAt(g, cp.x);
      var gm = new THREE.Mesh(M.checkpointGeometry(), lambert());
      gm.position.set(cp.x, cy, 0); gm.castShadow = true; grp.add(gm);
      var lamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), new THREE.MeshBasicMaterial({ color: 0xd9544a }));
      lamp.position.set(cp.x - 0.1, cy + 4.05, 0); grp.add(lamp);
      anim.lamps.push(lamp);
    });
    // stop lines (traffic light while a bridge is open / a lift moves): pole with a lamp, red or green
    anim.holdLamps = [];
    var holdXs = [];
    (BB.Gates ? BB.Gates.of(level) : []).forEach(function (gt) { if (gt.hold) holdXs.push(gt.stopX); });
    (level.signals || []).forEach(function (h) { if (h && isNum(h.x)) holdXs.push(h.x); });
    holdXs.forEach(function (hx) {
      var hy = surfaceAt(g, hx);
      var pg = new Parts(); pg.box(0, 1.7, 0, 0.14, 3.4, 0.14, '#4b535c'); pg.box(0, 3.45, 0, 0.6, 0.9, 0.34, '#2b3036'); pg.box(0, 0.08, 0, 0.7, 0.16, 0.7, '#8d96a0');
      var pm = new THREE.Mesh(pg.geometry(), lambert()); pm.position.set(hx, hy, -2.2); pm.castShadow = true; grp.add(pm);
      var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.12), new THREE.MeshBasicMaterial({ color: 0xe8453c }));
      lamp.position.set(hx, hy + 3.45, -2.2 + 0.2); grp.add(lamp);
      anim.holdLamps.push(lamp);
    });
    // build zones: only a calm tinted frame, no grid
    (level.zones || []).forEach(function (z) {
      var w = z.x1 - z.x0, h = z.y1 - z.y0;
      var box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 3.8), new THREE.MeshBasicMaterial({ color: 0x4f9bd8, transparent: true, opacity: 0.08, depthWrite: false }));
      box.position.set((z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2, 0); box.renderOrder = 5; box.userData.zone = true;
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, 3.8)), new THREE.LineBasicMaterial({ color: 0xcfe6f6, transparent: true, opacity: 0.7 }));
      edges.position.copy(box.position); edges.userData.zone = true;
      grp.add(box); grp.add(edges);
    });
    ((level.prebuilt && level.prebuilt.beams) || []).forEach(function (b) {
      if (!b.o) return;
      var len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
      var m = new THREE.Mesh(M.hazardBarGeometry(len), lambert());
      m.position.set((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, 0); m.rotation.z = Math.atan2(b.y2 - b.y1, b.x2 - b.x1); m.castShadow = true;
      grp.add(m);
    });
    (level.pistons || []).forEach(function (p) {
      var pg = new Parts(); pg.box(0, 0, 0, 1.2, 1.2, 3.0, '#6b727b');
      var m = new THREE.Mesh(pg.geometry(), lambert()); m.position.set(p.pivotX, p.pivotY, 0); grp.add(m);
    });
    return { group: grp, anim: anim };
  }

  // ---------------------------------------------------------------------------------------------
  // what lies under the bridge: motorway (lanes, rails, traffic), railway (ballast, rails, sleepers), ravine mist
  // ---------------------------------------------------------------------------------------------
  function floorSpan(level) {
    var g = level.ground, b = level.build || { minX: -10, maxX: 10 }, lo = b.minX - 6, hi = b.maxX + 6, minY = Infinity, i;
    for (i = 0; i < g.length; i++) if (g[i][0] >= lo && g[i][0] <= hi && g[i][1] < minY) minY = g[i][1];
    var x0 = Infinity, x1 = -Infinity;
    for (i = 0; i < g.length; i++) if (g[i][0] >= lo - 12 && g[i][0] <= hi + 12 && g[i][1] <= minY + 0.9) { if (g[i][0] < x0) x0 = g[i][0]; if (g[i][0] > x1) x1 = g[i][0]; }
    if (!(x1 > x0)) { x0 = lo; x1 = hi; }
    return { y: minY, x0: x0 + 0.35, x1: x1 - 0.35 };
  }
  var CAR_COLS = ['#c2573f', '#3f6b9a', '#d4a64a', '#6a9a5b', '#8a8f98', '#b36a8a'];
  function vehicleGroup(type, color) {
    var def = (BB.VEHICLES && BB.VEHICLES[type]) || {}, group = new THREE.Group();
    var body = new THREE.Mesh(M.vehicleBody(type, color), new THREE.MeshLambertMaterial({ vertexColors: true }));
    body.castShadow = true; group.add(body);
    var ax = def.axles || [-1.3, 1.3], info = M.vehicleWheel(type, def.wheelRadius || 0.4);
    for (var k = 0; k < ax.length; k++) { var w = new THREE.Mesh(info.geom, new THREE.MeshLambertMaterial({ vertexColors: true })); w.position.set(ax[k], 0, 0); group.add(w); }
    group.userData.lift = def.wheelRadius || 0.4; group.userData.len = def.length || 4;
    return group;
  }
  function buildGap(level, T, Q) {
    var gap = BB.Levels && BB.Levels.gapOf ? BB.Levels.gapOf(level) : 'canyon';
    var out = { group: new THREE.Group(), ambient: [], gap: gap };
    if (gap !== 'road' && gap !== 'rail' && gap !== 'ravine') return out;
    var sp = floorSpan(level), W = sp.x1 - sp.x0, front = terrFront(level), zBack = -58, P = new Parts(), y = sp.y + 0.04, cx = (sp.x0 + sp.x1) / 2;
    if (gap === 'ravine') {
      var haze = hex(T.t.fog);
      for (var hz = 0; hz < 3; hz++) {
        var pl = new THREE.Mesh(new THREE.PlaneGeometry(W + 4, 62), new THREE.MeshBasicMaterial({ color: new THREE.Color(haze[0], haze[1], haze[2]), transparent: true, opacity: 0.16 - hz * 0.03, depthWrite: false, side: THREE.DoubleSide, fog: false }));
        pl.rotation.x = -Math.PI / 2; pl.position.set(cx, sp.y + 3.5 + hz * 5.5, (front + zBack) / 2); pl.renderOrder = 4;
        out.group.add(pl);
      }
      return out;
    }
    var gates = BB.Gates ? BB.Gates.of(level) : [];
    var trainXs = [];      // centres of the train gates: a train drives along its own track
    gates.forEach(function (gt) { if (gt.kind === 'train') { var gx = (gt.x0 + gt.x1) / 2; if (!trainXs.some(function (q) { return Math.abs(q - gx) < 1; })) trainXs.push(gx); } });
    trainXs.sort(function (a, b) { return a - b; });
    var mixed = gap === 'road' && trainXs.length > 0;                 // motorway AND railway side by side (VK-09)
    var roadX0 = sp.x0, roadX1 = mixed ? Math.max(sp.x0 + 3, Math.min.apply(null, gates.filter(function (g) { return g.kind === 'train'; }).map(function (g) { return g.x0; })) - 0.6) : sp.x1;
    var railX0 = mixed ? roadX1 : sp.x0, railX1 = sp.x1;
    function roadSection() {
      var RW = roadX1 - roadX0, lanes = Math.max(2, Math.min(6, Math.round(RW / 3.4))), lw = RW / lanes, i, cxr = (roadX0 + roadX1) / 2;
      P._quad([roadX0, y, front], [roadX1, y, front], [roadX1, y, zBack], [roadX0, y, zBack], hex('#4a4f58'));
      P._quad([roadX0, y + 0.01, front], [roadX0 + 0.18, y + 0.01, front], [roadX0 + 0.18, y + 0.01, zBack], [roadX0, y + 0.01, zBack], hex('#e9e6dc'));
      P._quad([roadX1 - 0.18, y + 0.01, front], [roadX1, y + 0.01, front], [roadX1, y + 0.01, zBack], [roadX1 - 0.18, y + 0.01, zBack], hex('#e9e6dc'));
      for (i = 1; i < lanes; i++) {
        var lx = roadX0 + i * lw, mid = i === lanes / 2;
        for (var z = front; z > zBack; z -= (mid ? 6 : 4.2)) {
          var zl = z - (mid ? 5.4 : 2.2);
          P._quad([lx - 0.07, y + 0.012, z], [lx + 0.07, y + 0.012, z], [lx + 0.07, y + 0.012, Math.max(zl, zBack)], [lx - 0.07, y + 0.012, Math.max(zl, zBack)], hex(mid ? '#f1c34e' : '#e9e6dc'));
        }
      }
      // guard rails along both edges
      [roadX0 + 0.5, roadX1 - 0.5].forEach(function (rx) {
        P.box(rx, 0.55 + sp.y, (front + zBack) / 2, 0.1, 0.18, front - zBack, '#aeb6bf');
        for (var zp = front - 1; zp > zBack; zp -= 3.2) P.box(rx, 0.28 + sp.y, zp, 0.1, 0.56, 0.1, '#7d858e');
      });
      // a gantry sign over the lanes (far away) – tells the player this is a motorway
      var sgn = new Parts();
      sgn.box(roadX0 + 0.4, 3.2 + sp.y, -22, 0.25, 6.4, 0.25, '#7d858e'); sgn.box(roadX1 - 0.4, 3.2 + sp.y, -22, 0.25, 6.4, 0.25, '#7d858e');
      sgn.box(cxr, 6.2 + sp.y, -22, RW - 0.4, 0.3, 0.3, '#7d858e'); sgn.box(cxr, 5.2 + sp.y, -22.1, Math.min(RW * 0.55, 8), 1.5, 0.12, '#2f6a4e'); sgn.box(cxr, 5.2 + sp.y, -22.04, Math.min(RW * 0.55, 8) - 0.3, 1.2, 0.04, '#e9efe8');
      var sm = new THREE.Mesh(sgn.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true })); out.group.add(sm);
      // ambient traffic: cars (and the odd lorry) driving along the motorway, through the picture
      var gateLane = null;
      gates.forEach(function (gt) { if (gt.kind === 'truck') gateLane = (gt.x0 + gt.x1) / 2; });
      var r = U.mulberry32(77), nCars = Math.min(10, lanes * 3), k;
      for (k = 0; k < nCars; k++) {
        var lane = k % lanes, lxc = roadX0 + (lane + 0.5) * lw, dir = lane < lanes / 2 ? -1 : 1;
        if (gateLane !== null && Math.abs(lxc - gateLane) < lw * 0.6) continue;
        var type = r() < 0.2 ? 'truck' : 'car', grp = vehicleGroup(type, type === 'truck' ? '#8a8f98' : CAR_COLS[k % CAR_COLS.length]);
        grp.rotation.y = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
        var holder = new THREE.Group(); holder.add(grp); out.group.add(holder);
        out.ambient.push({ holder: holder, x: lxc, y: y + grp.userData.lift, v: (type === 'truck' ? 9 : 13 + r() * 5) * dir, phase: r() * 90, len: grp.userData.len });
      }
    }
    function railSection() {
      // the tracks lie exactly where the train gates are; otherwise evenly in the middle
      var RW = railX1 - railX0, rcx = (railX0 + railX1) / 2;
      var tracks = trainXs.length || (RW >= 9 ? 2 : 1), trackX = trainXs.length ? trainXs : null;
      var bx0 = trackX ? Math.max(railX0 + 0.3, trackX[0] - 2.6) : rcx - Math.min(RW - 0.6, tracks * 3.6 + 1.6) / 2, bx1 = trackX ? Math.min(railX1 - 0.3, trackX[trackX.length - 1] + 2.6) : rcx + Math.min(RW - 0.6, tracks * 3.6 + 1.6) / 2;
      P._quad([bx0, y, front], [bx1, y, front], [bx1, y, zBack], [bx0, y, zBack], hex('#7b756c'));
      for (var t = 0; t < tracks; t++) {
        var tx = trackX ? trackX[t] : rcx + (t - (tracks - 1) / 2) * 3.6;
        for (var zs = front - 0.3; zs > zBack; zs -= 0.85) P.box(tx, y + 0.07, zs, 3.0, 0.14, 0.3, '#5a4a3c');
        [-1.15, 1.15].forEach(function (o) { P.box(tx + o, y + 0.22, (front + zBack) / 2, 0.12, 0.16, front - zBack, '#c9ced4'); });
      }
      if (!trainXs.length) {
        var tgrp = vehicleGroup('train', null); tgrp.rotation.y = -Math.PI / 2;
        var th = new THREE.Group(); th.add(tgrp); out.group.add(th);
        out.ambient.push({ holder: th, x: rcx + (-(tracks - 1) / 2) * 3.6, y: y + 0.3 + tgrp.userData.lift, v: 14, phase: 20, len: tgrp.userData.len, period: 40 });
      }
    }
    if (gap === 'road') roadSection();
    if (gap === 'rail' || mixed) railSection();
    var ground = new THREE.Mesh(P.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    ground.receiveShadow = true; out.group.add(ground);
    out.front = front; out.zBack = zBack;
    return out;
  }
  /** Moves the ambient traffic (called every frame). */
  function updateGap(gapObj, time) {
    if (!gapObj || !gapObj.ambient.length) return;
    var front = gapObj.front, span = front - gapObj.zBack + 30;
    gapObj.ambient.forEach(function (a) {
      var per = a.period ? a.period * Math.abs(a.v) : span + 20, d = ((time * Math.abs(a.v) + a.phase * Math.abs(a.v) * 0.3) % per);
      var z = a.v > 0 ? gapObj.zBack - 12 + d : front + 6 - d;
      a.holder.position.set(a.x, a.y, z);
      a.holder.visible = (a.v > 0 ? (z - a.len / 2 < front - 0.1) : (z + a.len / 2 > gapObj.zBack + 2)) && z > gapObj.zBack - 14;
    });
  }

  R3.world = {
    FRONT_Z: FRONT_Z, TERR_FRONT: TERR_FRONT, TERR_BACK: TERR_BACK, terrFront: terrFront, surfaceAt: surfaceAt,
    buildTerrain: buildTerrain, buildDecor: buildDecor, decorPlan: decorPlan, planFor: planFor, gapZones: gapZones, buildHills: buildHills, skyTexture: skyTexture, buildClouds: buildClouds,
    buildWater: buildWater, buildProps: buildProps, tower: tower, buildGap: buildGap, updateGap: updateGap, floorSpan: floorSpan,
  };
})(globalThis.BB = globalThis.BB || {});
