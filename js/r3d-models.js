/*
 * Brückenbauer – r3d-models.js
 * ----------------------------------------------------------------------------
 * Low-poly models built directly in code (no model files): vehicles (bike, motorcycle, car, bus, truck, tanker,
 * crane truck, train), the ship, crates, flags, signs, pylons, trees, rocks, clouds.
 * Design rule: clear silhouettes from a few clean shapes, muted colours, windows in a contrasting colour,
 * wheels with rims. Vehicle space: origin = middle of the chassis bottom, x = driving direction, y = up, z = across.
 */
(function (BB) {
  'use strict';

  var R3 = BB.R3 = BB.R3 || {};
  var U = R3.u, Parts = U.Parts, hex = U.hex, shade = U.shade, mix = U.mix;

  var GLASS = '#3b556b', DARK = '#2a2e34', TRIM = '#444a52', CHROME = '#cfd5dc', TIRE = '#2b2e34', RIM = '#cfd4db', HUB = '#8b939d';
  var BODY = { car: '#c2573f', bus: '#d9a441', truck: '#5a8f66', tanker: '#aeb7bd', crane: '#d9a441', train: '#4a6a8a', motorcycle: '#b5483a', bike: '#4a82b5' };

  // ---------------------------------------------------------------------------------------------
  // wheels (one geometry = both wheels of an axle, centred on the axle)
  // ---------------------------------------------------------------------------------------------
  var wheelCache = {};
  function wheelPair(r, track, width, kind) {
    var k = [r.toFixed(2), track.toFixed(2), width.toFixed(2), kind].join('|');
    if (wheelCache[k]) return wheelCache[k];
    var p = new Parts(), zs = [track / 2, -track / 2];
    for (var i = 0; i < 2; i++) {
      var z = zs[i], out = z > 0 ? 1 : -1;
      p.cyl(0, 0, z, r, width, TIRE, { n: 14 });
      p.cyl(0, 0, z + out * (width * 0.5 - 0.02), r * 0.62, 0.06, RIM, { n: 14 });
      p.cyl(0, 0, z + out * (width * 0.5 + 0.01), r * 0.2, 0.07, HUB, { n: 8 });
      p.box(r * 0.36, 0, z + out * (width * 0.5 + 0.02), r * 0.34, r * 0.1, 0.04, HUB);     // spoke marks show the rotation
      p.box(-r * 0.36, 0, z + out * (width * 0.5 + 0.02), r * 0.34, r * 0.1, 0.04, HUB);
    }
    p.cyl(0, 0, 0, r * 0.18, track, '#3a3e45', { n: 6 });
    var g = p.geometry();
    wheelCache[k] = g;
    return g;
  }
  function thinWheel(r, kind) {
    var k = 'thin|' + r.toFixed(2) + kind;
    if (wheelCache[k]) return wheelCache[k];
    var p = new Parts(), w = kind === 'moto' ? 0.16 : 0.08;
    p.cyl(0, 0, 0, r, w, TIRE, { n: 16 });
    p.cyl(0, 0, 0, r * 0.74, w + 0.01, kind === 'moto' ? '#9aa1aa' : '#d5dbe2', { n: 16 });
    p.cyl(0, 0, 0, r * 0.66, w + 0.02, '#eef1f4', { n: 16 });
    p.box(0, 0, 0, r * 1.3, r * 0.07, w + 0.03, '#7b848e'); p.box(0, 0, 0, r * 0.07, r * 1.3, w + 0.03, '#7b848e');
    var g = p.geometry();
    wheelCache[k] = g;
    return g;
  }

  function arches(p, axles, r, halfW, bodyY) {
    for (var i = 0; i < axles.length; i++) {
      p.box(axles[i], bodyY, halfW, r * 2.5, r * 1.5, 0.05, DARK);
      p.box(axles[i], bodyY, -halfW, r * 2.5, r * 1.5, 0.05, DARK);
    }
  }
  function lights(p, front, rear, y, zOff, size) {
    p.box(front, y, zOff, 0.06, size, size * 1.7, '#f5eec8'); p.box(front, y, -zOff, 0.06, size, size * 1.7, '#f5eec8');
    p.box(rear, y, zOff, 0.06, size, size * 1.7, '#b8433a'); p.box(rear, y, -zOff, 0.06, size, size * 1.7, '#b8433a');
  }

  // ---------------------------------------------------------------------------------------------
  // vehicle bodies
  // ---------------------------------------------------------------------------------------------
  function bodyCar(col) {
    var p = new Parts();
    p.box(0, 0.52, 0, 4.2, 0.62, 1.9, col, { top: 0.985 });
    p.box(0.95, 0.86, 0, 1.2, 0.06, 1.8, shade(col, 1.1));                                  // bonnet
    p.box(-0.25, 1.1, 0, 2.15, 0.62, 1.66, col, { top: 0.74, topZ: 0.92 });                  // cabin
    p.box(-0.25, 1.12, 0, 2.0, 0.42, 1.7, GLASS, { top: 0.74, topZ: 0.92 });                  // windows
    p.box(-0.25, 1.46, 0, 1.5, 0.07, 1.5, col);                                              // roof
    p.box(0.78, 1.12, 0.0, 0.05, 0.42, 1.5, GLASS, { rz: -0.5 });                              // windscreen
    arches(p, [-1.35, 1.35], 0.34, 0.955, 0.3);
    p.box(2.13, 0.3, 0, 0.1, 0.2, 1.88, TRIM); p.box(-2.13, 0.3, 0, 0.1, 0.2, 1.88, TRIM);
    p.box(2.12, 0.58, 0, 0.05, 0.16, 0.9, DARK);                                             // grille
    lights(p, 2.12, -2.12, 0.62, 0.7, 0.16);
    return p;
  }
  function bodyBus(col) {
    var p = new Parts(), L = 11;
    p.box(0, 1.75, 0, L, 2.7, 2.5, col, { top: 0.99 });
    p.box(0, 0.62, 0, L - 0.1, 0.5, 2.46, shade(col, 0.72));
    p.box(0, 2.35, 0, L - 1.6, 0.9, 2.56, GLASS);                                             // window band
    for (var i = 1; i < 7; i++) p.box(-L / 2 + 0.8 + i * (L - 1.6) / 7, 2.35, 0, 0.12, 0.92, 2.58, col);
    p.box(L / 2 + 0.02, 2.1, 0, 0.05, 1.5, 2.3, GLASS);
    p.box(0, 1.3, 1.27, L - 0.5, 0.1, 0.04, '#f2f2ee'); p.box(0, 1.3, -1.27, L - 0.5, 0.1, 0.04, '#f2f2ee');
    p.box(0.6, 3.15, 0, 2.2, 0.16, 1.4, '#d8dce0');
    arches(p, [-3.0, 3.2], 0.5, 1.255, 0.5);
    lights(p, L / 2 + 0.03, -L / 2 - 0.03, 0.85, 0.85, 0.2);
    return p;
  }
  function bodyTruck(col) {
    var p = new Parts();
    p.box(0, 0.36, 0, 10, 0.28, 1.7, TRIM);
    p.box(4.05, 1.55, 0, 2.2, 2.55, 2.35, col, { top: 0.92 });
    p.box(4.45, 2.1, 0, 1.5, 0.9, 2.4, GLASS, { top: 0.86 });
    p.box(5.2, 0.8, 0, 0.12, 0.5, 2.3, DARK);
    p.box(-1.3, 1.95, 0, 6.7, 2.6, 2.5, '#dfe2e5');
    p.box(-1.3, 1.1, 1.26, 6.7, 0.2, 0.04, col); p.box(-1.3, 1.1, -1.26, 6.7, 0.2, 0.04, col);
    p.box(-1.3, 3.27, 0, 6.8, 0.07, 2.54, shade('#dfe2e5', 0.9));
    arches(p, [-3.7, -2.4, 3.3], 0.5, 1.19, 0.5);
    lights(p, 5.27, -4.66, 0.75, 0.9, 0.18);
    return p;
  }
  function bodyTanker(col) {
    var p = new Parts();
    p.box(0, 0.36, 0, 12, 0.28, 1.7, TRIM);
    p.box(4.95, 1.5, 0, 2.4, 2.4, 2.35, '#4a6f8f', { top: 0.92 });
    p.box(5.5, 2.0, 0, 1.3, 0.85, 2.4, GLASS, { top: 0.86 });
    p.cyl(-1.2, 1.95, 0, 1.3, 9.2, col, { n: 14, axis: 'x' });
    p.cyl(-5.9, 1.95, 0, 1.3, 0.12, shade(col, 0.8), { n: 14, axis: 'x' });
    p.cyl(-1.2, 3.3, 0, 0.3, 0.3, shade(col, 0.7), { n: 8, axis: 'y' });
    p.box(-1.2, 1.4, 1.31, 3.0, 0.5, 0.04, '#c4573f'); p.box(-1.2, 1.4, -1.31, 3.0, 0.5, 0.04, '#c4573f');
    p.box(6.15, 0.75, 0, 0.12, 0.5, 2.3, DARK);
    arches(p, [-4.2, -2.9, 4.5], 0.5, 1.19, 0.5);
    lights(p, 6.2, -6.05, 0.75, 0.9, 0.18);
    return p;
  }
  function bodyCrane(col) {
    var p = new Parts();
    p.box(0, 0.36, 0, 9.5, 0.28, 1.7, TRIM);
    p.box(3.2, 1.5, 0, 2.3, 2.35, 2.35, col, { top: 0.92 });
    p.box(3.65, 2.0, 0, 1.4, 0.85, 2.4, GLASS, { top: 0.86 });
    p.box(-1.0, 0.95, 0, 6.2, 0.7, 2.5, shade(col, 0.82));
    p.box(-1.2, 2.0, 0, 1.6, 1.3, 1.6, col);
    p.box(-1.2, 2.2, 0, 1.2, 0.6, 1.64, GLASS);
    p.box(1.5, 3.1, 0, 5.8, 0.34, 0.5, shade(col, 1.08), { rz: 0.2 });
    p.box(4.3, 3.2, 0, 0.1, 1.0, 0.1, TRIM);
    p.box(4.3, 2.65, 0, 0.3, 0.2, 0.3, '#b8433a');
    p.box(-0.2, 1.2, 1.5, 3.2, 0.3, 0.45, '#e0b24a'); p.box(-0.2, 1.2, -1.5, 3.2, 0.3, 0.45, '#e0b24a');
    arches(p, [-3.5, -2.1, 3.1], 0.55, 1.19, 0.5);
    lights(p, 4.37, -4.77, 0.75, 0.9, 0.18);
    return p;
  }
  function bodyTrain(col) {
    var p = new Parts();
    function wagon(cx, len, c) {
      p.box(cx, 0.6, 0, len, 0.3, 2.1, TRIM);
      p.box(cx, 2.05, 0, len, 2.7, 2.7, c, { top: 0.96, topZ: 0.92 });
      p.box(cx, 2.55, 0, len - 1.2, 0.9, 2.74, GLASS);
      for (var i = 1; i < 5; i++) p.box(cx - (len - 1.2) / 2 + i * (len - 1.2) / 5, 2.55, 0, 0.14, 0.92, 2.76, c);
      p.box(cx, 1.5, 1.36, len - 0.4, 0.12, 0.04, '#eeeeea'); p.box(cx, 1.5, -1.36, len - 0.4, 0.12, 0.04, '#eeeeea');
    }
    wagon(-8.0, 7.6, shade(col, 1.2));
    wagon(0.0, 7.6, shade(col, 1.2));
    p.box(8.0, 0.6, 0, 8.0, 0.3, 2.1, TRIM);
    p.box(8.0, 2.05, 0, 8.0, 2.7, 2.8, '#a8453a', { top: 0.94 });
    p.box(11.0, 2.3, 0, 2.2, 1.5, 2.6, '#a8453a');
    p.box(12.02, 2.6, 0, 0.06, 1.0, 2.2, GLASS);
    p.box(8.0, 3.55, 0, 3.0, 0.3, 1.6, TRIM);
    p.box(8.0, 1.5, 1.42, 7.6, 0.14, 0.04, '#e0b24a'); p.box(8.0, 1.5, -1.42, 7.6, 0.14, 0.04, '#e0b24a');
    p.box(6.0, 2.6, 1.42, 1.0, 0.9, 0.04, GLASS); p.box(6.0, 2.6, -1.42, 1.0, 0.9, 0.04, GLASS);
    p.box(12.02, 1.1, 0.8, 0.06, 0.3, 0.4, '#f5eec8'); p.box(12.02, 1.1, -0.8, 0.06, 0.3, 0.4, '#f5eec8');
    p.box(-11.9, 1.5, 0, 0.08, 0.5, 1.2, '#b8433a');
    return p;
  }
  function rider(p, x, y, shirt, helmet) {
    p.box(x, y, 0, 0.3, 0.6, 0.4, shirt, { rz: 0.25 });
    p.blob(x + 0.14, y + 0.5, 0, 0.2, helmet, { jit: 0.03, seed: 3 });
    p.box(x + 0.3, y + 0.06, 0.26, 0.5, 0.1, 0.1, shirt, { rz: -0.5 }); p.box(x + 0.3, y + 0.06, -0.26, 0.5, 0.1, 0.1, shirt, { rz: -0.5 });
  }
  function bodyMotorcycle(col) {
    var p = new Parts();
    p.box(0.05, 0.42, 0, 0.9, 0.34, 0.34, TRIM);
    p.box(0.25, 0.7, 0, 0.62, 0.3, 0.4, col, { top: 0.85 });
    p.box(-0.3, 0.64, 0, 0.7, 0.1, 0.36, '#262626');
    p.box(0.62, 0.42, 0, 0.1, 0.9, 0.1, CHROME, { rz: 0.28 });
    p.box(0.52, 0.92, 0, 0.1, 0.1, 0.64, '#333');
    p.box(0.74, 0.75, 0, 0.1, 0.2, 0.2, '#f5eec8');
    p.box(-0.55, 0.38, 0, 0.9, 0.07, 0.1, CHROME, { rz: 0.05 });
    rider(p, -0.12, 1.0, '#3d556b', '#eef0f2');
    return p;
  }
  function bodyBike(col) {
    var p = new Parts();
    p.box(0.02, 0.55, 0, 1.0, 0.06, 0.06, col, { rz: 0.55 });
    p.box(-0.25, 0.62, 0, 0.9, 0.06, 0.06, col, { rz: -0.28 });
    p.box(0.28, 0.82, 0, 0.55, 0.06, 0.06, col);
    p.box(0.52, 0.55, 0, 0.06, 0.8, 0.06, col, { rz: 0.28 });
    p.box(0.44, 0.97, 0, 0.1, 0.08, 0.5, '#333');
    p.box(-0.35, 0.98, 0, 0.34, 0.08, 0.16, '#262626');
    p.box(0.0, 0.15, 0, 0.3, 0.3, 0.05, '#6b7078');
    p.box(-0.15, 1.1, 0, 0.3, 0.55, 0.38, '#d9a441', { rz: 0.5 });
    p.blob(0.06, 1.55, 0, 0.2, '#b8433a', { jit: 0.03, seed: 5 });
    p.box(0.1, 0.62, 0.17, 0.5, 0.1, 0.1, '#2f4050', { rz: -0.9 }); p.box(0.1, 0.62, -0.17, 0.5, 0.1, 0.1, '#2f4050', { rz: -0.9 });
    p.box(0.28, 1.0, 0.22, 0.5, 0.08, 0.08, '#d9a441', { rz: -0.6 }); p.box(0.28, 1.0, -0.22, 0.5, 0.08, 0.08, '#d9a441', { rz: -0.6 });
    return p;
  }

  var BODIES = { car: bodyCar, bus: bodyBus, truck: bodyTruck, tanker: bodyTanker, crane: bodyCrane, train: bodyTrain, motorcycle: bodyMotorcycle, bike: bodyBike };
  var bodyCache = {};
  /** Body geometry; `custom` is a route colour (otherwise the muted default of the type is used). */
  function vehicleBody(type, custom) {
    var color = custom || BODY[type] || '#c2573f';
    var k = type + '|' + color;
    if (bodyCache[k]) return bodyCache[k];
    var g = (BODIES[type] || bodyCar)(color).geometry();
    bodyCache[k] = g;
    return g;
  }
  function vehicleWheel(type, r, idx) {
    var mk = WHEEL_MASK[type];
    if (mk && !mk[Math.min(idx || 0, mk.length - 1)]) return { geom: null, pair: false };       // the animals' legs belong to the body
    if (WHEEL_STYLE[type] && WHEEL_GEOM) return { geom: WHEEL_GEOM(r, WHEEL_STYLE[type]), pair: true };
    if (WOOD_WHEELED[type]) return { geom: wheelWood(r, WOOD_WHEELED[type]), pair: true };
    if (type === 'oldcar') return { geom: wheelWood(r, 1.45), pair: true };
    if (type === 'bike') return { geom: thinWheel(r, 'bike'), pair: false };
    if (type === 'motorcycle') return { geom: thinWheel(r, 'moto'), pair: false };
    var rail = type === 'train' || type === 'loco';
    var track = type === 'car' ? 1.72 : rail ? 2.3 : 2.1;
    var width = type === 'car' ? 0.32 : 0.46;
    return { geom: wheelPair(r, track, width, rail ? 'rail' : 'road'), pair: true };
  }

  // ---------------------------------------------------------------------------------------------
  // ship (origin: waterline centre, x = bow direction)
  // ---------------------------------------------------------------------------------------------
  function shipGeometry(len, beam, top, hull, cabin) {
    var p = new Parts(), L = Math.max(4, len), D = Math.max(1.8, beam), h = Math.min(1.5, Math.max(0.9, top * 0.26));
    // hull: side profile extruded across the beam, raked bow (+x)
    p.prism([[-L / 2, h], [-L / 2 + 0.7, 0], [L / 2 - 2.0, 0], [L / 2, h * 1.15], [L / 2, h + 0.35], [-L / 2, h + 0.35]], 0, D, hull);
    p.box(0, h + 0.4, 0, L - 0.4, 0.1, D + 0.05, shade(hull, 0.7));
    p.box(L / 2 - 0.9, h + 0.62, 0, 1.6, 0.3, D * 0.55, shade(hull, 0.85));          // fore deck
    var room = top - h - 0.45;                                                          // free height above the deck
    if (room >= 1.1) {
      var chH = Math.min(room - (room > 3.4 ? 1.2 : 0.2), 2.6);
      p.box(-L * 0.14, h + 0.5 + chH / 2, 0, L * 0.38, chH, D * 0.74, cabin);
      p.box(-L * 0.14, h + 0.5 + chH * 0.62, 0, L * 0.38 + 0.03, Math.min(0.7, chH * 0.34), D * 0.74 + 0.04, GLASS);
      p.box(-L * 0.14, h + 0.55 + chH, 0, L * 0.42, 0.14, D * 0.8, shade(cabin, 0.82));
      if (room > 3.4) {
        var mastTop = top - 0.3, mh = mastTop - (h + 0.6);
        p.box(L * 0.2, h + 0.6 + mh / 2, 0, 0.16, mh, 0.16, '#7a5a40');
        p.box(L * 0.2, mastTop - 0.6, 0, 0.1, 0.1, D * 0.62, '#7a5a40');
        p.box(L * 0.2 + 0.5, mastTop - 0.3, 0, 0.9, 0.5, 0.04, '#d9a441');
        p.cyl(-L * 0.3, h + 0.5 + chH + 0.55, 0, 0.3, 1.0, '#b8433a', { n: 8, axis: 'y' });
      }
    }
    return p.geometry();
  }

  // ---------------------------------------------------------------------------------------------
  // props
  // ---------------------------------------------------------------------------------------------
  function crateGeometry() {
    var p = new Parts();
    p.box(0, 0, 0, 0.64, 0.64, 0.64, '#c4975a');
    p.box(0, 0, 0, 0.66, 0.08, 0.66, '#8a6a3c'); p.box(0, 0, 0, 0.08, 0.66, 0.66, '#8a6a3c');
    return p.geometry();
  }
  // v3.4: flags in the style of the epoch (style: 'stone' | 'antique' | 'medieval' | undefined = the classic flag)
  function flagPole(style) {
    var p = new Parts();
    if (style === 'stone') {                                   // lashed wooden stake with a stone cap
      p.cyl(0, 2.6, 0, 0.09, 5.2, '#6a4a30', { n: 6, axis: 'y', r2: 0.075 });
      for (var k = 0; k < 3; k++) p.box(0, 0.6 + k * 1.5, 0, 0.17, 0.1, 0.17, '#a98a5a');
      p.blob(0, 5.3, 0, 0.17, '#9a948a', { jit: 0.04, seed: 3 });
      p.blob(0, 0.14, 0, 0.45, '#8d8a82', { jit: 0.1, sy: 0.5, seed: 4 });
    } else if (style === 'antique') {                          // pole with a cross bar and a golden spear tip
      p.cyl(0, 2.6, 0, 0.07, 5.2, '#8a5a34', { n: 8, axis: 'y' });
      p.box(0.5, 4.75, 0, 1.1, 0.09, 0.09, '#8a5a34');
      p.cone(0, 5.2, 0, 0.12, 0.5, '#d9a441', { n: 6 });
      p.box(0, 0.12, 0, 0.7, 0.24, 0.7, '#c4b494');
    } else if (style === 'medieval') {                         // iron-shod pole, banner hangs from a cross bar
      p.cyl(0, 2.6, 0, 0.07, 5.2, '#4a3828', { n: 8, axis: 'y' });
      p.box(0.62, 4.85, 0, 1.3, 0.08, 0.08, '#4a3828');
      p.cone(0, 5.2, 0, 0.1, 0.55, '#8f959c', { n: 6 });
      p.box(0, 0.12, 0, 0.8, 0.24, 0.8, '#8f8f88');
    } else {
      p.box(0, 2.6, 0, 0.1, 5.2, 0.1, '#e4e8ec');
      p.blob(0, 5.25, 0, 0.12, '#d9a441', { jit: 0.02, seed: 2 });
      p.box(0, 0.1, 0, 0.6, 0.2, 0.6, '#8d96a0');
    }
    return p;
  }
  /** mode: 'check' (chequered goal flag) | 'goal' (route colour above, chequered below) | 'plain' (route colour, white band); true / false = check / plain */
  function flagCloth(color, mode, style) {
    var p = new Parts(), cols = 6, rows = 4, w = 0.3, h = 0.28, i, j, c;
    if (mode === true) mode = 'check'; else if (!mode) mode = 'plain';
    function cell(i, j, ww, hh, x0, y0, col) { p.box(x0 + i * ww + ww / 2, y0 - j * hh - hh / 2, 0, ww + 0.005, hh + 0.005, 0.04, col); }
    function pick(i, j) {
      if (mode === 'check') return (i + j) % 2 ? '#2a2e34' : '#f4f4f0';
      if (mode === 'goal') return j >= 2 ? ((i + j) % 2 ? '#2a2e34' : '#f4f4f0') : color;
      return j === 1 || j === 2 ? '#f4f4f0' : color;
    }
    if (style === 'stone') {                                   // a big banner: route colour on top, a trim of fur with a ragged edge below
      var fur = ['#b08a5a', '#9a7448', '#c19a68'], fw = 0.44, fh = 0.4, fc = 5;
      for (i = 0; i < fc; i++) {
        var low = i % 2 ? 1 : 2;                                // ragged lower edge: columns of 3 or 4 rows
        for (j = 0; j < 2 + low; j++) {
          var cc2;
          if (j < 2) cc2 = color;                               // two rows in the route colour
          else if (mode !== 'plain' && j === 1 + low) cc2 = (i % 2) ? '#2a2e34' : '#f4f4f0';   // goal: chequered fringe
          else cc2 = fur[(i + j) % 3];
          p.box(0.06 + i * fw + fw / 2, 5.0 - j * fh - fh / 2, 0, fw + 0.005, fh + 0.005, 0.05, cc2);
        }
      }
      p.box(0.1, 5.25, 0, 0.08, 0.5, 0.06, '#7a5a38'); p.box(0.28, 5.2, 0, 0.08, 0.4, 0.06, '#9a7448');   // two feathers at the stake
        } else if (style === 'antique') {                          // long pennant hanging from the cross bar, tapering to a point
      var pw = 0.26, pn = 9;
      for (i = 0; i < pn; i++) {
        var tall = 0.95 * (1 - i / (pn + 1)), col2 = mode === 'check' ? (i % 2 ? '#2a2e34' : '#f4f4f0') : (mode === 'goal' && i % 2 ? '#2a2e34' : (i % 3 === 1 ? '#f4f4f0' : color));
        p.box(0.12 + i * pw + pw / 2, 4.72 - tall / 2, 0, pw + 0.004, tall, 0.04, col2);
      }
      p.box(0.7, 4.72, 0, 1.7, 0.08, 0.06, '#d9a441');
    } else if (style === 'medieval') {                         // a tall banner with swallow-tail, a gold cross stripe
      var bw = 0.5, bh = 0.5;
      for (i = 0; i < 3; i++) for (j = 0; j < 5; j++) {
        if (j === 4 && i === 1) continue;                       // the notch of the swallow-tail
        var cb = color;
        if (mode === 'check' || (mode === 'goal' && j >= 3)) cb = (i + j) % 2 ? '#2a2e34' : '#f4f4f0';
        else if (j === 1 && mode !== 'check') cb = '#e8d28a';   // gold band
        else if (i === 1 && j !== 1 && mode === 'plain') cb = '#f4f4f0';
        p.box(0.08 + i * bw + bw / 2, 4.82 - j * bh - bh / 2, 0, bw + 0.005, bh + 0.005, 0.05, cb);
      }
      p.box(0.66, 4.86, 0, 1.52, 0.08, 0.07, '#d9a441');
    } else {
      for (j = 0; j < rows; j++) for (i = 0; i < cols; i++) { c = pick(i, j); cell(i, j, w, h, 0.06, 4.95, c); }
    }
    return p;
  }
  function signGeometry(accent) {
    var p = new Parts();
    p.box(0, 0.9, 0, 0.1, 1.8, 0.1, '#6b5240');
    p.box(0, 1.75, 0, 1.6, 0.8, 0.1, accent || '#4f8f66');
    p.prism([[-0.5, 0], [0.18, 0], [0.18, -0.2], [0.58, 0.12], [0.18, 0.44], [0.18, 0.24], [-0.5, 0.24]], 0.06, 0.04, '#f4f4f0', { y: 1.5 });
    return p.geometry();
  }
  function checkpointGeometry() {
    var p = new Parts();
    p.box(-0.1, 1.9, 1.7, 0.2, 3.8, 0.2, '#d9a441'); p.box(-0.1, 1.9, -1.7, 0.2, 3.8, 0.2, '#d9a441');
    p.box(-0.1, 3.7, 0, 0.26, 0.26, 3.6, '#d9a441');
    for (var i = 0; i < 6; i++) p.box(-0.1, 3.7, -1.5 + i * 0.6, 0.28, 0.27, 0.3, i % 2 ? '#2a2e34' : '#d9a441');
    return p.geometry();
  }
  function pylonGeometry(height, wTop, wBottom, style) {
    var p = new Parts();
    if (style === 'tree') {            // Steinzeit: a huge tree whose crown holds the lianas
      p.cyl(0, height / 2, 0, wBottom * 0.8, height, '#6a4a30', { n: 8, axis: 'y', r2: wTop * 0.5 });
      p.box(0, height + 0.1, 0, wTop * 0.7, 0.45, 3.4, '#5a3e28');                 // the two strong branches the lianas hang from
      p.blob(0, height + 1.6, 0, 2.3, '#5d8a50', { jit: 0.07, sy: 0.85, seed: 7 });
      p.blob(-0.9, height + 0.9, 1.9, 1.3, '#4f7a48', { jit: 0.07, sy: 0.85, seed: 8 });
      p.blob(0.9, height + 0.9, -1.9, 1.3, '#4f7a48', { jit: 0.07, sy: 0.85, seed: 9 });
      return p.geometry();
    }
    var topY = height;
    if (style === 'antique') {                // Doric column tower: stacked stone drums, a capital with a flat slab on top
      var nd = Math.max(2, Math.round(height / 1.4)), dh = (height - 0.5) / nd, k;
      for (k = 0; k < nd; k++) p.cyl(0, 0.25 + dh * (k + 0.5), 0, wBottom * (0.62 - 0.12 * k / nd), dh - 0.04, k % 2 ? '#cbbf9f' : '#d6cba9', { n: 10, axis: 'y', r2: wBottom * (0.62 - 0.12 * (k + 1) / nd) });
      p.box(0, 0.12, 0, wBottom * 1.7, 0.24, wBottom * 1.7, '#bdb190');
      p.cyl(0, height - 0.05, 0, wTop * 0.95, 0.3, '#d6cba9', { n: 10, axis: 'y', r2: wTop * 1.1 });
      p.box(0, height + 0.12, 0, wTop * 1.7, 0.18, 3.2, '#cbbf9f');
      p.box(0, height + 0.3, 0, wTop * 1.4, 0.14, 3.4, '#b6aa8a');
      return p.geometry();
    }
    if (style === 'medieval') {               // stone watch-tower with courses, arrow slits and a crenellated top
      p.cyl(0, height / 2, 0, wBottom * 0.85, height, '#9a9a92', { n: 10, axis: 'y', r2: wTop * 0.8 });
      for (var c = 1; c < Math.floor(height / 0.9); c++) p.cyl(0, c * 0.9, 0, wBottom * 0.85 - (wBottom * 0.85 - wTop * 0.8) * (c * 0.9 / height) + 0.02, 0.05, '#7a7a74', { n: 10, axis: 'y' });
      p.box(0.0, height * 0.55, wBottom * 0.8, 0.14, 0.8, 0.05, '#2a2a2a'); p.box(0.0, height * 0.55, -wBottom * 0.8, 0.14, 0.8, 0.05, '#2a2a2a');
      p.cyl(0, height - 0.05, 0, wTop * 1.2, 0.4, '#8a8a82', { n: 10, axis: 'y' });
      for (var m2 = 0; m2 < 8; m2++) { var a2 = m2 / 8 * Math.PI * 2; p.box(Math.cos(a2) * wTop * 1.1, height + 0.3, Math.sin(a2) * wTop * 1.1, 0.34, 0.4, 0.34, '#8f8f88'); }
      p.box(0, height + 0.1, 0, wTop * 1.2, 0.2, 3.4, '#7a7a74');
      return p.geometry();
    }
    if (style === 'industry') {               // riveted iron lattice tower: four legs, cross bracing, a cap beam
      var hw = wBottom * 0.8, ht = wTop * 0.4;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) { p.box(q[0] * (hw + ht) / 2 * 0.55, height / 2, q[1] * 0.9, 0.22, height, 0.22, '#7a4a38', { top: 0.7 }); });
      var nb = Math.max(2, Math.round(height / 2.2));
      for (var b2 = 0; b2 < nb; b2++) {
        var y0 = b2 * height / nb, y1 = (b2 + 1) * height / nb, w0 = hw * (1 - 0.4 * b2 / nb) * 0.55, w1 = hw * (1 - 0.4 * (b2 + 1) / nb) * 0.55;
        [-0.9, 0.9].forEach(function (zz) {
          p.box(0, y1, zz, w1 * 2, 0.12, 0.12, '#6a3f30');
          var ang = Math.atan2(y1 - y0, w1 + w0), ln = Math.hypot(y1 - y0, w1 + w0);
          p.box(0, (y0 + y1) / 2, zz, ln, 0.1, 0.1, '#6a3f30', { rz: ang }); p.box(0, (y0 + y1) / 2, zz, ln, 0.1, 0.1, '#6a3f30', { rz: -ang });
        });
      }
      p.box(0, height + 0.15, 0, wTop * 1.4, 0.35, 3.4, '#5a3428'); p.box(0, height + 0.4, 0, wTop * 1.1, 0.14, 3.5, '#6a3f30');
      return p.geometry();
    }
    p.cyl(0, height / 2, 0, wBottom * 0.72, height, '#e0dbd0', { n: 4, axis: 'y', r2: wTop * 0.72 });
    p.box(0, height + 0.15, 0, wTop * 1.3, 0.35, 3.4, '#b9b2a6');            // cross beam: the cable planes (front / back) attach to its ends
    p.box(0, height + 0.38, 0, wTop * 1.05, 0.14, 3.5, '#9d9689');
    return p.geometry();
  }
  function plateGeometry(w) {
    var p = new Parts();
    p.box(0, 0, 0, w, w, 3.0, '#59616b');
    p.box(0, 0, 1.52, w * 0.8, w * 0.8, 0.05, '#8a929c');
    p.box(0, 0, -1.52, w * 0.8, w * 0.8, 0.05, '#8a929c');
    return p.geometry();
  }
  function foundationGeometry(height) {
    var p = new Parts();
    p.box(0, -height / 2, 0, 1.7, height, 3.0, '#a9adb3', { top: 0.88, topZ: 0.94 });
    p.box(0, 0.02, 0, 1.0, 0.16, 3.1, '#59616b');
    return p.geometry();
  }
  function hazardBarGeometry(len) {
    var p = new Parts(), n = Math.max(2, Math.round(len / 0.7));
    p.box(0, 0, 0, len, 0.34, 0.34, '#e0b24a');
    for (var i = 0; i < n; i += 2) p.box(-len / 2 + (i + 0.5) * len / n, 0, 0, len / n, 0.36, 0.36, '#2a2e34');
    p.box(0, 0, 1.7, len, 0.18, 0.18, '#9aa1aa'); p.box(0, 0, -1.7, len, 0.18, 0.18, '#9aa1aa');
    p.box(-len / 2 + 0.1, 0, 0, 0.2, 0.4, 3.5, '#9aa1aa'); p.box(len / 2 - 0.1, 0, 0, 0.2, 0.4, 3.5, '#9aa1aa');
    return p.geometry();
  }

  // trees / rocks / clouds for the static decor (returns Parts positioned at the origin; the world builder translates)
  function treeParts(type, seed, cols, trunk, s) {
    var p = new Parts(), r = U.mulberry32(seed), c = cols[Math.floor(r() * cols.length) % cols.length], h = (1 + r() * 0.3) * s;
    if (type.indexOf('z_') === 0) {        // Zeitreise: every epoch mixes its own plants
      var pick = r() < 0.55 ? 0 : 1;
      type = ({ z_stone: ['fern', 'pine'], z_antique: ['cypress', 'round'], z_medieval: ['oakfull', 'pine'], z_industry: ['chimney', 'dead'], z_modern: ['round', 'round'] }[type] || ['round', 'round'])[pick];
      if (zeitTree(type, p, r, c, trunk, h, s, seed)) return p;
    }
    switch (type) {
      case 'pine':
        p.box(0, 0.6 * h, 0, 0.3 * s, 1.2 * h, 0.3 * s, trunk);
        p.cone(0, 0.9 * h, 0, 1.45 * s, 2.0 * h, c, { n: 8, rot: 0.2 });
        p.cone(0, 2.2 * h, 0, 1.05 * s, 1.7 * h, shade(c, 1.1), { n: 8, rot: 0.2 });
        break;
      case 'palm':
        p.box(0.1 * s, 1.2 * h, 0, 0.26 * s, 2.4 * h, 0.26 * s, trunk, { rz: -0.07 });
        for (var i = 0; i < 6; i++) {
          var a = i / 6 * Math.PI * 2;
          p.prism([[0, 0], [1.3 * s, 0.2 * s], [2.2 * s, -0.45 * s], [1.3 * s, -0.1 * s]], 0, 0.45 * s, c, { x: 0.3 * s, y: 2.45 * h, ry: a });
        }
        break;
      case 'cactus':
        p.box(0, 1.0 * h, 0, 0.5 * s, 2.0 * h, 0.5 * s, c, { top: 0.85, topZ: 0.85 });
        p.box(0.5 * s, 1.4 * h, 0, 0.7 * s, 0.28 * s, 0.28 * s, c); p.box(0.78 * s, 1.8 * h, 0, 0.28 * s, 0.8 * h, 0.28 * s, c, { top: 0.85 });
        break;
      case 'lolli':
        p.box(0, 0.8 * h, 0, 0.12 * s, 1.6 * h, 0.12 * s, trunk);
        p.blob(0, 2.0 * h, 0, 0.85 * s, c, { jit: 0.02, seed: seed });
        break;
      case 'crate':
        p.box(0, 0.4 * s, 0, 0.8 * s, 0.8 * s, 0.8 * s, c); p.box(0.9 * s, 0.35 * s, 0, 0.7 * s, 0.7 * s, 0.7 * s, shade(c, 0.9));
        p.box(0.3 * s, 1.1 * s, 0, 0.7 * s, 0.7 * s, 0.7 * s, shade(c, 1.08));
        break;
      case 'dead':
        p.box(0, 1.0 * h, 0, 0.26 * s, 2.0 * h, 0.26 * s, trunk, { rz: 0.04 });
        p.box(0.35 * s, 1.6 * h, 0, 0.8 * s, 0.12 * s, 0.12 * s, trunk, { rz: 0.5 });
        break;
      default:
        p.box(0, 0.55 * h, 0, 0.3 * s, 1.1 * h, 0.3 * s, trunk);
        p.blob(0, 1.8 * h, 0, 1.15 * s, c, { jit: 0.05, sy: 0.92, seed: seed });
        p.blob(0.5 * s, 1.35 * h, 0.2 * s, 0.7 * s, shade(c, 1.08), { jit: 0.05, sy: 0.9, seed: seed + 3 });
    }
    return p;
  }
  function rockParts(seed, cols, s) {
    var p = new Parts(), r = U.mulberry32(seed), c = cols[Math.floor(r() * cols.length) % cols.length];
    p.blob(0, 0.3 * s, 0, 0.85 * s, c, { jit: 0.1, sy: 0.6, seed: seed });
    return p;
  }
  function cloudParts(seed, color) {
    var p = new Parts(), r = U.mulberry32(seed), n = 3;
    for (var i = 0; i < n; i++) p.blob((i - 1) * 2.8, i === 1 ? 0.7 : 0, (r() - 0.5) * 1.5, i === 1 ? 2.6 : 2.0, color, { jit: 0.03, sy: 0.6, seed: seed + i });
    return p;
  }

  // ---------------------------------------------------------------------------------------------
  // Zeitreise: vehicles, vessels and plants of the epochs (same clean low-poly style, muted colours)
  // ---------------------------------------------------------------------------------------------
  var SKIN = '#d9ad86', HIDE = '#8a6238', FURC = '#6b4a34';
  function person(p, x, y, z, shirt, o) {
    o = o || {};
    var h = o.h || 1, legs = o.legs || '#5a4632';
    p.box(x, y + 0.42 * h, z - 0.1 * h, 0.16, 0.84 * h, 0.16, legs); p.box(x, y + 0.42 * h, z + 0.1 * h, 0.16, 0.84 * h, 0.16, legs);
    p.box(x, y + 1.18 * h, z, 0.32, 0.7 * h, 0.44, shirt, { top: 0.9 });
    p.blob(x + 0.03, y + 1.7 * h, z, 0.2 * h, o.skin || SKIN, { jit: 0.03, seed: 4 });
    p.box(x + 0.05, y + 1.2 * h, z + 0.28 * h, 0.4, 0.1, 0.1, shirt, { rz: -0.6 }); p.box(x + 0.05, y + 1.2 * h, z - 0.28 * h, 0.4, 0.1, 0.1, shirt, { rz: -0.6 });
    if (o.helmet) p.blob(x + 0.02, y + 1.82 * h, z, 0.22 * h, o.helmet, { jit: 0.03, seed: 8, sy: 0.7 });
    if (o.spear) p.box(x + 0.25, y + 1.3 * h, z + 0.3 * h, 0.06, 2.2 * h, 0.06, '#7a5a3c', { rz: -0.08 });
    if (o.shield) { p.box(x + 0.05, y + 1.15 * h, z + 0.42 * h, 0.1, 0.8 * h, 0.5, o.shield); p.box(x + 0.05, y + 1.15 * h, z + 0.46 * h, 0.04, 0.3 * h, 0.3, '#e0b24a'); }
  }
  function horse(p, x, y, col, o) {
    o = o || {};
    var s = o.s || 1, z = o.z || 0, dark = shade(col, 0.7);
    p.box(x, y + 1.0 * s, z, 1.7 * s, 0.7 * s, 0.55 * s, col, { top: 0.95 });
    p.box(x + 0.95 * s, y + 1.5 * s, z, 0.5 * s, 0.9 * s, 0.34 * s, col, { rz: -0.45 });
    p.box(x + 1.35 * s, y + 1.82 * s, z, 0.6 * s, 0.3 * s, 0.3 * s, col, { rz: -0.2 });
    p.box(x - 0.95 * s, y + 1.0 * s, z, 0.1 * s, 0.7 * s, 0.1 * s, dark, { rz: 0.2 });
    [[0.65, 0.16], [0.65, -0.16], [-0.65, 0.16], [-0.65, -0.16]].forEach(function (l) { p.box(x + l[0] * s, y + 0.38 * s, z + l[1] * s, 0.14 * s, 0.76 * s, 0.14 * s, dark); });
    if (o.rider) { person(p, x - 0.1, y + 0.75 * s, z, o.rider, { h: 0.9, helmet: '#9aa0a6', legs: '#4a4a4a' }); }
  }
  function ox(p, x, y) {
    var c = '#7a5638', d = '#4e3826';
    p.box(x, y + 1.05, 0, 1.7, 0.9, 0.85, c, { top: 0.96 });
    p.box(x + 1.0, y + 1.25, 0, 0.55, 0.62, 0.55, c);
    p.box(x + 1.3, y + 1.55, 0.26, 0.5, 0.07, 0.07, '#e9e0c9', { rz: 0.5 }); p.box(x + 1.3, y + 1.55, -0.26, 0.5, 0.07, 0.07, '#e9e0c9', { rz: 0.5 });
    [[0.6, 0.25], [0.6, -0.25], [-0.6, 0.25], [-0.6, -0.25]].forEach(function (l) { p.box(x + l[0], y + 0.4, l[1], 0.2, 0.8, 0.2, d); });
  }
  var WOOD_WHEEL = '#6b4a2a';
  function wheelWood(r, track) {
    var k = 'wood|' + r.toFixed(2) + '|' + track.toFixed(2);
    if (wheelCache[k]) return wheelCache[k];
    var p = new Parts(), zs = [track / 2, -track / 2];
    for (var i = 0; i < 2; i++) {
      var z = zs[i], out = z > 0 ? 1 : -1;
      p.cyl(0, 0, z, r, 0.16, WOOD_WHEEL, { n: 12 });
      p.cyl(0, 0, z + out * 0.07, r * 0.78, 0.06, '#8f6a3e', { n: 12 });
      p.cyl(0, 0, z + out * 0.1, r * 0.2, 0.08, '#3c2a1a', { n: 8 });
      p.box(0, 0, z + out * 0.1, r * 1.5, r * 0.12, 0.05, '#3c2a1a'); p.box(0, 0, z + out * 0.1, r * 0.12, r * 1.5, 0.05, '#3c2a1a');
    }
    p.cyl(0, 0, 0, r * 0.1, track, '#3c2a1a', { n: 6 });
    var g = p.geometry(); wheelCache[k] = g; return g;
  }
  function bodyHunter(col) {
    var p = new Parts();
    person(p, 0, -0.34, 0, col, { h: 1.0, spear: true, legs: '#6b4a34' });
    p.box(0.02, 0.58, 0, 0.36, 0.18, 0.5, FURC);                     // fur wrap
    return p;
  }
  function bodyFurcart(col) {
    var p = new Parts();
    p.box(-0.1, 0.62, 0, 2.2, 0.28, 1.3, WOOD_WHEEL);
    p.box(-0.1, 0.92, 0.62, 2.2, 0.36, 0.08, '#8a5a34'); p.box(-0.1, 0.92, -0.62, 2.2, 0.36, 0.08, '#8a5a34'); p.box(-1.14, 0.92, 0, 0.08, 0.36, 1.28, '#8a5a34');
    p.blob(-0.2, 1.12, 0, 0.7, col, { jit: 0.08, sy: 0.55, seed: 5 }); p.blob(0.3, 1.0, 0.2, 0.45, shade(col, 0.85), { jit: 0.08, sy: 0.6, seed: 9 });
    p.box(1.5, 0.78, 0.45, 1.4, 0.07, 0.07, '#7a5a3c', { rz: 0.12 }); p.box(1.5, 0.78, -0.45, 1.4, 0.07, 0.07, '#7a5a3c', { rz: 0.12 });
    return p;
  }
  function bodyMammoth(col) {
    var p = new Parts(), dark = shade(col, 0.72);
    p.box(-0.1, 2.0, 0, 3.7, 2.0, 1.9, col, { top: 0.88, topZ: 0.9 });
    p.blob(-0.2, 3.0, 0, 1.2, shade(col, 1.12), { jit: 0.08, sy: 0.7, sx: 1.4, seed: 3 });          // shoulder hump
    p.box(2.0, 2.3, 0, 1.3, 1.6, 1.4, col, { top: 0.85 });                                       // head
    p.blob(2.5, 2.9, 0, 0.7, shade(col, 1.1), { jit: 0.06, seed: 6 });
    for (var i = 0; i < 4; i++) p.box(2.85 + i * 0.05, 1.9 - i * 0.5, 0, 0.3, 0.55, 0.3, col, { rz: -0.15 });   // trunk
    p.box(2.7, 1.55, 0.55, 1.2, 0.12, 0.12, '#efe6cf', { rz: -0.55 }); p.box(2.7, 1.55, -0.55, 1.2, 0.12, 0.12, '#efe6cf', { rz: -0.55 });  // tusks
    p.box(3.1, 1.4, 0.55, 0.5, 0.1, 0.1, '#efe6cf', { rz: 0.5 }); p.box(3.1, 1.4, -0.55, 0.5, 0.1, 0.1, '#efe6cf', { rz: 0.5 });
    [[1.7, 0.55], [1.7, -0.55], [-1.7, 0.55], [-1.7, -0.55]].forEach(function (l) { p.box(l[0], 0.1, l[1], 0.62, 1.9, 0.62, dark); });
    p.box(-2.0, 2.0, 0, 0.1, 1.0, 0.1, dark, { rz: 0.1 });
    return p;
  }
  function bodyOxcart() {
    var p = new Parts();
    p.box(-1.0, 0.85, 0, 3.0, 0.3, 1.9, WOOD_WHEEL);
    p.box(-1.0, 1.25, 0.92, 3.0, 0.5, 0.08, '#8a5a34'); p.box(-1.0, 1.25, -0.92, 3.0, 0.5, 0.08, '#8a5a34'); p.box(-2.46, 1.25, 0, 0.08, 0.5, 1.8, '#8a5a34');
    p.box(-1.0, 1.7, 0, 2.8, 0.5, 1.6, '#d8cdb0', { top: 0.7, topZ: 0.85 });
    p.box(1.0, 0.95, 0, 2.2, 0.08, 0.08, '#7a5a3c');
    ox(p, 2.0, -0.55);
    return p;
  }
  function bodyChariot(col) {
    var p = new Parts();
    p.box(-0.5, 0.75, 0, 1.2, 0.12, 1.0, WOOD_WHEEL);
    p.box(-1.05, 1.1, 0, 0.08, 0.8, 1.0, col); p.box(-0.5, 1.1, 0.5, 1.2, 0.7, 0.08, col, { top: 0.8 }); p.box(-0.5, 1.1, -0.5, 1.2, 0.7, 0.08, col, { top: 0.8 });
    p.box(0.8, 0.95, 0, 1.6, 0.07, 0.07, '#7a5a3c', { rz: 0.1 });
    horse(p, 1.8, -0.55, '#a8794a', { s: 0.9, z: 0.3 }); horse(p, 1.8, -0.55, '#7a5638', { s: 0.9, z: -0.3 });
    person(p, -0.55, 0.8, 0, '#a83a32', { h: 0.85, helmet: '#d9b24a' });
    return p;
  }
  function bodyLegion() {
    var p = new Parts();
    for (var i = 0; i < 4; i++) for (var j = 0; j < 2; j++) person(p, -3 + i * 2, -0.4, -0.55 + j * 1.1, '#a83a32', { h: 0.95, helmet: '#c9a24a', shield: '#b8433a', spear: true, legs: '#8a6a4a' });
    return p;
  }
  function bodyHorsecart() {
    var p = new Parts();
    p.box(-1.2, 0.95, 0, 3.4, 0.3, 2.0, WOOD_WHEEL);
    p.box(-1.2, 1.4, 1.0, 3.4, 0.6, 0.08, '#8a5a34'); p.box(-1.2, 1.4, -1.0, 3.4, 0.6, 0.08, '#8a5a34'); p.box(-2.86, 1.4, 0, 0.08, 0.6, 2.0, '#8a5a34');
    for (var i = 0; i < 3; i++) p.cyl(-2.0 + i * 0.9, 1.65, 0, 0.42, 1.5, '#a8794a', { n: 8, axis: 'z' });          // barrels
    p.box(1.0, 1.0, 0, 1.4, 0.07, 0.07, '#7a5a3c');
    horse(p, 2.1, -0.6, '#6b4a34', { s: 1.0 });
    p.box(0.4, 1.7, 0, 0.5, 0.5, 0.6, '#6a3a4a');
    return p;
  }
  function bodyCarriage(col) {
    var p = new Parts();
    p.box(-0.3, 0.75, 0, 3.4, 0.25, 1.7, '#4a3a2a');
    p.box(-0.5, 1.5, 0, 2.4, 1.3, 1.7, col, { top: 0.92 });
    p.box(-0.5, 1.6, 0, 1.8, 0.62, 1.74, GLASS); p.box(-0.5, 2.25, 0, 2.6, 0.14, 1.9, shade(col, 0.7));
    p.box(1.3, 1.25, 0, 0.9, 0.5, 1.5, '#4a3a2a'); person(p, 1.3, 1.1, 0, '#2f3a4a', { h: 0.75, helmet: '#2a2a2a' });
    p.box(2.4, 1.0, 0, 1.4, 0.07, 0.07, '#7a5a3c');
    horse(p, 3.4, -0.6, '#3a2f2a', { s: 1.0 });
    return p;
  }
  function bodyKnights() {
    var p = new Parts();
    var cols = ['#7a5a46', '#c9c2b0', '#4a3a30'];
    for (var i = 0; i < 3; i++) {
      horse(p, -2.6 + i * 2.7, -0.5, cols[i], { s: 0.95, rider: i === 1 ? '#7a2a2a' : '#2f4a7a' });
      p.box(-2.1 + i * 2.7, 2.4, 0.3, 0.06, 2.4, 0.06, '#7a5a3c', { rz: -0.35 });
      p.box(-2.55 + i * 2.7, 1.7, 0.42, 0.1, 0.6, 0.4, i % 2 ? '#2f4a7a' : '#b8433a');
    }
    return p;
  }
  function bodyLoco(col) {
    var p = new Parts(), IRON = '#33383d';
    p.box(2.5, 0.6, 0, 15, 0.3, 2.1, TRIM);
    p.cyl(7.0, 2.35, 0, 1.0, 6.0, IRON, { n: 12, axis: 'x' });                                 // boiler
    p.cyl(8.9, 3.6, 0, 0.42, 1.3, IRON, { n: 8, axis: 'y', r2: 0.6 });                          // chimney
    p.cyl(7.0, 3.5, 0, 0.35, 0.5, '#b8943a', { n: 8, axis: 'y' });                             // steam dome
    p.box(4.0, 2.7, 0, 2.2, 2.4, 2.4, '#8a2f28', { top: 0.92 }); p.box(4.0, 3.0, 0, 1.5, 0.7, 2.44, GLASS);   // cab
    p.box(3.9, 4.0, 0, 2.5, 0.16, 2.6, '#33383d');
    p.box(10.2, 0.9, 0, 0.3, 0.8, 1.6, '#4a4f55');                                              // cow-catcher
    p.box(0.8, 1.7, 0, 3.4, 1.8, 2.3, '#3a3a3e', { top: 0.9 });                                 // tender
    p.box(0.8, 2.75, 0, 3.2, 0.5, 2.0, '#1f1f22');                                              // coal
    p.box(-4.0, 1.6, 0, 7.0, 2.1, 2.4, '#8a6238', { top: 0.97 });                                // wagon
    p.box(-4.0, 2.75, 0, 6.8, 0.1, 2.5, '#6b4a2a');
    p.box(-9.0, 1.6, 0, 0.2, 0.3, 0.3, TRIM);
    return p;
  }
  function bodyOldcar(col) {
    var p = new Parts();
    p.box(0, 0.62, 0, 3.4, 0.5, 1.5, col, { top: 0.98 });
    p.box(1.25, 0.95, 0, 1.2, 0.5, 1.4, shade(col, 1.12), { top: 0.9 });                         // bonnet
    p.box(-0.5, 1.15, 0.7, 1.8, 0.5, 0.08, col); p.box(-0.5, 1.15, -0.7, 1.8, 0.5, 0.08, col);
    p.box(-0.75, 1.0, 0, 0.5, 0.4, 1.2, '#6b4a34'); p.box(0.1, 1.0, 0, 0.5, 0.4, 1.2, '#6b4a34');   // seats
    p.box(0.7, 1.45, 0, 0.06, 0.55, 1.3, GLASS, { rz: -0.15 });
    p.box(1.8, 0.95, 0.5, 0.2, 0.2, 0.2, '#e0b24a'); p.box(1.8, 0.95, -0.5, 0.2, 0.2, 0.2, '#e0b24a');
    p.box(-1.5, 1.55, 0, 1.2, 0.07, 1.3, shade(col, 0.6));
    person(p, -0.7, 0.85, 0.2, '#6a6a5a', { h: 0.7, helmet: '#2a2a2a' });
    return p;
  }
  function bodyWagon() {
    var p = new Parts();
    p.box(-1.5, 1.05, 0, 3.9, 0.3, 2.1, WOOD_WHEEL);
    p.box(-1.5, 1.5, 1.05, 3.9, 0.6, 0.1, '#7a5a3a'); p.box(-1.5, 1.5, -1.05, 3.9, 0.6, 0.1, '#7a5a3a'); p.box(-3.45, 1.5, 0, 0.1, 0.6, 2.1, '#7a5a3a');
    for (var i = 0; i < 3; i++) for (var j = 0; j < 2; j++) p.box(-2.6 + i * 1.1, 2.0, -0.5 + j * 1.0, 0.9, 0.5, 0.9, i % 2 ? '#a8794a' : '#8a6238');   // sacks / crates
    p.box(1.0, 1.1, 0, 1.6, 0.07, 0.07, '#7a5a3c');
    horse(p, 2.4, -0.6, '#4a3a2a', { s: 1.05, z: 0.35 }); horse(p, 2.4, -0.6, '#6b5a4a', { s: 1.05, z: -0.35 });
    p.box(0.3, 1.9, 0, 0.5, 0.5, 0.6, '#3a3a4a');
    return p;
  }
  Object.assign(BODIES, { hunter: bodyHunter, furcart: bodyFurcart, mammoth: bodyMammoth, oxcart: bodyOxcart, chariot: bodyChariot, legion: bodyLegion, horsecart: bodyHorsecart, carriage: bodyCarriage, knights: bodyKnights, loco: bodyLoco, oldcar: bodyOldcar, wagon: bodyWagon });
  Object.assign(BODY, { hunter: '#8a5a34', furcart: '#a8794a', mammoth: '#6b4a34', oxcart: '#9a6b3a', chariot: '#b24a3a', legion: '#a83a32', horsecart: '#8a6238', carriage: '#6a3a4a', knights: '#9a9ea4', loco: '#2f3438', oldcar: '#2f4a3a', wagon: '#7a5a3a' });
  // which wheels of a vehicle are drawn (the animals' legs are part of the body model)
  var WHEEL_MASK = { hunter: [0, 0], mammoth: [0, 0], legion: [0, 0], knights: [0, 0], chariot: [1, 0] };
  var WOOD_WHEELED = { furcart: 0.9, oxcart: 1.7, chariot: 1.3, horsecart: 1.8, carriage: 1.5, wagon: 1.9 };

  // ---- vessels (origin: waterline centre, x = bow direction, top = free height above the water that the vessel may use) ----
  function vesselGeometry(style, len, beam, top, hull, cabin) {
    if (VESSELS[style]) return VESSELS[style](Math.max(4, len), Math.max(1.8, beam), top, hull, cabin).geometry();       // v3.4: r3d-zmodels.js
    var p = new Parts(), L = Math.max(4, len), D = Math.max(1.8, beam), i;
    var mast = Math.max(1.2, top - 0.35);
    if (style === 'raft') {
      for (i = 0; i < 7; i++) p.cyl(0, 0.12, -D / 2 + 0.15 + i * (D - 0.3) / 6, 0.2, L, i % 2 ? hull : shade(hull, 0.88), { n: 8, axis: 'x' });
      for (i = 0; i < 3; i++) p.box(-L / 2 + 0.7 + i * (L - 1.4) / 2, 0.4, 0, 0.2, 0.08, D + 0.1, '#5a3a22');
      p.box(L * 0.15, 0.8, 0, 0.1, Math.min(1.4, mast), 0.1, '#7a5a3c'); p.box(L * 0.15 - 0.2, Math.min(1.4, mast) * 0.6 + 0.2, 0, 0.6, 0.55, 0.05, HIDE);
      return p.geometry();
    }
    var h = Math.min(1.3, Math.max(0.7, top * 0.2));
    if (style === 'nileboat') {
      p.prism([[-L / 2, h * 1.9], [-L / 2 + 0.9, 0], [L / 2 - 1.4, 0], [L / 2, h * 1.7]], 0, D, hull);
      p.box(0, h * 0.9, 0, L - 2.4, 0.12, D * 0.85, shade(hull, 0.8));
      p.box(-L * 0.28, h + 0.75, 0, L * 0.25, 1.1, D * 0.6, cabin, { top: 0.8 });
      p.box(L * 0.1, mast / 2 + h * 0.8, 0, 0.14, mast, 0.14, '#7a5a3c');
      p.box(L * 0.1, Math.min(mast, top) - 0.9 + h * 0.4, 0, 0.1, 1.4, D * 1.2, '#efe6cf'); p.box(L * 0.1, Math.min(mast, top) - 0.2 + h * 0.4, 0, 0.14, 0.12, D * 1.3, '#7a5a3c');
      return p.geometry();
    }
    if (style === 'galley') {
      p.prism([[-L / 2, h * 1.5], [-L / 2 + 0.8, 0], [L / 2 - 1.8, 0], [L / 2, h * 0.9], [L / 2, h * 1.4]], 0, D, hull);
      p.box(L / 2 + 0.3, -0.05, 0, 1.4, 0.18, 0.35, '#4a3a2a');                                            // ram
      p.box(0, h * 1.5 + 0.06, 0, L - 0.6, 0.1, D * 0.9, shade(hull, 0.8));
      for (i = 0; i < 8; i++) { var ox = -L / 2 + 1.6 + i * (L - 3.4) / 7; p.box(ox, h * 1.2, D / 2 + 0.55, 0.06, 0.06, 1.6, '#c9b27c', { ry: 0.0 }); p.box(ox, h * 1.2, -D / 2 - 0.55, 0.06, 0.06, 1.6, '#c9b27c'); }
      p.box(L * 0.05, mast / 2 + h, 0, 0.14, mast, 0.14, '#7a5a3c');
      var sh = Math.max(1.0, mast * 0.55);
      p.box(L * 0.05, mast - sh / 2 + h * 0.6, 0, 0.08, sh, D * 1.1, '#e6d9c0'); p.box(L * 0.05 + 0.05, mast - sh / 2 + h * 0.6, 0, 0.02, sh, 0.5, '#a83a32');
      p.box(-L * 0.38, h * 1.5 + 0.7, 0, 1.3, 1.3, D * 0.7, cabin, { top: 0.8 });
      return p.geometry();
    }
    if (style === 'cog') {
      p.prism([[-L / 2, h * 1.7], [-L / 2 + 0.9, 0], [L / 2 - 1.6, 0], [L / 2 - 0.1, h * 1.5], [L / 2 - 0.1, h * 1.9], [-L / 2, h * 1.9]], 0, D, hull);
      p.box(0, h * 1.9, 0, L - 0.3, 0.12, D * 0.95, shade(hull, 0.75));
      p.box(L / 2 - 1.3, h * 1.9 + 0.5, 0, 2.0, 1.0, D * 0.9, shade(hull, 0.9));                           // fore castle
      p.box(-L / 2 + 1.5, h * 1.9 + 0.7, 0, 2.6, 1.4, D * 0.9, shade(hull, 0.9));                          // aft castle
      p.box(L * 0.04, mast / 2 + h, 0, 0.18, mast, 0.18, '#7a5a3c');
      var sh2 = Math.max(1.4, mast * 0.5);
      p.box(L * 0.04, mast - sh2 / 2 - 0.5, 0, 0.1, sh2, D * 1.3, '#e8e0cc'); p.box(L * 0.04 + 0.06, mast - sh2 / 2 - 0.5, 0, 0.02, sh2 * 0.8, 0.26, '#b8433a'); p.box(L * 0.04 + 0.06, mast - sh2 / 2 - 0.5, 0, 0.02, 0.26, D * 1.1, '#b8433a');
      p.box(L * 0.04 + 0.4, mast - 0.1, 0, 0.8, 0.4, 0.04, '#b8433a');
      return p.geometry();
    }
    // steamer
    p.prism([[-L / 2, h * 1.5], [-L / 2 + 0.8, 0], [L / 2 - 2.2, 0], [L / 2, h * 1.4], [L / 2, h * 1.7], [-L / 2, h * 1.7]], 0, D, hull);
    p.box(0, h * 1.7 + 0.06, 0, L - 0.4, 0.1, D * 0.95, shade(hull, 0.7));
    var dh = Math.min(2.2, Math.max(1.0, top - h * 1.7 - 0.9));
    p.box(-L * 0.12, h * 1.7 + dh / 2 + 0.1, 0, L * 0.36, dh, D * 0.7, cabin, { top: 0.95 });
    p.box(-L * 0.12, h * 1.7 + dh * 0.62, 0, L * 0.36 + 0.03, Math.min(0.6, dh * 0.3), D * 0.7 + 0.04, GLASS);
    var fh = Math.max(1.0, Math.min(top - h * 1.7 - 0.2, 3.6));
    p.cyl(-L * 0.02, h * 1.7 + fh / 2 + 0.2, 0, 0.5, fh, '#2a2e34', { n: 10, axis: 'y', r2: 0.4 }); p.cyl(-L * 0.02, h * 1.7 + fh - 0.15, 0, 0.52, 0.34, '#b8433a', { n: 10, axis: 'y' });
    p.cyl(-L * 0.28, h * 1.7 + 0.55, D / 2 + 0.2, Math.min(1.3, h * 1.2 + 0.4), 0.3, '#5a3a2a', { n: 10 }); p.cyl(-L * 0.28, h * 1.7 + 0.55, -D / 2 - 0.2, Math.min(1.3, h * 1.2 + 0.4), 0.3, '#5a3a2a', { n: 10 });   // paddle wheels
    return p.geometry();
  }

  // ---- plants ----
  function zeitTree(type, p, r, c, trunk, h, s, seed) {
    switch (type) {
      case 'fern':
        p.box(0.05 * s, 0.6 * h, 0, 0.22 * s, 1.2 * h, 0.22 * s, trunk, { rz: -0.05 });
        for (var i = 0; i < 7; i++) { var a = i / 7 * Math.PI * 2; p.prism([[0, 0], [1.2 * s, 0.35 * s], [2.1 * s, -0.5 * s], [1.2 * s, -0.12 * s]], 0, 0.4 * s, i % 2 ? c : shade(c, 1.1), { x: 0.1 * s, y: 1.25 * h, ry: a }); }
        return true;
      case 'cypress':
        p.box(0, 0.4 * h, 0, 0.2 * s, 0.8 * h, 0.2 * s, trunk);
        p.cone(0, 0.5 * h, 0, 0.7 * s, 3.4 * h, c, { n: 6, rot: 0.3 });
        return true;
      case 'chimney':
        p.cyl(0, 2.2 * h, 0, 0.55 * s, 4.4 * h, '#a8553f', { n: 8, axis: 'y', r2: 0.4 * s });
        p.cyl(0, 4.3 * h, 0, 0.5 * s, 0.4 * s, '#4a3a34', { n: 8, axis: 'y' });
        p.blob(0.5 * s, 5.2 * h, 0, 0.9 * s, '#8a8e94', { jit: 0.1, sy: 0.7, seed: seed }); p.blob(1.3 * s, 5.9 * h, 0.1, 0.65 * s, '#a4a8ae', { jit: 0.1, sy: 0.7, seed: seed + 1 });
        return true;
      case 'oakfull':
        p.box(0, 0.7 * h, 0, 0.5 * s, 1.4 * h, 0.5 * s, trunk);
        p.blob(0, 2.1 * h, 0, 1.35 * s, c, { jit: 0.06, sy: 0.9, seed: seed }); p.blob(0.7 * s, 1.6 * h, 0.3 * s, 0.9 * s, shade(c, 1.1), { jit: 0.06, sy: 0.9, seed: seed + 2 });
        return true;
      default: return false;
    }
  }

  // ---- v3.4: hooks for r3d-zmodels.js (hand-built Zeitreise models with animated parts) ----
  var PARTS = {}, WHEEL_STYLE = {}, WHEEL_GEOM = null, VESSELS = {}, VESSEL_ANIMS = null, partsCache = {};
  function register(o) {
    if (o.bodies) { Object.keys(o.bodies).forEach(function (k) { BODIES[k] = o.bodies[k]; }); bodyCache = {}; }
    if (o.parts) Object.keys(o.parts).forEach(function (k) { PARTS[k] = o.parts[k]; });
    if (o.wheelStyle) Object.keys(o.wheelStyle).forEach(function (k) { WHEEL_STYLE[k] = o.wheelStyle[k]; });
    if (o.wheelGeometry) WHEEL_GEOM = o.wheelGeometry;
    if (o.vessels) Object.keys(o.vessels).forEach(function (k) { VESSELS[k] = o.vessels[k]; });
    if (o.vesselAnims) VESSEL_ANIMS = o.vesselAnims;
    partsCache = {};
  }
  /** animated parts of a vehicle: [{ geom, pivot, kind: 'swing' (distance) | 'sway' (time), amp, phase, stride, scale }] */
  function vehicleParts(type, custom) {
    if (!PARTS[type]) return null;
    var color = custom || BODY[type] || '#c2573f', k = type + '|' + color;
    if (partsCache[k]) return partsCache[k];
    var list = PARTS[type](color).map(function (a) { return { geom: a.parts.geometry(), pivot: a.pivot, kind: a.kind, amp: a.amp, phase: a.phase, stride: a.stride, scale: a.scale || 1 }; });
    partsCache[k] = list;
    return list;
  }
  function vesselParts(style, len, beam, top, hull) {
    if (!VESSEL_ANIMS) return [];
    return VESSEL_ANIMS(style, Math.max(4, len), Math.max(1.8, beam), top, hull).map(function (a) { return { geom: a.parts.geometry(), pivot: a.pivot, kind: a.kind, amp: a.amp, phase: a.phase, stride: a.stride, scale: a.scale || 1 }; });
  }

  R3.m = {
    register: register, vehicleParts: vehicleParts, vesselParts: vesselParts, BODIES: BODIES, PARTS: PARTS, VESSELS: VESSELS,
    vesselGeometry: vesselGeometry,
    vehicleBody: vehicleBody, vehicleWheel: vehicleWheel, shipGeometry: shipGeometry, crateGeometry: crateGeometry,
    flagPole: flagPole, flagCloth: flagCloth, signGeometry: signGeometry, checkpointGeometry: checkpointGeometry, pylonGeometry: pylonGeometry,
    plateGeometry: plateGeometry, foundationGeometry: foundationGeometry, hazardBarGeometry: hazardBarGeometry,
    treeParts: treeParts, rockParts: rockParts, cloudParts: cloudParts,
  };
})(globalThis.BB = globalThis.BB || {});
