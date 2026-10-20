/*
 * Brückenbauer – render3d.js
 * ----------------------------------------------------------------------------
 * 3D low-poly renderer (Three.js) with exactly the same interface as the 2D renderer in render.js:
 *
 *   const R = BB.Render3D.create(overlayCanvas, glCanvas, { quality, onLost })
 *   R.draw(scene)   scene = { mode, level, camera {x,y,zoom}, time, bridge, sim, showStress, showGrid,
 *                             preview, hoverNode, deleteHighlight, leveledit, chase, … }
 *   R.worldToScreen(cam, x, y) / R.screenToWorld(cam, sx, sy)  (picking plane = front plane of the bridge)
 *   R.fitCamera(level, insets), R.addEvents(events), R.clearEffects(), R.resize(), R.setQuality(q)
 *
 * The physics stays 2D (x → right, y → up, bridge plane z = 0); only the drawing is 3D. The overlay
 * canvas (2D) on top draws everything that must stay crisp: grid, build preview, handles, labels.
 */
(function (BB) {
  'use strict';

  var R3 = BB.R3 = BB.R3 || {};
  var U = R3.u, M = R3.m, W3 = R3.world;
  var FRONT_Z = W3 ? W3.FRONT_Z : 1.35, BEAM_Z = FRONT_Z;
  var FOV = 24, TAN_H = Math.tan(FOV * Math.PI / 360);

  var QUALITY = {
    low: { dprMax: 1, shadows: false, shadowSize: 0, decor: 0.35, decorTris: 9000, clouds: 4, waterSeg: 50, hillLayers: 1, terrainShadow: false, decorShadow: false, fx: 140 },
    mid: { dprMax: 1.5, shadows: true, shadowSize: 1024, decor: 0.7, decorTris: 20000, clouds: 6, waterSeg: 80, hillLayers: 2, terrainShadow: true, decorShadow: false, fx: 260 },
    high: { dprMax: 2, shadows: true, shadowSize: 2048, decor: 1.0, decorTris: 34000, clouds: 9, waterSeg: 110, hillLayers: 2, terrainShadow: true, decorShadow: true, fx: 420 },
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function supported() {
    try {
      if (!window.THREE || !BB.R3 || !BB.R3.world || !BB.R3.m) return false;
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  // material colours of the beams (stress tint is mixed in on top)
  var MATC = {
    road: '#4c4c56', steelroad: '#6d8398', wood: '#c58a48', steel: '#e0592e', rope: '#8a6a45', cable: '#b6bfc9', spring: '#37b24d',
    hydraulic: '#f0b429', rail: '#544b43', concrete: '#a9aeb6',
  };

  var VIEWS = {
    build: { pitch: 0.2, yaw: 0.11 }, test: { pitch: 0.2, yaw: 0.11 }, leveledit: { pitch: 0.1, yaw: 0.04 }, menu: { pitch: 0.16, yaw: -0.13 },
  };

  // ===============================================================================================
  function create(overlay, glCanvas, opts) {
    opts = opts || {};
    var quality = QUALITY[opts.quality] ? opts.quality : 'mid';
    var Q = QUALITY[quality];

    var renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: quality !== 'low', alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x87ceeb, 1);
    renderer.shadowMap.enabled = !!Q.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    var lost = false;
    glCanvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost = true; if (opts.onLost) opts.onLost(); }, false);

    var octx = overlay.getContext('2d');
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(FOV, 1, 1, 2000);
    var hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6);
    var sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.castShadow = !!Q.shadows;
    sun.shadow.mapSize.set(Q.shadowSize || 512, Q.shadowSize || 512);
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.05;
    var fill = new THREE.DirectionalLight(0xffffff, 0.2);
    fill.position.set(30, 20, 60);
    scene.add(hemi); scene.add(sun); scene.add(sun.target); scene.add(fill);

    var W = 1, H = 1, dpr = 1, resScale = 1, lastTime = null;
    var cur = { cx: 0, cy: 0, cz: 0, f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0], focal: 1, d: 1, W: 1, H: 1 };
    var viewCur = { pitch: 0.2, yaw: 0.11 };
    var chaseCam = null;

    // ----------------------------------------------------------------------------- state
    var st = {
      sig: '', level: null, theme: null, staticGroup: null, water: null, clouds: [], anim: null, weather: null, terr: null,
      sim: null, vehicles: new Map(), gates: [], pistonSig: '', skyTex: null,
    };

    // ----------------------------------------------------------------------------- instanced sets
    function mkSet(geo, cap, castShadow) {
      var mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      var mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; mesh.castShadow = !!castShadow; mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return { mesh: mesh, cap: cap, n: 0 };
    }
    var cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false); cylGeo.rotateZ(-Math.PI / 2);
    var boxSet = mkSet(new THREE.BoxGeometry(1, 1, 1), 12000, true);
    var cylSet = mkSet(cylGeo, 6000, true);
    var sphSet = mkSet(new THREE.IcosahedronGeometry(1, 0), 5000, true);
    var fxSet = mkSet(new THREE.BoxGeometry(1, 1, 1), 520, false);
    fxSet.mesh.material.transparent = false;
    var crateSet = (function () {
      var mesh = new THREE.InstancedMesh(M.crateGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), 64);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.count = 0;
      scene.add(mesh);
      return { mesh: mesh, cap: 64, n: 0 };
    })();

    function put(set, x, y, z, rz, sx, sy, sz, c) {
      if (set.n >= set.cap) return;
      var cs = Math.cos(rz), sn = Math.sin(rz), a = set.mesh.instanceMatrix.array, o = set.n * 16;
      a[o] = cs * sx; a[o + 1] = sn * sx; a[o + 2] = 0; a[o + 3] = 0;
      a[o + 4] = -sn * sy; a[o + 5] = cs * sy; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = sz; a[o + 11] = 0;
      a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
      var ca = set.mesh.instanceColor.array, co = set.n * 3;
      ca[co] = c[0]; ca[co + 1] = c[1]; ca[co + 2] = c[2];
      set.n++;
    }
    function flush(set) {
      set.mesh.count = set.n;
      set.mesh.instanceMatrix.needsUpdate = true;
      if (set.mesh.instanceColor) set.mesh.instanceColor.needsUpdate = true;
      set.n = 0;
    }

    // ----------------------------------------------------------------------------- size / camera
    function resize() {
      var w = overlay.clientWidth, h = overlay.clientHeight;
      if (!w || !h) { w = window.innerWidth || 800; h = window.innerHeight || 600; }
      W = w; H = h;
      dpr = clamp((window.devicePixelRatio || 1), 1, Q.dprMax) * resScale;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      var opw = Math.max(1, Math.round(w * Math.min(2, window.devicePixelRatio || 1))), oph = Math.max(1, Math.round(h * Math.min(2, window.devicePixelRatio || 1)));
      if (overlay.width !== opw || overlay.height !== oph) { overlay.width = opw; overlay.height = oph; }
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    var sizeKey = '';
    function checkSize() {
      var k = overlay.clientWidth + 'x' + overlay.clientHeight + '@' + (window.devicePixelRatio || 1) + '/' + resScale.toFixed(2);
      if (k !== sizeKey) { sizeKey = k; resize(); }
    }

    /** Camera placement for a plane camera {x,y,zoom} and a view {pitch, yaw}. Fills `out`. */
    function placeCamera(cam, view, out) {
      var d = (H / 2) / (cam.zoom * TAN_H);
      var cp = Math.cos(view.pitch), sp = Math.sin(view.pitch), cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
      var tx = cam.x, ty = cam.y, tz = FRONT_Z;
      var px = tx + d * sy * cp, py = ty + d * sp, pz = tz + d * cy * cp;
      var fx = tx - px, fy = ty - py, fz = tz - pz, fl = Math.hypot(fx, fy, fz);
      fx /= fl; fy /= fl; fz /= fl;
      // right = f × up(0,1,0)
      var rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0, rl = Math.hypot(rx, ry, rz);
      rx /= rl; ry /= rl; rz /= rl;
      var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      out.cx = px; out.cy = py; out.cz = pz; out.f = [fx, fy, fz]; out.r = [rx, ry, rz]; out.u = [ux, uy, uz];
      out.focal = (H / 2) / TAN_H; out.d = d; out.W = W; out.H = H; out.tx = tx; out.ty = ty; out.tz = tz;
      return out;
    }
    function project(c, x, y, z) {
      var dx = x - c.cx, dy = y - c.cy, dz = z - c.cz;
      var zc = dx * c.f[0] + dy * c.f[1] + dz * c.f[2];
      if (zc < 0.1) return null;
      var xc = dx * c.r[0] + dy * c.r[1] + dz * c.r[2], yc = dx * c.u[0] + dy * c.u[1] + dz * c.u[2];
      return [c.W / 2 + xc / zc * c.focal, c.H / 2 - yc / zc * c.focal, zc];
    }
    function unproject(c, sx, sy, planeZ) {
      var a = (sx - c.W / 2) / c.focal, b = -(sy - c.H / 2) / c.focal;
      var dx = c.f[0] + a * c.r[0] + b * c.u[0], dy = c.f[1] + a * c.r[1] + b * c.u[1], dz = c.f[2] + a * c.r[2] + b * c.u[2];
      if (Math.abs(dz) < 1e-6) return [c.tx, c.ty];
      var t = (planeZ - c.cz) / dz;
      return [c.cx + dx * t, c.cy + dy * t];
    }
    var tmpCam = {};
    function viewFor(mode) { return VIEWS[mode] || VIEWS.build; }
    function worldToScreen(cam, x, y) {
      placeCamera(cam, viewCur, tmpCam);
      var p = project(tmpCam, x, y, BEAM_Z);
      return p ? [p[0], p[1]] : [-9999, -9999];
    }
    function screenToWorld(cam, sx, sy) {
      placeCamera(cam, viewCur, tmpCam);
      return unproject(tmpCam, sx, sy, BEAM_Z);
    }

    function fitCamera(level, insets) {
      insets = insets || {};
      var b = (BB.Levels && BB.Levels.fitBounds) ? BB.Levels.fitBounds(level) : { minX: -20, maxX: 20, minY: -10, maxY: 10 };
      var l = insets.left || 0, r = insets.right || 0, t = insets.top || 0, bo = insets.bottom || 0;
      var aw = Math.max(60, W - l - r), ah = Math.max(60, H - t - bo);
      var zoom = Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY)) * 0.93;
      var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      return { x: cx - (l - r) / (2 * zoom), y: cy + (t - bo) / (2 * zoom) - 0.3, zoom: zoom };
    }

    // ----------------------------------------------------------------------------- static scene
    function levelSig(level) {
      var g = level.ground || [], s = 0, i;
      for (i = 0; i < g.length; i++) s = (s * 31 + Math.round(g[i][0] * 10) * 7 + Math.round(g[i][1] * 10)) | 0;
      var a = level.anchors || [], t = 0;
      for (i = 0; i < a.length; i++) t = (t * 17 + a[i][0] * 5 + a[i][1]) | 0;
      var extra = JSON.stringify([level.zones, level.prebuilt, level.checkpoints, level.routes, level.pistons]);
      return [level.id, g.length, s, t, level.water, level.world, level.startX, level.flagX, extra, level.gap, JSON.stringify(level.gates), JSON.stringify(level.signals), quality].join('|');
    }
    function disposeGroup(g) {
      if (!g) return;
      g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      scene.remove(g);
    }
    function ensureStatic(level) {
      var sig = levelSig(level);
      if (sig === st.sig) return;
      st.sig = sig; st.level = level;
      // clear
      disposeGroup(st.staticGroup);
      if (st.skyTex) { st.skyTex.dispose(); st.skyTex = null; }
      st.clouds.forEach(function (c) { c.geometry.dispose(); c.material.dispose(); scene.remove(c); });
      st.clouds = [];
      var T = U.themeFor(level), t = T.t;
      st.theme = T;
      var seed = (U.strHash(level.id || 'x') % 9973) + 3;
      var grp = new THREE.Group();
      var g = level.ground;
      if (g && g.length > 1) {
        var terr = W3.buildTerrain(level, T, seed, Q);
        st.terr = terr;
        grp.add(terr.mesh);
        var decor = W3.buildDecor(level, T, seed, Q, terr); if (decor) grp.add(decor);
        grp.add(W3.buildHills(level, T, seed, Q));
        st.water = W3.buildWater(level, T, Q);
        if (st.water) { grp.add(st.water.surface); grp.add(st.water.front); }
        st.gapObj = W3.buildGap(level, T, Q); grp.add(st.gapObj.group);
        var pr = W3.buildProps(level, T, seed, Q);
        grp.add(pr.group); st.anim = pr.anim;
        st.clouds = W3.buildClouds(level, T, seed, Q);
        st.clouds.forEach(function (c) { scene.add(c); });
      } else { st.water = null; st.gapObj = null; st.anim = { flags: [], lamps: [], cps: [] }; }
      scene.add(grp);
      st.staticGroup = grp;
      // sky + fog + lights
      st.skyTex = W3.skyTexture(T);
      scene.background = st.skyTex;
      scene.fog = new THREE.Fog(U.toHexNum(t.fog), 80, 400);
      hemi.color.setHex(U.toHexNum(t.hemiSky)); hemi.groundColor.setHex(U.toHexNum(t.hemiGround)); hemi.intensity = t.hemiI * 0.66; fill.color.setHex(U.toHexNum(t.hemiSky)); fill.intensity = 0.4;
      sun.color.setHex(U.toHexNum(t.sun)); sun.intensity = t.sunI * 0.72;
      st.weather = buildWeather(t);
      // ships / pistons are rebuilt lazily
      st.gates.forEach(function (r) { scene.remove(r.group); r.group.traverse(function (m) { if (m.geometry && !m.userData.shared) m.geometry.dispose(); if (m.material) m.material.dispose(); }); });
      st.gates = [];
    }

    // ----------------------------------------------------------------------------- weather
    var wGroup = new THREE.Group(); scene.add(wGroup);
    var wMesh = null, wList = [];
    function buildWeather(t) {
      if (wMesh) { wGroup.remove(wMesh); wMesh.geometry.dispose(); wMesh.material.dispose(); wMesh = null; }
      wList = [];
      var n = t.snow ? 170 : t.ash ? 90 : 0;
      var level = st.level, wind = level && isNum(level.wind) ? level.wind : 0;
      if (!n) return { snow: false, ash: false };
      wMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: t.snow ? 0xffffff : 0xffa040, transparent: true, opacity: t.snow ? 0.9 : 0.85 }), n);
      wMesh.frustumCulled = false; wMesh.count = n; wMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      wGroup.add(wMesh);
      var r = U.mulberry32(9);
      for (var i = 0; i < n; i++) wList.push({ x: r(), y: r(), z: r() * 60 - 40, s: 0.07 + r() * 0.1, sp: 0.5 + r() });
      return { snow: !!t.snow, ash: !!t.ash };
    }
    var _wm = new THREE.Matrix4();
    function updateWeather(time, dt, cam) {
      if (!wMesh) return;
      var w = st.weather, snow = w.snow, span = 90, h = 50;
      var windV = (st.level && isNum(st.level.wind)) ? st.level.wind : 0;
      for (var i = 0; i < wList.length; i++) {
        var p = wList[i];
        p.y += (snow ? -1 : 1) * (snow ? 1.4 : 2.2) * p.sp * dt / h; p.x += (windV * 0.5 + (snow ? 0.4 : 0.6)) * dt / span * p.sp;
        if (p.y < 0) p.y += 1; if (p.y > 1) p.y -= 1; if (p.x > 1) p.x -= 1; if (p.x < 0) p.x += 1;
        var x = cam.x + (p.x - 0.5) * span, y = cam.y + (p.y - 0.5) * h + (snow ? 6 : 0);
        _wm.makeScale(p.s, p.s, p.s); _wm.setPosition(x, y, p.z + 2);
        wMesh.setMatrixAt(i, _wm);
      }
      wMesh.instanceMatrix.needsUpdate = true;
    }

    // wind streaks (levels with wind): thin white lines drifting through the picture
    var streaks = (function () {
      var n = 22, geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 6);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      var m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
      m.frustumCulled = false; m.visible = false; scene.add(m);
      var seeds = []; var r = U.mulberry32(3); for (var i = 0; i < n; i++) seeds.push({ x: r(), y: r(), l: 2 + r() * 4, sp: 0.6 + r() * 0.8, z: -3 + r() * 8 });
      return { mesh: m, pos: pos, seeds: seeds, n: n };
    })();
    function updateStreaks(time, cam, wind) {
      var s = streaks;
      s.mesh.visible = Math.abs(wind) > 0.05;
      if (!s.mesh.visible) return;
      var span = 80;
      for (var i = 0; i < s.n; i++) {
        var q = s.seeds[i], x = ((q.x + time * wind * 0.045 * q.sp) % 1 + 1) % 1, k = i * 6;
        var px = cam.x + (x - 0.5) * span, py = cam.y + (q.y - 0.5) * 34;
        s.pos[k] = px; s.pos[k + 1] = py; s.pos[k + 2] = q.z;
        s.pos[k + 3] = px + q.l * Math.sign(wind); s.pos[k + 4] = py + Math.sin(time + i) * 0.2; s.pos[k + 5] = q.z;
      }
      s.mesh.geometry.attributes.position.needsUpdate = true;
    }

    // ----------------------------------------------------------------------------- beams
    var tint = [0, 0, 0];
    function memberColor(base, stress, showStress, debris, pre) {
      var c = U.hex(base);
      if (pre) c = U.mix(c, '#8a96a6', 0.35);
      if (showStress && !debris && isNum(stress)) { var s = U.stressRGB(stress); c = [c[0] * 0.35 + s[0] * 0.65, c[1] * 0.35 + s[1] * 0.65, c[2] * 0.35 + s[2] * 0.65]; }
      if (debris) c = [c[0] * 0.62, c[1] * 0.62, c[2] * 0.62];
      return c;
    }
    var COL_LINK = [0.35, 0.38, 0.43], COL_JOINT = [0.86, 0.88, 0.91], COL_ANCH = [0.8, 0.83, 0.87], COL_SPLIT = [1, 0.62, 0.1], COL_STRIPE = [1, 0.82, 0.25];
    var CZ = BEAM_Z;

    function emitBeam(s, showStress, time) {
      var dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
      if (len < 1e-4) return;
      var th = Math.atan2(dy, dx), nx = -Math.sin(th), ny = Math.cos(th), mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
      // campaign materials ("Zeitreise") are drawn like one of the classic ones (mat.look) in their own colour
      var mat = BB.MATERIALS && BB.MATERIALS[s.m], look = (mat && mat.look) || s.m, own = !!(mat && mat.look);
      var base = MATC[s.m] || (mat && mat.color) || '#999999', col = memberColor(base, s.stress, showStress, s.debris, s.pre), z;
      if (own && emitOwn(s, mat, look, col, th, nx, ny, mx, my, len, dx, dy)) return;
      switch (look) {
        case 'road': {
          var slabC = own ? mat.color : '#4c4c56';
          var sl = U.hex(slabC); if (s.pre) sl = U.mix(sl, '#8a96a6', 0.3);
          if (showStress && !s.debris) sl = memberColor(slabC, s.stress, true, false, s.pre), sl = [sl[0] * 0.8 + 0.12, sl[1] * 0.8 + 0.12, sl[2] * 0.8 + 0.12];
          if (s.debris) sl = [sl[0] * 0.65, sl[1] * 0.65, sl[2] * 0.65];
          put(boxSet, mx, my, 0, th, len + 0.05, 0.26, 2.9, sl);
          if (!own) put(boxSet, mx + nx * 0.14, my + ny * 0.14, 0, th, len * 0.8, 0.03, 0.16, COL_STRIPE);
          for (z = -1; z <= 1; z += 2) put(boxSet, mx - nx * 0.18, my - ny * 0.18, z * CZ, th, len, 0.2, 0.22, col);
          break;
        }
        case 'steelroad': {
          var sl2 = memberColor('#7a8ea3', s.stress, showStress, s.debris, s.pre);
          if (showStress && !s.debris) sl2 = [sl2[0] * 0.8 + 0.14, sl2[1] * 0.8 + 0.14, sl2[2] * 0.8 + 0.14];
          put(boxSet, mx, my, 0, th, len + 0.05, 0.24, 2.9, s.debris ? [0.3, 0.34, 0.4] : sl2);
          put(boxSet, mx + nx * 0.14, my + ny * 0.14, 0, th, len * 0.8, 0.03, 0.14, [0.95, 0.95, 0.95]);
          for (z = -1; z <= 1; z += 2) put(boxSet, mx - nx * 0.3, my - ny * 0.3, z * (CZ - 0.05), th, len, 0.46, 0.16, col);
          break;
        }
        case 'rail': {
          put(boxSet, mx, my, 0, th, len + 0.05, 0.28, 2.9, s.debris ? [0.25, 0.22, 0.2] : [0.3, 0.28, 0.26]);
          for (z = -1; z <= 1; z += 2) { put(boxSet, mx + nx * 0.2, my + ny * 0.2, z * 0.72, th, len, 0.1, 0.12, s.debris ? [0.4, 0.4, 0.4] : [0.78, 0.8, 0.84]); put(boxSet, mx - nx * 0.28, my - ny * 0.28, z * (CZ - 0.05), th, len, 0.4, 0.16, col); }
          var ties = Math.max(1, Math.round(len / 0.9));
          for (var q = 0; q < ties; q++) { var t = (q + 0.5) / ties; put(boxSet, s.x1 + dx * t + nx * 0.15, s.y1 + dy * t + ny * 0.15, 0, th, 0.18, 0.08, 2.2, [0.36, 0.26, 0.18]); }
          break;
        }
        case 'wood':
          for (z = -1; z <= 1; z += 2) { put(boxSet, mx, my, z * CZ, th, len, 0.3, 0.3, col); put(boxSet, mx + nx * 0.02, my + ny * 0.02, z * CZ + z * 0.16, th, len * 0.96, 0.18, 0.04, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8]); }
          break;
        case 'steel':
          for (z = -1; z <= 1; z += 2) { put(boxSet, mx, my, z * CZ, th, len, 0.27, 0.27, col); put(boxSet, mx, my, z * CZ + z * 0.15, th, len * 0.97, 0.12, 0.04, [col[0] * 0.75, col[1] * 0.75, col[2] * 0.75]); }
          break;
        case 'concrete':
          put(boxSet, mx, my, 0, th, len, 0.8, 2.3, col);
          put(boxSet, mx, my, 0, th, len + 0.05, 0.9, 0.5, [col[0] * 0.85, col[1] * 0.85, col[2] * 0.85]);
          break;
        case 'rope': case 'cable': {
          var r = s.m === 'cable' ? 0.09 : 0.065;
          for (z = -1; z <= 1; z += 2) {
            if (s.slack > 0.05) {      // sagging rope: two segments through a hanging midpoint
              var sg = Math.min(s.slack * 0.5, len * 0.5), px = mx + 0 * nx, py = my - sg;
              segCyl(s.x1, s.y1, px, py, z * CZ, r, col); segCyl(px, py, s.x2, s.y2, z * CZ, r, col);
            } else put(cylSet, mx, my, z * CZ, th, len, r, r, col);
          }
          break;
        }
        case 'spring': {
          var n = 7;
          for (z = -1; z <= 1; z += 2) {
            var px0 = s.x1, py0 = s.y1;
            for (var k = 1; k <= n; k++) {
              var tt = k / n, off = (k === n ? 0 : (k % 2 ? 1 : -1)) * 0.24;
              var qx = s.x1 + dx * tt + nx * off, qy = s.y1 + dy * tt + ny * off;
              segCyl(px0, py0, qx, qy, z * CZ, 0.06, col);
              px0 = qx; py0 = qy;
            }
          }
          break;
        }
        case 'hydraulic': {
          var barrel = Math.min(len * 0.6, (s.restMin || len) * 0.55);
          for (z = -1; z <= 1; z += 2) {
            var bx = s.x1 + dx / len * barrel, by = s.y1 + dy / len * barrel;
            put(cylSet, (s.x1 + bx) / 2, (s.y1 + by) / 2, z * CZ, th, barrel, 0.2, 0.2, col);
            put(cylSet, (bx + s.x2) / 2, (by + s.y2) / 2, z * CZ, th, len - barrel, 0.1, 0.1, [0.82, 0.85, 0.9]);
            put(cylSet, bx, by, z * CZ, th, 0.12, 0.24, 0.24, [0.45, 0.48, 0.52]);
          }
          break;
        }
        default:
          for (z = -1; z <= 1; z += 2) put(boxSet, mx, my, z * CZ, th, len, 0.26, 0.26, col);
      }
    }
    /** drawings of the Zeitreise materials that differ from the classic look; returns true when drawn */
    var ROPE_C = [0.79, 0.7, 0.49];
    function emitOwn(s, mat, look, col, th, nx, ny, mx, my, len, dx, dy) {
      var z, k, dark = [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7];
      if (s.m === 'log') {                                 // a row of tree trunks side by side
        for (k = -2; k <= 2; k++) put(cylSet, mx, my, k * 0.56, th, len + 0.04, 0.27, 0.27, k % 2 ? col : [col[0] * 0.9, col[1] * 0.9, col[2] * 0.9]);
        put(boxSet, mx - nx * 0.28, my - ny * 0.28, CZ, th, len, 0.2, 0.22, dark); put(boxSet, mx - nx * 0.28, my - ny * 0.28, -CZ, th, len, 0.2, 0.22, dark);
        return true;
      }
      if (s.m === 'plank') {                               // boards across the road
        put(boxSet, mx, my, 0, th, len + 0.05, 0.22, 2.9, col);
        var nb = Math.max(1, Math.round(len / 0.6));
        for (k = 0; k < nb; k++) { var tb = (k + 0.5) / nb; put(boxSet, s.x1 + dx * tb + nx * 0.12, s.y1 + dy * tb + ny * 0.12, 0, th, 0.05, 0.04, 2.9, dark); }
        for (z = -1; z <= 1; z += 2) put(boxSet, mx - nx * 0.2, my - ny * 0.2, z * CZ, th, len, 0.2, 0.2, dark);
        return true;
      }
      if (s.m === 'chain') {                               // links: short boxes, one turned across
        var nl = Math.max(2, Math.round(len / 0.34));
        for (z = -1; z <= 1; z += 2) for (k = 0; k < nl; k++) { var tl = (k + 0.5) / nl; put(boxSet, s.x1 + dx * tl, s.y1 + dy * tl, z * CZ, th, 0.24, k % 2 ? 0.16 : 0.07, k % 2 ? 0.07 : 0.17, col); }
        return true;
      }
      var IR = [0.2, 0.21, 0.23];
      if (s.m === 'timber' || s.m === 'oak') {             // squared beam with grain lines (oak: heavier, with iron straps)
        var heavy = s.m === 'oak';
        for (z = -1; z <= 1; z += 2) {
          put(boxSet, mx, my, z * CZ, th, len, heavy ? 0.34 : 0.28, heavy ? 0.34 : 0.28, col);
          put(boxSet, mx + nx * 0.07, my + ny * 0.07, z * CZ + z * 0.17, th, len * 0.94, 0.03, 0.03, dark);
          put(boxSet, mx - nx * 0.06, my - ny * 0.06, z * CZ + z * 0.17, th, len * 0.8, 0.025, 0.03, dark);
          if (heavy) for (k = 0; k <= Math.max(1, Math.round(len / 1.3)); k++) { var tq = (k + 0.5) / (Math.max(1, Math.round(len / 1.3)) + 1); put(boxSet, s.x1 + dx * tq, s.y1 + dy * tq, z * CZ, th, 0.07, 0.38, 0.38, IR); }
        }
        return true;
      }
      if (s.m === 'branch') {                              // a branch with two side twigs and some leaves
        for (z = -1; z <= 1; z += 2) {
          put(cylSet, mx, my, z * CZ, th, len, 0.1, 0.075, col);
          put(cylSet, s.x1 + dx * 0.35 + nx * 0.14, s.y1 + dy * 0.35 + ny * 0.14, z * CZ, th + 0.7, len * 0.3, 0.04, 0.03, col);
          put(cylSet, s.x1 + dx * 0.7 - nx * 0.14, s.y1 + dy * 0.7 - ny * 0.14, z * CZ, th - 0.7, len * 0.28, 0.04, 0.03, col);
          put(sphSet, s.x1 + dx * 0.5 + nx * 0.3, s.y1 + dy * 0.5 + ny * 0.3, z * CZ, 0, 0.12, 0.08, 0.12, [0.42, 0.62, 0.32]);
          put(sphSet, s.x1 + dx * 0.85 - nx * 0.3, s.y1 + dy * 0.85 - ny * 0.3, z * CZ, 0, 0.12, 0.08, 0.12, [0.38, 0.58, 0.3]);
        }
        return true;
      }
      if (s.m === 'iron') {                                // forged bar with rivet heads
        for (z = -1; z <= 1; z += 2) {
          put(boxSet, mx, my, z * CZ, th, len, 0.24, 0.24, col);
          put(boxSet, mx + nx * 0.1, my + ny * 0.1, z * CZ + z * 0.13, th, len * 0.96, 0.05, 0.03, [col[0] * 1.3, col[1] * 1.3, col[2] * 1.3]);
          for (k = 0; k < Math.max(2, Math.round(len / 0.8)); k++) { var ti = (k + 0.5) / Math.max(2, Math.round(len / 0.8)); put(sphSet, s.x1 + dx * ti, s.y1 + dy * ti, z * CZ + z * 0.14, 0, 0.06, 0.06, 0.06, [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6]); }
        }
        return true;
      }
      if (s.m === 'girder') {                              // riveted I-beam: two flanges and a web
        for (z = -1; z <= 1; z += 2) {
          put(boxSet, mx + nx * 0.14, my + ny * 0.14, z * CZ, th, len, 0.05, 0.34, col);
          put(boxSet, mx - nx * 0.14, my - ny * 0.14, z * CZ, th, len, 0.05, 0.34, col);
          put(boxSet, mx, my, z * CZ, th, len, 0.26, 0.06, [col[0] * 0.88, col[1] * 0.88, col[2] * 0.88]);
          for (k = 0; k < Math.max(2, Math.round(len / 0.7)); k++) { var tg = (k + 0.5) / Math.max(2, Math.round(len / 0.7)); put(sphSet, s.x1 + dx * tg, s.y1 + dy * tg, z * CZ + z * 0.05, 0, 0.045, 0.045, 0.045, [0.85, 0.8, 0.72]); }
        }
        return true;
      }
      if (s.m === 'bronze') {                              // short, heavy clamp with rings at the ends
        for (z = -1; z <= 1; z += 2) {
          put(boxSet, mx, my, z * CZ, th, len, 0.3, 0.3, col);
          put(boxSet, s.x1 + dx * 0.12, s.y1 + dy * 0.12, z * CZ, th, 0.09, 0.4, 0.4, [col[0] * 1.2, col[1] * 1.15, col[2] * 1.0]);
          put(boxSet, s.x2 - dx * 0.12, s.y2 - dy * 0.12, z * CZ, th, 0.09, 0.4, 0.4, [col[0] * 1.2, col[1] * 1.15, col[2] * 1.0]);
        }
        return true;
      }
      if (s.m === 'hemp' || s.m === 'wire') {              // hemp: twisted rope with bindings; wire: three bright strands
        var thin = s.m === 'wire';
        for (z = -1; z <= 1; z += 2) {
          var rr = thin ? 0.035 : 0.065;
          var hang = s.slack > 0.05 ? Math.min(s.slack * 0.5, len * 0.5) : 0;
          if (hang) { var px2 = mx, py2 = my - hang; segCyl(s.x1, s.y1, px2, py2, z * CZ, rr, col); segCyl(px2, py2, s.x2, s.y2, z * CZ, rr, col); }
          else if (thin) { for (k = -1; k <= 1; k++) put(cylSet, mx + nx * 0.04 * k, my + ny * 0.04 * k, z * CZ + 0.03 * k * z, th, len, rr, rr, [col[0] * (1 + 0.06 * k), col[1] * (1 + 0.06 * k), col[2] * (1 + 0.06 * k)]); }
          else { put(cylSet, mx, my, z * CZ, th, len, rr, rr, col); for (k = 1; k < Math.max(2, Math.round(len / 0.55)); k++) { var th2 = k / Math.max(2, Math.round(len / 0.55)); put(boxSet, s.x1 + dx * th2, s.y1 + dy * th2, z * CZ, th, 0.06, 0.16, 0.16, dark); } }
        }
        return true;
      }
      if (s.m === 'cast') {                                // cast-iron plate: ribbed from below, dark and heavy
        put(boxSet, mx, my, 0, th, len + 0.05, 0.3, 2.9, col);
        for (k = 0; k < Math.max(2, Math.round(len / 0.8)); k++) { var tr = (k + 0.5) / Math.max(2, Math.round(len / 0.8)); put(boxSet, s.x1 + dx * tr - nx * 0.2, s.y1 + dy * tr - ny * 0.2, 0, th, 0.1, 0.22, 2.7, [col[0] * 0.78, col[1] * 0.78, col[2] * 0.78]); }
        for (z = -1; z <= 1; z += 2) put(boxSet, mx + nx * 0.17, my + ny * 0.17, z * 1.3, th, len, 0.07, 0.12, [col[0] * 1.3, col[1] * 1.3, col[2] * 1.3]);
        return true;
      }
      if (s.m === 'oakplank') {                            // heavy planks with iron straps
        put(boxSet, mx, my, 0, th, len + 0.05, 0.26, 2.9, col);
        var npk = Math.max(2, Math.round(len / 0.5));
        for (k = 1; k < npk; k++) { var tk = k / npk; put(boxSet, s.x1 + dx * tk + nx * 0.14, s.y1 + dy * tk + ny * 0.14, 0, th, 0.03, 0.04, 2.9, dark); }
        for (k = 0; k < Math.max(1, Math.round(len / 1.5)); k++) { var ts2 = (k + 0.5) / Math.max(1, Math.round(len / 1.5)); put(boxSet, s.x1 + dx * ts2 + nx * 0.15, s.y1 + dy * ts2 + ny * 0.15, 0, th, 0.08, 0.03, 2.9, IR); }
        for (z = -1; z <= 1; z += 2) put(boxSet, mx - nx * 0.18, my - ny * 0.18, z * CZ, th, len, 0.2, 0.22, dark);
        return true;
      }
      if (s.m === 'winch') {                               // a wooden beam with a drum and the rope wound on it (extends like a hydraulic ram)
        var drumT = 0.25, bx2 = s.x1 + dx * drumT, by2 = s.y1 + dy * drumT, barrelL = Math.min(len * 0.55, (s.restMin || len) * 0.5);
        for (z = -1; z <= 1; z += 2) {
          put(boxSet, s.x1 + dx / len * barrelL * 0.5, s.y1 + dy / len * barrelL * 0.5, z * CZ, th, barrelL, 0.32, 0.32, col);
          put(cylSet, s.x1 + dx / len * (barrelL + (len - barrelL) * 0.5), s.y1 + dy / len * (barrelL + (len - barrelL) * 0.5), z * CZ, th, len - barrelL, 0.07, 0.07, ROPE_C);
          put(boxSet, bx2, by2, z * CZ + z * 0.0, th + Math.PI / 2, 0.5, 0.2, 0.6, dark);          // the drum seen from the side
        }
        return true;
      }
      if (s.m === 'liana') {                               // vine with a few leaves
        for (z = -1; z <= 1; z += 2) {
          if (s.slack > 0.05) { var sg = Math.min(s.slack * 0.5, len * 0.5), px = mx, py = my - sg; segCyl(s.x1, s.y1, px, py, z * CZ, 0.06, col); segCyl(px, py, s.x2, s.y2, z * CZ, 0.06, col); }
          else put(cylSet, mx, my, z * CZ, th, len, 0.06, 0.06, col);
          for (k = 1; k < 4; k++) { var tv = k / 4; put(sphSet, s.x1 + dx * tv, s.y1 + dy * tv - 0.1, z * CZ, 0, 0.13, 0.08, 0.13, [0.42, 0.66, 0.3]); }
        }
        return true;
      }
      if (s.m === 'brick') {                               // pillar of bricks with mortar courses
        put(boxSet, mx, my, 0, th, len, 0.85, 2.3, col);
        var nc = Math.max(2, Math.round(len / 0.5));
        for (k = 1; k < nc; k++) { var tc = k / nc; put(boxSet, s.x1 + dx * tc, s.y1 + dy * tc, 0, th, 0.04, 0.9, 2.34, [0.85, 0.8, 0.72]); }
        return true;
      }
      if (s.m === 'boulder') {                             // rough rock block
        put(boxSet, mx, my, 0, th, len, 0.95, 1.9, col);
        put(boxSet, mx + nx * 0.1, my + ny * 0.1, 0.3, th, len * 0.7, 0.8, 1.4, [col[0] * 1.08, col[1] * 1.08, col[2] * 1.08]);
        put(sphSet, mx, my, -0.5, 0, 0.5, 0.5, 0.5, dark);
        return true;
      }
      if (s.m === 'pier') {                                // stone pier with courses
        put(boxSet, mx, my, 0, th, len, 0.95, 2.2, col);
        var np2 = Math.max(2, Math.round(len / 0.6));
        for (k = 1; k < np2; k++) { var tp2 = k / np2; put(boxSet, s.x1 + dx * tp2, s.y1 + dy * tp2, 0, th, 0.04, 0.98, 2.24, dark); }
        return true;
      }
      if (s.m === 'stone') {                               // ashlar blocks with joints
        put(boxSet, mx, my, 0, th, len + 0.04, 0.5, 2.7, col);
        var ns = Math.max(1, Math.round(len / 0.8));
        for (k = 1; k < ns; k++) { var ts = k / ns; put(boxSet, s.x1 + dx * ts, s.y1 + dy * ts, 0, th, 0.04, 0.52, 2.74, dark); }
        return true;
      }
      return false;
    }
    function segCyl(x1, y1, x2, y2, z, r, c) {
      var dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy);
      if (l < 1e-4) return;
      put(cylSet, (x1 + x2) / 2, (y1 + y2) / 2, z, Math.atan2(dy, dx), l, r, r, c);
    }
    function emitJoint(x, y, anchor, debris, split) {
      var c = split ? COL_SPLIT : (debris ? [0.5, 0.52, 0.56] : (anchor ? COL_ANCH : COL_JOINT));
      var r = anchor ? 0.3 : (debris ? 0.14 : 0.2);
      put(sphSet, x, y, CZ + 0.05, 0, r, r, r, c); put(sphSet, x, y, -CZ - 0.05, 0, r, r, r, c);
      // link rod across the deck width
      if (!debris) { var a = set_zrod(x, y, c); }
    }
    function set_zrod(x, y, c) {
      // a cylinder along z: use a box (thin) instead of rotating the x-axis cylinder
      put(boxSet, x, y, 0, 0, 0.1, 0.1, 2.7, COL_LINK);
      return 0;
    }

    function collectBuild(level, bridge, showStress, time, quick) {
      var beams = (bridge && bridge.beams) || [], i, e, qs = quick && quick.stress ? quick.stress : null, np = 0;
      var seen = Object.create(null);
      var pre = (level.prebuilt && level.prebuilt.beams) || [];
      var all = [];
      for (i = 0; i < pre.length; i++) if (!pre[i].o) { all.push(Object.assign({ pre: true }, pre[i])); np++; }
      for (i = 0; i < beams.length; i++) all.push(beams[i]);
      var anchorKeys = Object.create(null), an = level.anchors || [];
      for (i = 0; i < an.length; i++) anchorKeys[an[i][0] + ',' + an[i][1]] = 1;
      var found = (bridge && bridge.found) || [];
      for (i = 0; i < found.length; i++) anchorKeys[found[i][0] + ',' + found[i][1]] = 1;
      for (i = 0; i < all.length; i++) {
        var b = all[i];
        if (!b || !isNum(b.x1) || !isNum(b.y1) || !isNum(b.x2) || !isNum(b.y2)) continue;
        var qi = i - np, qv = qs && qi >= 0 ? (quick.broken && quick.broken.indexOf(qi) >= 0 ? 1 : qs[qi]) : 0;
        emitBeam({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m, stress: qv, pre: !!b.pre, restMin: Math.hypot(b.x2 - b.x1, b.y2 - b.y1) }, !!(qs && qi >= 0), time);
        for (e = 0; e < 2; e++) {
          var x = e ? b.x2 : b.x1, y = e ? b.y2 : b.y1, sp = e ? b.s2 : b.s1, k = x + ',' + y + (sp ? '#1' : '');
          if (seen[k] || anchorKeys[x + ',' + y]) continue;
          seen[k] = 1;
          if (sp) {   // split joint: orange knob pulled a little along the beam
            var l = Math.hypot(b.x2 - b.x1, b.y2 - b.y1), ux = (e ? b.x1 - b.x2 : b.x2 - b.x1) / l, uy = (e ? b.y1 - b.y2 : b.y2 - b.y1) / l;
            emitJoint(x + ux * 0.32, y + uy * 0.32, false, false, true);
          } else emitJoint(x, y, false, false, false);
        }
      }
    }
    function collectSim(level, sim, showStress, time) {
      var beams = sim.beams || [], i;
      var intact = new Set();
      for (i = 0; i < beams.length; i++) {
        var b = beams[i];
        if (!b || b.broken || !b.a || !b.b) continue;
        var pa = b.a, pb = b.b;
        if (!isNum(pa.x) || !isNum(pa.y) || !isNum(pb.x) || !isNum(pb.y)) continue;
        var len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        var slack = (b.tensionOnly && isNum(b.rest) && b.rest > len + 0.01) ? b.rest - len : 0;
        emitBeam({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, m: b.m, stress: b.stress, debris: b.debris, pre: !!b.pre, slack: slack, restMin: b.restMin }, showStress, time);
        if (!b.debris) { intact.add(pa); intact.add(pb); }
      }
      var joints = sim.joints || [];
      for (i = 0; i < joints.length; i++) {
        var p = joints[i];
        if (!p || p.anchor || !(p.deg > 0) || !isNum(p.x) || !isNum(p.y)) continue;
        emitJoint(p.x, p.y, false, !intact.has(p), false);
      }
    }

    // ----------------------------------------------------------------------------- foundations, pistons
    var foundGroup = new THREE.Group(); scene.add(foundGroup);
    var foundKey = '', foundMeshes = [];
    function syncFoundations(level, found) {
      var key = (found || []).map(function (f) { return f[0] + ',' + f[1]; }).join(';') + '|' + st.sig;
      if (key === foundKey) return;
      foundKey = key;
      foundMeshes.forEach(function (m) { foundGroup.remove(m); m.geometry.dispose(); m.material.dispose(); });
      foundMeshes = [];
      (found || []).forEach(function (f) {
        var surf = W3.surfaceAt(level.ground, f[0]), h = Math.max(0.3, f[1] - surf + 0.35);
        var m = new THREE.Mesh(M.foundationGeometry(h), new THREE.MeshLambertMaterial({ vertexColors: true }));
        m.position.set(f[0], f[1], 0); m.castShadow = true; m.receiveShadow = true;
        foundGroup.add(m); foundMeshes.push(m);
      });
    }

    function emitPiston(px, py, hx, hy, minLen) {
      var dx = hx - px, dy = hy - py, len = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
      var barrel = Math.min(len, Math.max(0.5, minLen * 0.85));
      var bx = px + dx / len * barrel, by = py + dy / len * barrel;
      for (var z = -1; z <= 1; z += 2) {
        put(cylSet, (px + bx) / 2, (py + by) / 2, z * CZ, th, barrel, 0.34, 0.34, [0.94, 0.7, 0.16]);
        if (len > barrel + 0.01) put(cylSet, (bx + hx) / 2, (by + hy) / 2, z * CZ, th, len - barrel, 0.17, 0.17, [0.84, 0.87, 0.92]);
        put(sphSet, hx, hy, z * (CZ + 0.05), 0, 0.28, 0.28, 0.28, [0.85, 0.88, 0.92]);
        put(sphSet, px, py, z * (CZ + 0.05), 0, 0.3, 0.3, 0.3, [0.5, 0.54, 0.6]);
      }
    }

    // ----------------------------------------------------------------------------- vehicles
    var nightGlow = null, glowTex = null;
    function glowTexture() {
      if (glowTex) return glowTex;
      var c = document.createElement('canvas'); c.width = c.height = 64;
      var x = c.getContext('2d'), g = x.createRadialGradient(8, 32, 2, 8, 32, 60);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      glowTex = new THREE.CanvasTexture(c);
      return glowTex;
    }
    function vehicleObject(v) {
      var o = st.vehicles.get(v);
      if (o) return o;
      var def = v.def || (BB.VEHICLES && BB.VEHICLES[v.type]) || {};
      var custom = (v.color && v.color !== def.color) ? v.color : null;      // route colour (several goals), else the muted default
      var group = new THREE.Group();
      var body = new THREE.Mesh(M.vehicleBody(v.type, custom), new THREE.MeshLambertMaterial({ vertexColors: true }));
      body.castShadow = true; body.receiveShadow = true;
      group.add(body);
      var wheels = [];
      for (var i = 0; i < (v.wheels ? v.wheels.length : 0); i++) {
        var w = v.wheels[i], info = M.vehicleWheel(v.type, w.r || def.wheelRadius || 0.4, i);
        if (!info.geom) { wheels.push(null); continue; }
        var wm = new THREE.Mesh(info.geom, new THREE.MeshLambertMaterial({ vertexColors: true }));
        wm.castShadow = true;
        group.add(wm); wheels.push(wm);
      }
      // v3.4: animated parts (legs, tails, trunks): swing with the distance travelled, sway with the time
      var anims = [], pl = M.vehicleParts ? M.vehicleParts(v.type, custom) : null;
      if (pl) pl.forEach(function (a) {
        var am = new THREE.Mesh(a.geom, new THREE.MeshLambertMaterial({ vertexColors: true }));
        am.castShadow = true; am.position.set(a.pivot[0], a.pivot[1], a.pivot[2]); am.scale.set(a.scale, a.scale, a.scale);
        group.add(am); anims.push({ mesh: am, spec: a });
      });
      if (st.theme && st.theme.t.night) {
        var L = def.length || 4;
        var glowGeo = new THREE.PlaneGeometry(1, 1);
        var gm = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xfff1b0, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        gm.scale.set(6.5, 2.2, 1); gm.position.set(L / 2 + 3.2, 0.75, 0); gm.rotation.y = 0;
        group.add(gm);
        var gm2 = gm.clone(); gm2.rotation.x = Math.PI / 2; gm2.scale.set(6.5, 3.2, 1); group.add(gm2);
      }
      scene.add(group);
      o = { group: group, body: body, wheels: wheels, anims: anims };
      st.vehicles.set(v, o);
      return o;
    }
    function clearVehicles() {
      st.vehicles.forEach(function (o) { scene.remove(o.group); o.group.traverse(function (m) { if (m.material) m.material.dispose(); }); });
      st.vehicles.clear();
    }
    function syncVehicles(sim, time) {
      var vs = sim.vehicles || [];
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (!v) continue;
        var show = v.state !== 'waiting' && v.visible !== false && !v.removed && v.pose && isNum(v.pose.x) && isNum(v.pose.y);
        var o = st.vehicles.get(v);
        if (!show) { if (o) o.group.visible = false; continue; }
        o = vehicleObject(v);
        o.group.visible = true;
        var a = isNum(v.pose.angle) ? v.pose.angle : 0, ca = Math.cos(a), sa = Math.sin(a);
        o.group.position.set(v.pose.x, v.pose.y, 0);
        o.group.rotation.z = a;
        for (var k = 0; k < o.wheels.length; k++) {
          var w = v.wheels[k];
          if (!w || !w.p || !o.wheels[k]) continue;
          var ddx = w.p.x - v.pose.x, ddy = w.p.y - v.pose.y;
          o.wheels[k].position.set(ddx * ca + ddy * sa, -ddx * sa + ddy * ca, 0);
          o.wheels[k].rotation.z = (isNum(w.angle) ? w.angle : 0) - a;
        }
        if (o.anims && o.anims.length) {
          var moving = Math.min(1, Math.abs(isNum(v.speed) ? v.speed : 0) / 1.2);
          for (var q = 0; q < o.anims.length; q++) {
            var sp = o.anims[q].spec;
            o.anims[q].mesh.rotation.z = sp.kind === 'swing' ? sp.amp * moving * Math.sin(v.pose.x / sp.stride * 6.2832 + sp.phase) : sp.amp * Math.sin((time || 0) * 2.4 + sp.phase) * (sp.stride < 1.4 ? 1 : 0.6 + 0.4 * moving);
          }
        }
      }
    }

    // ----------------------------------------------------------------------------- ships
    function gateVessel(g, i, level) {
      var group = new THREE.Group(), W = Math.max(1, g.x1 - g.x0), def;
      if (g.kind === 'ship') {
        var topRel = (g.y1 - (isNum(level.water) ? level.water : g.y0)) - 0.3;
        var hull = g.color || ['#a8523c', '#3f6b9a', '#4f8a66', '#7d5a96'][i % 4];
        var VS = g.vessel && BB.TIME && BB.TIME.SHIPS ? BB.TIME.SHIPS[g.vessel] : null;      // Zeitreise: raft, Nile boat, galley, cog, steamer
        if (VS) hull = g.color || VS.hull;
        var geo = VS ? M.vesselGeometry(g.vessel, Math.max(g.len, 5), clamp(W * 0.7, 2.2, 7), Math.max(1.6, topRel), hull, VS.cabin) : M.shipGeometry(Math.max(g.len, 5), clamp(W * 0.7, 2.2, 7), Math.max(1.6, topRel), hull, '#ece8de');
        var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
        if (VS && M.vesselParts) M.vesselParts(g.vessel, Math.max(g.len, 5), clamp(W * 0.7, 2.2, 7), Math.max(1.6, topRel), hull).forEach(function (a) {
          var am = new THREE.Mesh(a.geom, new THREE.MeshLambertMaterial({ vertexColors: true }));
          am.castShadow = true; am.position.set(a.pivot[0], a.pivot[1], a.pivot[2]); am.scale.set(a.scale, a.scale, a.scale);
          group.add(am); (group.userData.anims = group.userData.anims || []).push({ mesh: am, spec: a });
        });
      } else {
        var type = g.kind === 'train' ? 'train' : 'truck';
        def = (BB.VEHICLES && BB.VEHICLES[type]) || {};
        var body = new THREE.Mesh(M.vehicleBody(type, g.color && g.kind === 'truck' ? g.color : null), new THREE.MeshLambertMaterial({ vertexColors: true }));
        body.castShadow = true; body.receiveShadow = true;
        group.add(body);
        var ax = def.axles || [-2, 2];
        for (var k = 0; k < ax.length; k++) {
          var info = M.vehicleWheel(type, def.wheelRadius || 0.5);
          var wm = new THREE.Mesh(info.geom, new THREE.MeshLambertMaterial({ vertexColors: true }));
          wm.position.set(ax[k], 0, 0); wm.castShadow = true; group.add(wm);
        }
        group.userData.lift = def.wheelRadius || 0.5;
      }
      group.rotation.y = -Math.PI / 2;                    // bow / front towards the viewer (+z)
      var holder = new THREE.Group(); holder.add(group);
      scene.add(holder);
      return { group: holder, inner: group, kind: g.kind };
    }
    function syncGates(level, sim, time) {
      var defs = (BB.Gates && BB.Gates.of) ? BB.Gates.of(level) : [];
      while (st.gates.length > defs.length) { var r0 = st.gates.pop(); scene.remove(r0.group); }
      var front = W3.terrFront ? W3.terrFront(level) : 1.75;
      for (var i = 0; i < defs.length; i++) {
        var g = defs[i], rec = st.gates[i];
        if (!rec) rec = st.gates[i] = gateVessel(g, i, level);
        var live = sim && sim.gates && sim.gates[i];
        var zc = live ? live.zc : g.zStart;
        var cx = (g.x0 + g.x1) / 2, y;
        if (g.kind === 'ship') {
          zc = Math.min(zc, front - g.len / 2 - 0.5);                       // moors in the basin in front of the bridge
          var wl = isNum(level.water) ? level.water : g.y0;
          y = wl + 0.04 + Math.sin(time * 1.7 + i) * 0.1;
          rec.inner.rotation.z = Math.sin(time * 1.3 + i * 2) * 0.03;
          var van = rec.inner.userData.anims;
          if (van) for (var vq = 0; vq < van.length; vq++) van[vq].mesh.rotation.z = van[vq].spec.amp * Math.sin(time * 2.2 + van[vq].spec.phase);
          rec.group.visible = true;
        } else {
          y = g.y0 + (rec.inner.userData.lift || 0.5);
          rec.group.visible = (zc - g.len / 2) < front - 0.1;                // drives out of the picture
        }
        rec.group.position.set(cx, y, zc);
      }
    }

    // ----------------------------------------------------------------------------- FX particles
    var fx = [];
    function pushFx(p) { if (fx.length >= Q.fx) fx.shift(); fx.push(p); }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    var CONFETTI = ['#ff4d4d', '#ffd23f', '#4dc7ff', '#5be37d', '#c77dff', '#ff9f43'];
    var BREAKC = { wood: ['#c58a48', '#9a6a33', '#e0b070'], steel: ['#e0592e', '#a8401f', '#ff8a5a'], road: ['#4c4c56', '#707080'], steelroad: ['#6d8398', '#8fa4b8'], rope: ['#8a6a45', '#5b452b'], cable: ['#b6bfc9', '#8d99a6'], spring: ['#37b24d', '#8be0a0'], hydraulic: ['#f0b429', '#cfd5dc'], rail: ['#544b43', '#bfc5cc'], concrete: ['#a9aeb6', '#7f858d'] };
    function spawnBreak(x, y, m) {
      var cols = BREAKC[m] || BREAKC.wood, n = 16, i;
      for (i = 0; i < n; i++) pushFx({ k: 'chip', x: x + rnd(-0.2, 0.2), y: y + rnd(-0.2, 0.2), z: rnd(-1.4, 1.4), vx: rnd(-4, 4), vy: rnd(1, 7), vz: rnd(-1.5, 1.5), r: rnd(0, 6), vr: rnd(-12, 12), s: rnd(0.12, 0.4), life: rnd(1.0, 1.9), max: 1.9, c: U.hex(cols[(Math.random() * cols.length) | 0]), g: 1 });
      for (i = 0; i < 7; i++) pushFx({ k: 'dust', x: x + rnd(-0.3, 0.3), y: y + rnd(-0.2, 0.3), z: rnd(-1, 1), vx: rnd(-0.9, 0.9), vy: rnd(0.1, 0.9), vz: rnd(-0.5, 0.5), r: 0, vr: 0, s: rnd(0.3, 0.6), life: rnd(0.7, 1.3), max: 1.3, c: [0.85, 0.82, 0.76], g: -0.03 });
      if (m === 'steel' || m === 'steelroad' || m === 'cable') for (i = 0; i < 12; i++) pushFx({ k: 'spark', x: x, y: y, z: rnd(-1.2, 1.2), vx: rnd(-7, 7), vy: rnd(-1, 8), vz: rnd(-2, 2), r: 0, vr: 0, s: 0.08, life: rnd(0.25, 0.6), max: 0.6, c: i % 3 ? [1, 0.82, 0.35] : [1, 0.96, 0.76], g: 0.6 });
    }
    function spawnSplash(x, y) {
      var lvl = st.level, wy = lvl && isNum(lvl.water) ? lvl.water : y, i;
      var lava = st.theme && st.theme.t.lava;
      for (i = 0; i < 22; i++) pushFx({ k: 'drop', x: x + rnd(-0.5, 0.5), y: wy + 0.05, z: rnd(-1.5, 1.5), vx: rnd(-2.6, 2.6), vy: rnd(2.5, 7.5), vz: rnd(-1, 1), r: 0, vr: 0, s: rnd(0.12, 0.26), life: rnd(0.8, 1.4), max: 1.4, c: lava ? (i % 3 ? [1, 0.55, 0.1] : [1, 0.85, 0.3]) : (i % 3 ? [0.9, 0.97, 1] : [0.56, 0.83, 0.97]), g: 1, water: wy });
      for (i = 0; i < 5; i++) pushFx({ k: 'dust', x: x + rnd(-0.5, 0.5), y: wy + 0.1, z: rnd(-1, 1), vx: rnd(-0.6, 0.6), vy: rnd(0.2, 0.8), vz: 0, r: 0, vr: 0, s: rnd(0.3, 0.5), life: rnd(0.5, 0.9), max: 0.9, c: lava ? [1, 0.7, 0.3] : [1, 1, 1], g: 0 });
    }
    function spawnConfetti() {
      var lvl = st.level; if (!lvl) return;
      var routes = BB.routesOf ? BB.routesOf(lvl) : [{ flagX: lvl.flagX }];
      routes.forEach(function (rt) {
        var lastSt = rt.stations && rt.stations.length ? rt.stations[rt.stations.length - 1] : null;
        var y = (lastSt && isFinite(lastSt.y) ? lastSt.y : W3.surfaceAt(lvl.ground, rt.flagX)) + 5.6, i;
        for (i = 0; i < 20; i++) pushFx({ k: 'conf', x: rt.flagX + 1 + rnd(-0.6, 0.6), y: y + rnd(-0.3, 0.3), z: rnd(-2.5, -1.5), vx: rnd(-3.2, 3.2), vy: rnd(2, 6), vz: rnd(-1, 1), r: rnd(0, 6), vr: rnd(-9, 9), s: rnd(0.16, 0.28), life: rnd(1.8, 2.8), max: 2.8, c: U.hex(CONFETTI[(Math.random() * CONFETTI.length) | 0]), g: 0.3 });
      });
    }
    function spawnCrash(index) {
      var sim = st.sim, v = sim && sim.vehicles ? sim.vehicles[index] : null;
      if (!v || !v.pose || !isNum(v.pose.x)) return;
      if (st.level && isNum(st.level.water) && v.pose.y < st.level.water) return;
      for (var i = 0; i < 9; i++) pushFx({ k: 'dust', x: v.pose.x + rnd(-1, 1), y: v.pose.y + rnd(0, 1), z: rnd(-1, 1), vx: rnd(-0.8, 0.8), vy: rnd(0.3, 1.2), vz: 0, r: 0, vr: 0, s: rnd(0.5, 0.9), life: rnd(0.8, 1.5), max: 1.5, c: [0.75, 0.71, 0.66], g: -0.03 });
    }
    function addEvents(events) {
      if (!events || !events.length) return;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (!e || typeof e !== 'object') continue;
        try {
          if (e.type === 'break' && isNum(e.x) && isNum(e.y)) spawnBreak(e.x, e.y, e.m);
          else if (e.type === 'splash' && isNum(e.x) && isNum(e.y)) spawnSplash(e.x, e.y);
          else if (e.type === 'finish') spawnConfetti();
          else if (e.type === 'crash' && isNum(e.index)) spawnCrash(e.index);
        } catch (err) { /* effects must never break the game */ }
      }
    }
    function updateFx(dt) {
      var g = st.level && st.level.ground, water = st.level && isNum(st.level.water) ? st.level.water : null;
      for (var i = fx.length - 1; i >= 0; i--) {
        var p = fx[i];
        p.life -= dt;
        var dead = p.life <= 0;
        if (!dead) {
          p.vy -= 9.81 * p.g * dt;
          if (p.k === 'dust') { p.vx *= 1 - 1.5 * dt; p.vy *= 1 - 1.5 * dt; }
          if (p.k === 'conf') { p.vx *= 1 - 1.2 * dt; p.vy = Math.max(p.vy, -1.6); }
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.r += p.vr * dt;
          if (p.k === 'drop') { if (p.vy < 0 && p.y < p.water) dead = true; }
          else if (p.k === 'chip' || p.k === 'spark' || p.k === 'conf') {
            if (water !== null && p.y < water) { p.vx *= 1 - 3 * dt; p.vy = Math.max(p.vy, -1); p.vr *= 1 - 3 * dt; }
            if (g) {
              var sy = W3.surfaceAt(g, p.x);
              if (p.y < sy && p.y > sy - 1.5) { p.y = sy; p.vy *= -0.3; p.vx *= 0.55; p.vr *= 0.5; if (p.k === 'spark') dead = true; }
            }
          }
        }
        if (dead) { fx[i] = fx[fx.length - 1]; fx.pop(); }
      }
    }
    function emitFx() {
      for (var i = 0; i < fx.length; i++) {
        var p = fx[i], a = clamp(p.life / p.max, 0, 1);
        var s = p.s * (p.k === 'dust' ? (1 + (1 - a) * 1.6) * (0.4 + a * 0.6) : p.k === 'spark' ? 1 : Math.min(1, a * 3));
        put(fxSet, p.x, p.y, p.z, p.r, s, p.k === 'spark' ? s * 0.5 : s, s, p.c);
      }
    }

    // ----------------------------------------------------------------------------- camera per frame
    function applyCamera(scn, dt) {
      var cam = scn.camera, mode = scn.mode || 'build';
      var tv = viewFor(mode), target = tv;
      var chase = false;
      if (scn.chase && mode === 'test' && scn.sim && scn.sim.vehicles) {
        // follow the front-most vehicle that is still driving
        var best = null;
        for (var i = 0; i < scn.sim.vehicles.length; i++) {
          var v = scn.sim.vehicles[i];
          if (!v || v.state === 'waiting' || v.removed || v.visible === false) continue;
          if (!best || (v.state === 'driving' && best.state !== 'driving') || (v.state === best.state && v.pose.x > best.pose.x)) best = v;
        }
        if (best && best.pose && isNum(best.pose.x)) {
          chase = true;
          var L = (best.def && best.def.length) || 4;
          var ck = 1 - Math.exp(-4.2 * dt);
          if (!chaseCam) chaseCam = { x: best.pose.x + 2, y: best.pose.y + 1, zoom: cam.zoom };
          var dOff = clamp(L * 3.4, 30, 62) * 0.03; chaseCam.x += (best.pose.x + 2.5 - chaseCam.x) * ck; chaseCam.y += (best.pose.y - dOff - chaseCam.y) * ck;
          var dwant = clamp(L * 3.4, 30, 62), zwant = (H / 2) / (dwant * TAN_H);
          chaseCam.zoom += (zwant - chaseCam.zoom) * ck;
          target = { pitch: 0.27, yaw: 0.58 };
          cam = chaseCam;
        }
      }
      if (!chase) chaseCam = null;
      var vk = 1 - Math.exp(-5 * dt);
      viewCur.pitch += (target.pitch - viewCur.pitch) * vk; viewCur.yaw += (target.yaw - viewCur.yaw) * vk;
      placeCamera(cam, viewCur, cur);
      camera.position.set(cur.cx, cur.cy, cur.cz);
      camera.up.set(0, 1, 0);
      camera.lookAt(cur.tx, cur.ty, cur.tz);
      camera.fov = FOV; camera.aspect = W / H;
      camera.near = Math.max(0.6, cur.d * 0.06); camera.far = cur.d * 9 + 600;
      camera.updateProjectionMatrix();
      if (scene.fog) { scene.fog.near = cur.d * 0.9; scene.fog.far = cur.d * 4.6 + 120; }
      // sun + shadow frustum follow the picture
      var hw = Math.min(160, (W / cam.zoom) * 0.62 + 12) * 1.15;
      sun.position.set(cur.tx - 26, cur.ty + 42, cur.tz + 34);
      sun.target.position.set(cur.tx, cur.ty, 0);
      var sc = sun.shadow.camera;
      sc.left = -hw; sc.right = hw; sc.top = hw * 0.8; sc.bottom = -hw * 0.8; sc.near = 1; sc.far = 220;
      sc.updateProjectionMatrix();
      return cam;
    }

    // ----------------------------------------------------------------------------- overlay (2D)
    var gridCache = { key: '', pts: [] };
    function validGrid(level) {
      var zs = (BB.Bridge && BB.Bridge.zonesOf) ? BB.Bridge.zonesOf(level) : null;
      var key = st.sig + '|' + JSON.stringify(zs);
      if (gridCache.key === key) return gridCache.pts;
      var pts = [];
      if (zs && BB.Bridge && BB.Bridge.checkNode) {
        var seen = Object.create(null);
        zs.forEach(function (z) {
          for (var x = Math.ceil(z.x0); x <= z.x1; x++) for (var y = Math.ceil(z.y0); y <= z.y1; y++) {
            var k = x + ',' + y;
            if (seen[k]) continue; seen[k] = 1;
            if (!BB.Bridge.checkNode(level, x, y)) pts.push([x, y]);
          }
        });
      }
      gridCache = { key: key, pts: pts };
      return pts;
    }
    var PRE_COL = { road: '#4c4c56', steelroad: '#7a8ea3', wood: '#c58a48', steel: '#e0592e', rope: '#8a6a45', cable: '#b6bfc9', spring: '#37b24d', hydraulic: '#f0b429', rail: '#7d746b', concrete: '#a9aeb6' };

    function tag(x, y, text, bg, fg, font) {
      octx.font = font || '700 14px system-ui, sans-serif';
      var w = octx.measureText(text).width + 14, h = 24;
      octx.fillStyle = bg; octx.beginPath();
      var rx = x - w / 2, ry = y - h / 2, r = 8;
      octx.moveTo(rx + r, ry); octx.arcTo(rx + w, ry, rx + w, ry + h, r); octx.arcTo(rx + w, ry + h, rx, ry + h, r); octx.arcTo(rx, ry + h, rx, ry, r); octx.arcTo(rx, ry, rx + w, ry, r); octx.closePath();
      octx.fill();
      octx.fillStyle = fg; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillText(text, x, y + 1);
    }
    function fmtLen(l) { return (Math.round(l * 10) / 10).toString().replace('.', ',') + ' m'; }

    function drawOverlay(scn) {
      var k = overlay.width / W;
      octx.setTransform(k, 0, 0, k, 0, 0);
      octx.clearRect(0, 0, W, H);
      octx.fillStyle = 'rgba(0,0,0,0.01)'; octx.fillRect(0, 0, 1, 1);   // keeps the layer 'dirty' so that a cleared frame is really presented
      var level = scn.level;
      if (!level) return;
      var mode = scn.mode || 'build', P = function (x, y) { return project(cur, x, y, BEAM_Z); };
      var pxPerM = cur.focal / cur.d;
      // scene view: no dot grid. Only the build area is hinted (frame) and the anchors get a thin ring.
      if (scn.showGrid && mode !== 'test' && mode !== 'leveledit' && pxPerM >= 6) {
        var bd = level.build, zs = level.zones;
        if (bd && !(zs && zs.length)) {
          var c1 = P(bd.minX, bd.maxY), c2 = P(bd.maxX, bd.maxY), c3 = P(bd.maxX, bd.minY), c4 = P(bd.minX, bd.minY);
          if (c1 && c2 && c3 && c4) {
            octx.beginPath(); octx.moveTo(c1[0], c1[1]); octx.lineTo(c2[0], c2[1]); octx.lineTo(c3[0], c3[1]); octx.lineTo(c4[0], c4[1]); octx.closePath();
            octx.setLineDash([10, 8]); octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.4)'; octx.stroke(); octx.setLineDash([]);
          }
        }
        octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.8)';
        var an = (level.anchors || []).concat((scn.bridge && scn.bridge.found) || []);
        for (var a = 0; a < an.length; a++) {
          var q = P(an[a][0], an[a][1]);
          if (!q || q[0] < -20 || q[0] > W + 20 || q[1] < -20 || q[1] > H + 20) continue;
          octx.beginPath(); octx.arc(q[0], q[1], Math.max(7, pxPerM * 0.42), 0, 6.2832); octx.stroke();
        }
      }
      // debug display: load of every beam in percent
      if (scn.debug && mode === 'test' && scn.sim && scn.sim.beams) {
        octx.font = '700 11px ui-monospace, Consolas, monospace'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.lineJoin = 'round';
        var sb = scn.sim.beams;
        for (var di = 0; di < sb.length; di++) {
          var b = sb[di];
          if (!b || b.broken || b.debris || !b.a || !b.b || !isNum(b.stress) || b.stress < 0.02) continue;
          var dq = P((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2); if (!dq) continue;
          var dt2 = String(Math.round(b.stress * 100));
          octx.lineWidth = 3; octx.strokeStyle = 'rgba(10,22,44,0.9)'; octx.strokeText(dt2, dq[0], dq[1]); octx.fillStyle = '#fff'; octx.fillText(dt2, dq[0], dq[1]);
        }
      }
      // hydraulic phase badges
      if (mode === 'build' && scn.bridge && scn.bridge.beams) {
        var bs = scn.bridge.beams;
        for (var h = 0; h < bs.length; h++) {
          if (!(BB.MATERIALS[bs[h].m] && BB.MATERIALS[bs[h].m].hyd)) continue;
          var mp = P((bs[h].x1 + bs[h].x2) / 2, (bs[h].y1 + bs[h].y2) / 2);
          if (!mp) continue;
          var ph = bs[h].ph || ['hold', 'out'];
          tag(mp[0], mp[1] - Math.max(18, pxPerM * 0.9), ph.map(function (x) { return x === 'out' ? '↑' : x === 'in' ? '↓' : '–'; }).join(' '), 'rgba(240,180,41,0.96)', '#2a2108', '800 13px system-ui, sans-serif');
        }
      }
      // delete highlight
      if (scn.deleteHighlight !== null && scn.deleteHighlight !== undefined && scn.bridge && scn.bridge.beams) {
        var db = scn.bridge.beams[scn.deleteHighlight];
        if (db) {
          var d1 = P(db.x1, db.y1), d2 = P(db.x2, db.y2);
          if (d1 && d2) {
            octx.lineCap = 'round';
            octx.strokeStyle = 'rgba(255,45,45,' + (0.45 + 0.15 * Math.sin(scn.time * 8)) + ')'; octx.lineWidth = Math.max(10, pxPerM * 0.8);
            octx.beginPath(); octx.moveTo(d1[0], d1[1]); octx.lineTo(d2[0], d2[1]); octx.stroke();
            octx.strokeStyle = '#fff'; octx.lineWidth = 2.2; octx.setLineDash([7, 5]); octx.stroke(); octx.setLineDash([]);
          }
        }
      }
      // v3.4: numbered flags, vehicle silhouettes at the start
      if (BB.Overlay && BB.Overlay.drawRoutes) BB.Overlay.drawRoutes(octx, function (x, y) { return P(x, y) || [-9999, -9999]; }, pxPerM, level, { lines: false, preview: mode === 'build', sim: mode === 'test' ? scn.sim : null, hide: !!st.hideFlags });
      // selection, ghosts of moved / pasted / traced parts (shared with the other renderers)
      if (scn.overlay && BB.Overlay) BB.Overlay.draw(octx, function (x, y) { return P(x, y) || [-9999, -9999]; }, pxPerM, scn.overlay, scn.time);
      // beam preview while dragging
      var pv = scn.preview;
      if (pv && isNum(pv.x1) && isNum(pv.x2)) {
        var a1 = P(pv.x1, pv.y1), a2 = P(pv.x2, pv.y2);
        if (a1 && a2) {
          octx.lineCap = 'round';
          if (pv.valid) {
            octx.strokeStyle = 'rgba(20,40,70,0.35)'; octx.lineWidth = Math.max(9, pxPerM * 0.56) + 4;
            octx.beginPath(); octx.moveTo(a1[0], a1[1]); octx.lineTo(a2[0], a2[1]); octx.stroke();
            octx.strokeStyle = PRE_COL[pv.m] || '#ddd'; octx.lineWidth = Math.max(9, pxPerM * 0.56); octx.globalAlpha = 0.82;
            octx.beginPath(); octx.moveTo(a1[0], a1[1]); octx.lineTo(a2[0], a2[1]); octx.stroke(); octx.globalAlpha = 1;
            octx.fillStyle = '#fff'; octx.strokeStyle = '#1d2a38'; octx.lineWidth = 2.5;
            [a1, a2].forEach(function (q) { octx.beginPath(); octx.arc(q[0], q[1], Math.max(6, pxPerM * 0.2), 0, 6.2832); octx.fill(); octx.stroke(); });
          } else {
            octx.strokeStyle = '#ff3b30'; octx.lineWidth = Math.max(5, pxPerM * 0.3); octx.setLineDash([10, 7]);
            octx.beginPath(); octx.moveTo(a1[0], a1[1]); octx.lineTo(a2[0], a2[1]); octx.stroke(); octx.setLineDash([]);
            octx.beginPath(); octx.arc(a2[0], a2[1], 12, 0, 6.2832); octx.stroke();
          }
          var len = isNum(pv.length) ? pv.length : Math.hypot(pv.x2 - pv.x1, pv.y2 - pv.y1);
          var mx = (a1[0] + a2[0]) / 2, my = (a1[1] + a2[1]) / 2, nx = -(a2[1] - a1[1]), ny = (a2[0] - a1[0]), nl = Math.hypot(nx, ny) || 1;
          nx /= nl; ny /= nl; if (ny > 0) { nx = -nx; ny = -ny; }
          tag(mx + nx * 28, my + ny * 28, fmtLen(len), pv.valid ? 'rgba(255,255,255,0.96)' : '#ff3b30', pv.valid ? '#1d2a38' : '#fff');
        }
      }
      // hover node
      if (scn.hoverNode && isNum(scn.hoverNode[0])) {
        var hp = P(scn.hoverNode[0], scn.hoverNode[1]);
        if (hp) {
          var hr = Math.max(13, 0.62 * pxPerM) * (1 + 0.08 * Math.sin(scn.time * 6));
          octx.beginPath(); octx.arc(hp[0], hp[1], hr, 0, 6.2832);
          octx.fillStyle = 'rgba(255,255,255,0.2)'; octx.fill();
          octx.lineWidth = 5; octx.strokeStyle = 'rgba(20,40,70,0.45)'; octx.stroke();
          octx.lineWidth = 3; octx.strokeStyle = '#ffd84a'; octx.stroke();
        }
      }
      // foundation ghost: a block from the node down to the ground, green = valid, red = invalid (with the reason)
      if (scn.hoverFoundation) {
        var hf = scn.hoverFoundation, hSurf = isNum(hf[4]) ? hf[4] : hf[1] - 1.2, hBot = Math.min(hSurf, hf[1] - 0.3);
        var f1 = P(hf[0] - 0.85, hf[1]), f2 = P(hf[0] + 0.85, hBot);
        if (f1 && f2) {
          octx.fillStyle = hf[2] ? 'rgba(90,220,140,0.5)' : 'rgba(255,70,60,0.5)';
          octx.strokeStyle = hf[2] ? '#eafff1' : '#ff3b30'; octx.lineWidth = 2.5;
          octx.fillRect(f1[0], f1[1], f2[0] - f1[0], f2[1] - f1[1]); octx.strokeRect(f1[0], f1[1], f2[0] - f1[0], f2[1] - f1[1]);
          var fp = P(hf[0], hf[1]); if (fp) { octx.beginPath(); octx.arc(fp[0], fp[1], 8, 0, 6.2832); octx.fillStyle = '#fff'; octx.fill(); }
          if (!hf[2] && hf[3]) { octx.beginPath(); octx.moveTo(f1[0] + 5, f1[1] + 5); octx.lineTo(f2[0] - 5, f2[1] - 5); octx.moveTo(f2[0] - 5, f1[1] + 5); octx.lineTo(f1[0] + 5, f2[1] - 5); octx.stroke(); }
          tag((f1[0] + f2[0]) / 2, f1[1] - 26, hf[2] ? 'Fundament setzen' : (hf[3] || 'Hier nicht möglich'), hf[2] ? 'rgba(46,160,96,0.95)' : 'rgba(210,60,50,0.95)', '#fff', '700 13px system-ui, sans-serif');
        }
      }
      // level editor: zone being dragged
      if (mode === 'leveledit' && scn.leveledit && scn.leveledit.rect) {
        var rc = scn.leveledit.rect, c1 = P(rc.x0, rc.y0), c2 = P(rc.x1, rc.y0), c3 = P(rc.x1, rc.y1), c4 = P(rc.x0, rc.y1);
        if (c1 && c2 && c3 && c4) {
          octx.beginPath(); octx.moveTo(c1[0], c1[1]); octx.lineTo(c2[0], c2[1]); octx.lineTo(c3[0], c3[1]); octx.lineTo(c4[0], c4[1]); octx.closePath();
          octx.fillStyle = 'rgba(80,170,255,0.25)'; octx.fill();
          octx.setLineDash([9, 6]); octx.lineWidth = 3; octx.strokeStyle = '#fff'; octx.stroke(); octx.setLineDash([]);
        }
      }
      // level editor handles
      if (mode === 'leveledit' && scn.leveledit) {
        var g = level.ground, le = scn.leveledit;
        if (Array.isArray(g)) {
          var active = le.tool === 'terrain' || le.tool === 'erase', hv = isNum(le.hoverVertex) ? le.hoverVertex : -1, r = active ? 6.5 : 4.5;
          octx.globalAlpha = active ? 1 : 0.6; octx.beginPath();
          for (var gi = 0; gi < g.length; gi++) {
            if (gi === hv || !g[gi]) continue;
            var gp = project(cur, g[gi][0], g[gi][1], W3.terrFront(level) - 0.05);
            if (!gp || gp[0] < -20 || gp[0] > W + 20 || gp[1] < -20 || gp[1] > H + 20) continue;
            octx.moveTo(gp[0] + r, gp[1]); octx.arc(gp[0], gp[1], r, 0, 6.2832);
          }
          octx.fillStyle = '#fff'; octx.fill(); octx.lineWidth = 2.5; octx.strokeStyle = '#1d2a38'; octx.stroke(); octx.globalAlpha = 1;
          if (hv >= 0 && g[hv]) {
            var hq = project(cur, g[hv][0], g[hv][1], W3.terrFront(level) - 0.05);
            if (hq) {
              octx.beginPath(); octx.arc(hq[0], hq[1], 11, 0, 6.2832); octx.fillStyle = le.tool === 'erase' ? '#ff3b30' : '#ff9f1c'; octx.fill();
              octx.lineWidth = 5; octx.strokeStyle = 'rgba(20,40,70,0.5)'; octx.stroke(); octx.lineWidth = 3; octx.strokeStyle = '#fff'; octx.stroke();
            }
          }
        }
      }
    }

    // ----------------------------------------------------------------------------- frame
    var frameTimes = [], lowT = 0, highT = 0, fpsAvg = 60;
    function adaptResolution(dtReal) {
      frameTimes.push(dtReal);
      if (frameTimes.length > 40) frameTimes.shift();
      var avg = 0; for (var i = 0; i < frameTimes.length; i++) avg += frameTimes[i];
      avg /= frameTimes.length; fpsAvg = 1 / Math.max(0.001, avg);
      if (frameTimes.length < 30) return;
      if (avg > 0.026) { lowT += dtReal; highT = 0; } else if (avg < 0.0185) { highT += dtReal; lowT = 0; } else { lowT = 0; highT = 0; }
      if (lowT > 1.6 && resScale > 0.55) { resScale = Math.max(0.55, resScale * 0.85); lowT = 0; frameTimes.length = 0; sizeKey = ''; }
      else if (highT > 5 && resScale < 1) { resScale = Math.min(1, resScale * 1.12); highT = 0; frameTimes.length = 0; sizeKey = ''; }
    }
    var realLast = 0;

    function draw(scn) {
      if (!scn || lost) return;
      checkSize();
      var level = scn.level || (scn.sim && scn.sim.level) || null;
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var dtReal = realLast ? (now - realLast) / 1000 : 0.016; realLast = now;
      if (dtReal > 0.25) dtReal = 0.016;
      adaptResolution(dtReal);
      var time = isNum(scn.time) ? scn.time : 0;
      var dt = lastTime === null ? 0 : time - lastTime; if (!(dt >= 0) || dt > 0.2) dt = 0; lastTime = time;
      if (!level || !level.ground) {
        octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height);
        renderer.render(scene, camera);
        return;
      }
      ensureStatic(level);
      var mode = scn.mode || 'build';
      var sim = mode === 'test' && scn.sim ? scn.sim : null;
      if (sim !== st.sim) { clearVehicles(); st.sim = sim; if (!sim) fx.length = 0; }
      var cam = applyCamera(scn, dt || 0.016);

      // water, clouds, flags, lamps
      if (st.water) st.water.update(time, st.water.y);
      if (st.gapObj) W3.updateGap(st.gapObj, time);
      for (var c = 0; c < st.clouds.length; c++) {
        var cl = st.clouds[c]; cl.position.x += cl.userData.speed * dt;
        if (cl.position.x > cl.userData.x1) cl.position.x = cl.userData.x0;
      }
      if (st.anim) {
        for (var f = 0; f < st.anim.flags.length; f++) st.anim.flags[f].rotation.y = Math.sin(time * 3 + f) * 0.28 - 0.1;
        var hit = sim && sim._s && sim._s.checkpointHit;
        for (var l = 0; l < st.anim.lamps.length; l++) st.anim.lamps[l].material.color.setHex(hit && hit.has(l) ? 0x35d36a : 0xe8453c);
        var hl = st.anim.holdLamps || [], hold = sim && sim._s ? sim._s.holdActive : true;
        for (var hq = 0; hq < hl.length; hq++) hl[hq].material.color.setHex(hold ? 0xe8453c : 0x35d36a);
      }
      // zones only while building
      st.staticGroup.traverse(function (o) { if (o.userData && o.userData.zone) o.visible = mode !== 'test'; });

      // dynamic geometry
      var showStress = !!scn.showStress && mode === 'test';
      var found = sim ? sim.found : (scn.bridge && scn.bridge.found);
      syncFoundations(level, found);
      if (sim) collectSim(level, sim, showStress, time); else collectBuild(level, scn.bridge, false, time, scn.quick);
      // pistons
      if (sim && sim._s && sim._s.pistons) {
        sim._s.pistons.forEach(function (p) { emitPiston(p.pivot.x, p.pivot.y, p.head.x, p.head.y, p.minLen); });
      } else if (Array.isArray(level.pistons)) {
        level.pistons.forEach(function (d) {
          var rad = (+d.angleDeg || 0) * Math.PI / 180, len = isNum(d.startLen) ? d.startLen : (d.minLen || 1);
          emitPiston(d.pivotX, d.pivotY, d.pivotX + Math.cos(rad) * len, d.pivotY + Math.sin(rad) * len, d.minLen || 1);
        });
      }
      if (sim) {
        syncVehicles(sim, time);
        var cg = sim._s && sim._s.cargo ? sim._s.cargo : [];
        var cn = 0, ca = crateSet.mesh.instanceMatrix.array, cm = new THREE.Matrix4();
        for (var q = 0; q < cg.length && cn < crateSet.cap; q++) {
          var cp = cg[q].p;
          if (!cp || !cp.on) continue;
          var ang = cg[q].vehicle && cg[q].vehicle.pose ? cg[q].vehicle.pose.angle : 0;
          cm.makeRotationZ(ang); cm.setPosition(cp.x, cp.y, (q % 2 ? 0.45 : -0.45));
          cm.toArray(ca, cn * 16); cn++;
        }
        crateSet.mesh.count = cn; crateSet.mesh.instanceMatrix.needsUpdate = true;
      } else {
        crateSet.mesh.count = 0;
      }
      syncGates(level, sim, time);
      updateFx(dt); emitFx();
      updateWeather(time, dt, cam);
      updateStreaks(time, cam, isNum(level.wind) ? level.wind : 0);
      flush(boxSet); flush(cylSet); flush(sphSet); flush(fxSet);

      renderer.render(scene, camera);
      drawOverlay(scn);
      R3.debug = { frames: ((R3.debug && R3.debug.frames) || 0) + 1, t: time, mode: mode, showGrid: scn.showGrid, overlayW: overlay.width, W: W, k: overlay.width / W };
    }

    function setQuality(q) {
      if (!QUALITY[q] || q === quality) return;
      quality = q; Q = QUALITY[q];
      renderer.shadowMap.enabled = !!Q.shadows;
      sun.castShadow = !!Q.shadows;
      if (Q.shadows) {
        sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
      scene.traverse(function (o) { if (o.material) { var ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(function (m) { m.needsUpdate = true; }); } });
      st.sig = '';          // rebuild decor with the new detail level
      resScale = 1; sizeKey = ''; frameTimes.length = 0;
    }

    resize();

    return {
      is3d: true, canvas: overlay, glCanvas: glCanvas,
      resize: resize, draw: draw, worldToScreen: worldToScreen, screenToWorld: screenToWorld, fitCamera: fitCamera,
      addEvents: addEvents, clearEffects: function () { fx.length = 0; },
      setQuality: setQuality, get quality() { return quality; },
      get fps() { return fpsAvg; }, get resScale() { return resScale; }, get lost() { return lost; },
      get width() { return W; }, get height() { return H; },
      info: function () { return renderer.info.render; },
      /** hides / shows the water or the road / rail scenery (used by tools/render_check.js to see what they contribute) */
      debugHide: function (what, hide) {
        if (what === 'water' && st.water) { st.water.surface.visible = !hide; st.water.front.visible = !hide; }
        if (what === 'gap' && st.gapObj) st.gapObj.group.visible = !hide;
        if (what === 'flags') { st.hideFlags = !!hide; ((st.anim && st.anim.flagObjs) || []).forEach(function (o) { o.visible = !hide; }); }
      },
      /** what the scene graph holds right now (used by tools/render_check.js) */
      debug: function () {
        return {
          water: st.water ? { visible: !!(st.water.surface.visible && st.water.front.visible && st.water.surface.parent), y: st.water.y, lava: !!st.water.lava } : null,
          gap: st.gapObj ? { kind: st.gapObj.gap, children: st.gapObj.group.children.length, ambient: st.gapObj.ambient.length, ambientVisible: st.gapObj.ambient.filter(function (a) { return a.holder.visible; }).length } : null,
          terrain: !!st.terr,
        };
      },
    };
  }

  BB.Render3D = { create: create, supported: supported, QUALITY: QUALITY };
})(globalThis.BB = globalThis.BB || {});
