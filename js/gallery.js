/*
 * Brückenbauer – gallery.js (v3.4)
 * ----------------------------------------------------------------------------
 * Model gallery (Testlabor → "Modellgalerie"): every 3D model of the game – vehicles, ships, flags, towers, plants – on a small turntable,
 * turned with a finger / the mouse, seen from the side, at an angle or from the front. Vehicles walk / roll so that the animated
 * parts (legs, tails, oars, wheels) can be checked. Needs WebGL; without it only the list of models exists.
 *
 *   BB.Gallery.items()            → [{ key, group, name, epoch }]  (no WebGL needed)
 *   BB.Gallery.open({ focus, view, host })  → controller { show(key, view), setSize(w, h), close(), canvas }
 */
(function (BB) {
  'use strict';

  var EPOCH_NAME = { classic: 'Klassisch', steinzeit: 'Steinzeit', antike: 'Antike', mittelalter: 'Mittelalter', industrie: 'Industrialisierung', moderne: 'Moderne' };
  var EPOCH_ORDER = ['steinzeit', 'antike', 'mittelalter', 'industrie', 'moderne', 'classic'];
  var CLASSIC_VEH = ['bike', 'motorcycle', 'car', 'bus', 'truck', 'tanker', 'crane', 'train'];
  var THEME_OF = { steinzeit: 'stone', antike: 'antique', mittelalter: 'medieval', industrie: 'industry', moderne: 'modern' };

  function items() {
    var out = [], T = BB.TIME, k;
    Object.keys(BB.VEHICLES || {}).forEach(function (key) {
      var d = BB.VEHICLES[key];
      var ep = d.epoch || (CLASSIC_VEH.indexOf(key) >= 0 ? 'classic' : 'classic');
      out.push({ key: 'v:' + key, group: 'Fahrzeuge', name: d.name || key, epoch: ep });
    });
    out.push({ key: 's:ship', group: 'Schiffe', name: 'Frachter', epoch: 'classic' });
    if (T && T.SHIPS) Object.keys(T.SHIPS).forEach(function (key) { out.push({ key: 's:' + key, group: 'Schiffe', name: T.SHIPS[key].name, epoch: T.SHIPS[key].epoch }); });
    [['classic', 'Fahne (klassisch)'], ['steinzeit', 'Fahne: Fellbanner'], ['antike', 'Fahne: Wimpel'], ['mittelalter', 'Fahne: Banner']].forEach(function (a) { out.push({ key: 'f:' + a[0], group: 'Fahnen', name: a[1], epoch: a[0] === 'classic' ? 'classic' : a[0] }); });
    [['tree', 'Turm: Riesenbaum', 'steinzeit'], ['antique', 'Turm: Säulenturm', 'antike'], ['medieval', 'Turm: Steinturm', 'mittelalter'], ['industry', 'Turm: Eisengitterturm', 'industrie'], ['modern', 'Turm: Betonpylon', 'moderne']].forEach(function (a) { out.push({ key: 't:' + a[0], group: 'Türme', name: a[1], epoch: a[2] }); });
    Object.keys(THEME_OF).forEach(function (ep) { out.push({ key: 'p:' + ep, group: 'Pflanzen', name: 'Pflanzen: ' + EPOCH_NAME[ep], epoch: ep }); });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  function create(host, opts) {
    opts = opts || {};
    var R3 = BB.R3, M = R3 && R3.m, U = R3 && R3.u;
    if (typeof THREE === 'undefined' || !M || !U) return null;
    var canvas = document.createElement('canvas');
    canvas.className = 'gallery-canvas';
    var renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, preserveDrawingBuffer: !!opts.preserve }); } catch (e) { return null; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0xdfe8ef);
    var scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f78, 0.8));
    var sun = new THREE.DirectionalLight(0xfff3dc, 0.7); sun.position.set(-6, 10, 8); scene.add(sun);
    var camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
    var ground = new THREE.Mesh(new THREE.CircleGeometry(9, 40), new THREE.MeshLambertMaterial({ color: 0x86a064 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    var rim = new THREE.Mesh(new THREE.RingGeometry(8.7, 9, 40), new THREE.MeshBasicMaterial({ color: 0x9bab7e }));
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.01; scene.add(rim);
    var st = { key: null, yaw: 0, pitch: 0.12, dist: 14, target: new THREE.Vector3(0, 1.5, 0), auto: true, view: 'side', group: null, anims: [], wheels: [], vessel: null, t: 0, size: 1.0, ground: 0 };

    function mat() { return new THREE.MeshLambertMaterial({ vertexColors: true }); }
    function mesh(geom) { var m = new THREE.Mesh(geom, mat()); m.castShadow = true; return m; }
    function clearGroup() {
      if (st.group) { scene.remove(st.group); st.group.traverse(function (o) { if (o.material) o.material.dispose(); }); }
      st.group = null; st.anims = []; st.wheels = [];
    }
    function addAnims(group, list) { (list || []).forEach(function (a) { var m = mesh(a.geom); m.position.set(a.pivot[0], a.pivot[1], a.pivot[2]); m.scale.set(a.scale, a.scale, a.scale); group.add(m); st.anims.push({ mesh: m, spec: a }); }); }

    function makeVehicle(type) {
      var def = BB.VEHICLES[type], g = new THREE.Group();
      g.add(mesh(M.vehicleBody(type, null)));
      var ax = def.axles || [-1, 1], r = def.wheelRadius || 0.4;
      for (var i = 0; i < ax.length; i++) { var info = M.vehicleWheel(type, r, i); if (!info.geom) continue; var w = mesh(info.geom); w.position.set(ax[i], 0, 0); g.add(w); st.wheels.push({ mesh: w, r: r }); }
      addAnims(g, M.vehicleParts ? M.vehicleParts(type, null) : null);
      g.position.y = r;                                    // the ground is at y = -wheelRadius in the model
      frameOn(g, 2.6);
      return g;
    }
    /** the camera looks at the middle of the whole model (incl. the animals in front of a cart) */
    function frameOn(g, minSize) {
      g.updateMatrixWorld(true);
      var b = new THREE.Box3().setFromObject(g), c = new THREE.Vector3(), sz = new THREE.Vector3();
      b.getCenter(c); b.getSize(sz);
      st.target.set(c.x, c.y, 0);
      st.size = Math.max(minSize || 3, sz.x * 0.78, sz.y * 1.6);
    }
    function makeVessel(key) {
      var g = new THREE.Group(), L = 12, D = 3.4, top = 6, hull = '#8a5a34', cabin = '#e8dcc0', S = BB.TIME && BB.TIME.SHIPS && BB.TIME.SHIPS[key];
      var geo;
      if (S) { L = S.len + 2; D = Math.max(2.2, S.beam); hull = S.hull; cabin = S.cabin; geo = M.vesselGeometry(key, L, D, top, hull, cabin); addAnims(g, M.vesselParts ? M.vesselParts(key, L, D, top, hull) : null); }
      else geo = M.shipGeometry(L, D, top, '#a8523c', '#ece8de');
      g.add(mesh(geo));
      g.rotation.y = 0;
      frameOn(g, 6);
      var wat = new THREE.Mesh(new THREE.CircleGeometry(8.6, 40), new THREE.MeshLambertMaterial({ color: 0x5aa0be, transparent: true, opacity: 0.8 }));
      wat.rotation.x = -Math.PI / 2; wat.position.y = 0.02; g.add(wat);
      st.vessel = g;
      return g;
    }
    function makeFlag(ep) {
      var g = new THREE.Group(), style = { steinzeit: 'stone', antike: 'antique', mittelalter: 'medieval' }[ep] || null;
      [['plain', '#e8453c', -2.6], ['goal', '#2e86de', 0], ['check', '#e8453c', 2.6]].forEach(function (a) {
        var pole = mesh(M.flagPole(style).geometry()); pole.position.set(a[2], 0, 0); g.add(pole);
        var cloth = new THREE.Mesh(M.flagCloth(a[1], a[0], style).geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); cloth.position.set(a[2], 0, 0); g.add(cloth);
      });
      st.size = 5; st.target.set(0, 2.6, 0);
      return g;
    }
    function makeTower(style) {
      var g = new THREE.Group();
      g.add(mesh(M.pylonGeometry(9, 1.0, 1.4, style === 'modern' ? null : style)));
      st.size = 11; st.target.set(0, 5.5, 0);
      return g;
    }
    function makePlants(ep) {
      var g = new THREE.Group(), T = U.themeFor({ world: ep }).t;
      for (var i = 0; i < 5; i++) {
        var P = M.treeParts(T.trees, 11 + i * 7, T.treeCols, T.trunk, 1 + (i % 3) * 0.25);
        var m = mesh(P.geometry()); m.position.set(-5 + i * 2.5, 0, (i % 2) * 1.2 - 0.6); g.add(m);
      }
      var rock = mesh(M.rockParts(7, T.rock, 1.2).geometry()); rock.position.set(0, 0, 3); g.add(rock);
      st.size = 9; st.target.set(0, 2, 0);
      return g;
    }

    function show(key, view) {
      clearGroup();
      var kind = key.slice(0, 1), id = key.slice(2), g;
      st.key = key; st.vessel = null; st.ground = 0;
      if (kind === 'v') g = makeVehicle(id);
      else if (kind === 's') g = makeVessel(id);
      else if (kind === 'f') g = makeFlag(id);
      else if (kind === 't') g = makeTower(id);
      else g = makePlants(id);
      st.group = g; scene.add(g);
      ground.visible = kind !== 's';
      rim.visible = kind !== 's';
      setView(view || st.view);
    }
    function setView(v) {
      st.view = v;
      if (v === 'side') { st.yaw = 0; st.pitch = 0.08; st.auto = false; }
      else if (v === 'oblique') { st.yaw = -0.62; st.pitch = 0.3; st.auto = false; }
      else if (v === 'front') { st.yaw = -Math.PI / 2; st.pitch = 0.1; st.auto = false; }
      else if (v === 'turn') { st.auto = true; st.pitch = 0.25; }
      st.dist = Math.max(5.5, st.size * 1.9);
    }
    function placeCamera() {
      var cy = Math.cos(st.pitch), sy = Math.sin(st.pitch);
      // yaw 0 = looking at the +z side of the model (the side the game shows)
      camera.position.set(st.target.x + Math.sin(st.yaw) * st.dist * cy, st.target.y + sy * st.dist, st.target.z + Math.cos(st.yaw) * st.dist * cy);
      camera.lookAt(st.target);
    }
    var raf = 0, last = 0, speed = 3.2;
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016; last = ts;
      render(dt);
    }
    var travelled = 0;
    function render(dt) {
      st.t += dt; travelled += dt * speed;
      if (st.auto) st.yaw += dt * 0.5;
      st.wheels.forEach(function (w) { w.mesh.rotation.z = -travelled / w.r; });
      st.anims.forEach(function (a) {
        var sp = a.spec;
        a.mesh.rotation.z = sp.kind === 'swing' ? sp.amp * Math.sin(travelled / sp.stride * 6.2832 + sp.phase) : sp.amp * Math.sin(st.t * 2.4 + sp.phase);
      });
      if (st.vessel) { st.vessel.position.y = Math.sin(st.t * 1.7) * 0.08; st.vessel.rotation.z = Math.sin(st.t * 1.3) * 0.03; }
      placeCamera();
      renderer.render(scene, camera);
    }
    function setSize(w, h) { renderer.setSize(w, h, false); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; camera.aspect = w / h; camera.updateProjectionMatrix(); }
    // drag = turn, wheel / pinch = zoom
    var drag = null, pinch = null;
    canvas.addEventListener('pointerdown', function (e) { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; st.auto = false; });
    canvas.addEventListener('pointermove', function (e) { if (!drag) return; st.yaw -= (e.clientX - drag.x) * 0.01; st.pitch = Math.max(-0.2, Math.min(1.2, st.pitch + (e.clientY - drag.y) * 0.006)); drag.x = e.clientX; drag.y = e.clientY; });
    canvas.addEventListener('pointerup', function () { drag = null; });
    canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); st.dist = Math.max(3, Math.min(60, st.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
    (host || document.body).appendChild(canvas);
    var ctl = {
      canvas: canvas, renderer: renderer, state: st, show: show, setView: setView, setSize: setSize,
      renderOnce: function (dt) { render(dt || 0); },
      start: function () { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } },
      stop: function () { if (raf) cancelAnimationFrame(raf); raf = 0; },
      freeze: function (distance) { travelled = distance || 0; },
      close: function () { ctl.stop(); clearGroup(); renderer.dispose(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); },
    };
    return ctl;
  }

  /** the dialog of the game: list of models on the left / bottom, the turntable, buttons for the view */
  function open(opts) {
    opts = opts || {};
    var all = items(), esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var root = document.createElement('div');
    root.className = 'gallery';
    root.innerHTML = '<div class="gallery-bar"><button type="button" class="btn btn-white btn-hud" id="gal-close"><span>Schließen</span></button><div class="gallery-title" id="gal-title">Modellgalerie</div>' +
      '<div class="gallery-views"><button type="button" data-v="side" class="btn btn-white btn-hud">Seite</button><button type="button" data-v="oblique" class="btn btn-white btn-hud">Schräg</button><button type="button" data-v="front" class="btn btn-white btn-hud">Vorne</button><button type="button" data-v="turn" class="btn btn-white btn-hud">Drehen</button></div></div>' +
      '<div class="gallery-body"><div class="gallery-stage" id="gal-stage"></div><div class="gallery-list" id="gal-list"></div></div>';
    document.body.appendChild(root);
    var stage = root.querySelector('#gal-stage'), list = root.querySelector('#gal-list'), title = root.querySelector('#gal-title');
    var ctl = create(stage, {});
    if (!ctl) { stage.innerHTML = '<p class="gallery-nogl">Die 3D-Ansicht ist auf diesem Gerät nicht verfügbar.</p>'; }
    var cur = null;
    function select(key) {
      cur = key;
      var it = all.filter(function (x) { return x.key === key; })[0];
      title.textContent = it ? it.name + ' · ' + EPOCH_NAME[it.epoch] : 'Modellgalerie';
      Array.prototype.forEach.call(list.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-key') === key); });
      if (ctl) ctl.show(key, 'side');
    }
    EPOCH_ORDER.forEach(function (ep) {
      var part = all.filter(function (x) { return x.epoch === ep; });
      if (!part.length) return;
      var h = document.createElement('h3'); h.textContent = EPOCH_NAME[ep]; list.appendChild(h);
      part.forEach(function (it) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'gal-item'; b.setAttribute('data-key', it.key);
        b.innerHTML = '<b>' + esc(it.name) + '</b><span>' + esc(it.group) + '</span>';
        b.addEventListener('click', function () { select(it.key); });
        list.appendChild(b);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('.gallery-views button'), function (b) { b.addEventListener('click', function () { if (ctl) ctl.setView(b.getAttribute('data-v')); }); });
    function fit() { if (!ctl) return; var r = stage.getBoundingClientRect(); ctl.setSize(Math.max(200, Math.floor(r.width)), Math.max(200, Math.floor(r.height))); }
    window.addEventListener('resize', fit);
    function close() { window.removeEventListener('resize', fit); if (ctl) ctl.close(); if (root.parentNode) root.parentNode.removeChild(root); }
    root.querySelector('#gal-close').addEventListener('click', close);
    fit();
    if (ctl) ctl.start();
    select(opts.focus && all.some(function (x) { return x.key === opts.focus; }) ? opts.focus : (all[0] && all[0].key));
    if (opts.view && ctl) ctl.setView(opts.view);
    return { show: function (k, v) { select(k); if (v && ctl) ctl.setView(v); }, ctl: ctl, close: close, root: root };
  }

  BB.Gallery = { items: items, open: open, create: create, EPOCH_NAME: EPOCH_NAME };
})(globalThis.BB = globalThis.BB || {});
