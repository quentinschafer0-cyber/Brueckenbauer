/*
 * Brückenbauer – r3d-zmodels.js (v3.4)
 * ----------------------------------------------------------------------------
 * Hand-built low-poly models of the Zeitreise: people, animals (horse, ox, mammoth), carts, chariot, carriage, locomotive, old car,
 * ships and the flags' companions. Same clean style as r3d-models.js (few flat-shaded forms, muted epoch colours), seen from the side:
 * the silhouette reads from the +z side, x points forward, y = 0 is the height of the axles (the ground is at y = -wheelRadius).
 *
 * Animated parts (legs, tails, oars …) are returned separately by PARTS[type]: a list of
 *   { parts, pivot: [x, y, z], kind: 'swing' | 'sway' | 'bob', amp, phase, stride }
 * and are rotated by the renderer with the distance the vehicle has travelled (no gliding).
 *
 * Registered into R3.m with R3.m.register(...): bodies, parts, wheel styles and vessels.
 */
(function (BB) {
  'use strict';

  var R3 = BB.R3 = BB.R3 || {};
  var U = R3.u, M = R3.m, Parts = U.Parts, shade = U.shade, mix = U.mix;

  var GLASS = '#3b556b', IRON = '#33383d', WOOD = '#6b4a2a', WOOD2 = '#8a5a34', WOOD3 = '#a8794a', STRAW = '#d6c284', LEATHER = '#5a3a24', SKIN = '#d9ad86', ROPE = '#c9b27c';

  /** scaled / shifted drawing helper: every size and position is multiplied by s and moved by (ox, oy, oz) */
  function X(p, s, ox, oy, oz) {
    ox = ox || 0; oy = oy || 0; oz = oz || 0;
    return {
      p: p, s: s,
      box: function (x, y, z, w, h, d, c, o) { p.box(ox + x * s, oy + y * s, oz + z * s, w * s, h * s, d * s, c, o); },
      prism: function (pts, z, d, c, o) {
        o = o || {};
        var q = pts.map(function (a) { return [a[0] * s, a[1] * s]; });
        p.prism(q, oz + z * s, d * s, c, { x: ox + (o.x || 0) * s, y: oy + (o.y || 0) * s, rz: o.rz, ry: o.ry });
      },
      cyl: function (x, y, z, r, l, c, o) { p.cyl(ox + x * s, oy + y * s, oz + z * s, r * s, l * s, c, o && o.r2 !== undefined ? { n: o.n, axis: o.axis, r2: o.r2 * s } : o); },
      cone: function (x, y0, z, r, h, c, o) { p.cone(ox + x * s, oy + y0 * s, oz + z * s, r * s, h * s, c, o); },
      blob: function (x, y, z, r, c, o) { p.blob(ox + x * s, oy + y * s, oz + z * s, r * s, c, o); },
    };
  }
  function anim(list, parts, pivot, kind, amp, phase, stride, scale) { list.push({ parts: parts, pivot: pivot, kind: kind, amp: amp, phase: phase || 0, stride: stride || 2.4, scale: scale || 1 }); }

  // =============================================================================================
  // people
  // =============================================================================================
  /**
   * A person standing on y0 at (x, z). o: h (scale), tunic, legs, cloak, hair, helmet: 'cap' | 'bronze' | 'iron' | 'kettle' | 'leather',
   * helmetCol, spear, shield: 'round' | 'roman' | 'kite', shieldCol, belt, sit (legs bent forward, no animation), walk (animated legs),
   * stride (m per step cycle), amp.
   */
  function person(Xs, an, o) {
    var h = o.h || 1, x = o.x || 0, y0 = o.y0 || 0, z = o.z || 0, s = Xs.s * h;
    var P = Xs.p, ox = x * Xs.s, oy = y0 * Xs.s, oz = z * Xs.s;
    var Q = X(P, s, ox, oy, oz);
    var tunic = o.tunic || '#a8793a', legsC = o.legs || '#5a4632', belt = o.belt || '#3a2a1c', hair = o.hair || '#3a2a1c', skin = o.skin || SKIN;
    // legs
    var legGeom = function (zz) {
      var l = new Parts(), L = X(l, 1, 0, 0, 0);
      L.box(0, -0.22, zz, 0.18, 0.46, 0.17, legsC, { top: 0.8 });
      L.box(0, -0.66, zz, 0.13, 0.44, 0.13, legsC);
      L.box(0.07, -0.89, zz, 0.28, 0.1, 0.15, '#4a3a2a');
      return l;
    };
    if (o.sit) {
      Q.box(0.3, 0.52, 0.1, 0.55, 0.16, 0.16, legsC); Q.box(0.3, 0.52, -0.1, 0.55, 0.16, 0.16, legsC);
      Q.box(0.62, 0.3, 0.1, 0.14, 0.5, 0.14, legsC); Q.box(0.62, 0.3, -0.1, 0.14, 0.5, 0.14, legsC);
    } else if (o.walk === false) {
      Q.box(0, 0.45, 0.1, 0.16, 0.9, 0.16, legsC); Q.box(0, 0.45, -0.1, 0.16, 0.9, 0.16, legsC);
    } else {
      var amp = o.amp || 0.55, st = o.stride || 1.5, ph = o.phase || 0;
      [[0.1, 0], [-0.1, Math.PI]].forEach(function (a) {
        anim(an, legGeom(0), [ox, oy + 0.9 * s, oz + a[0] * s], 'swing', amp, ph + a[1], st, s);
      });
    }
    // body
    var hemY = o.long ? 0.55 : 0.8;
    Q.box(0, 1.17, 0, 0.32, 0.64, 0.44, tunic, { top: 0.86 });
    Q.box(0, 0.95, 0, 0.34, 0.07, 0.46, belt);
    if (o.long) Q.box(0, 0.66, 0, 0.38, 0.5, 0.46, tunic, { top: 0.82 });                 // long tunic / robe
    else Q.box(0, 0.8, 0, 0.36, 0.3, 0.46, tunic, { top: 0.88 });                         // short tunic
    if (o.cloak) { Q.box(-0.14, 1.12, 0, 0.1, 0.8, 0.52, o.cloak, { rz: 0.06 }); Q.box(0, 1.5, 0, 0.36, 0.12, 0.52, o.cloak); }
    // arms: one holds the spear forward, the other swings / hangs
    Q.box(0.04, 1.28, 0.27, 0.12, 0.5, 0.12, tunic, { rz: 0.2 }); Q.box(0.2, 1.0, 0.27, 0.11, 0.3, 0.11, skin, { rz: 0.2 });
    Q.box(0.0, 1.3, -0.27, 0.12, 0.5, 0.12, tunic, { rz: -0.1 }); Q.box(-0.02, 1.0, -0.27, 0.11, 0.3, 0.11, skin);
    // head
    Q.blob(0.02, 1.62, 0, 0.16, skin, { jit: 0.03, seed: 4 });
    Q.box(0.14, 1.6, 0, 0.08, 0.07, 0.1, shade(skin, 0.9));                               // nose
    if (!o.helmet) Q.blob(-0.04, 1.66, 0, 0.17, hair, { jit: 0.05, sy: 0.7, seed: 6 });
    else if (o.helmet === 'cap') Q.blob(0, 1.68, 0, 0.18, o.helmetCol || LEATHER, { jit: 0.03, sy: 0.65, seed: 8 });
    else if (o.helmet === 'leather') { Q.blob(0, 1.68, 0, 0.19, o.helmetCol || LEATHER, { jit: 0.03, sy: 0.7, seed: 8 }); }
    else if (o.helmet === 'bronze') {
      Q.blob(0, 1.7, 0, 0.19, o.helmetCol || '#c9a24a', { jit: 0.02, sy: 0.75, seed: 8 });
      Q.box(0, 1.9, 0, 0.5, 0.12, 0.06, '#b8433a', { top: 0.6 }); Q.box(0, 1.84, 0, 0.1, 0.12, 0.06, '#b8433a');                 // crest
    } else if (o.helmet === 'iron') {
      Q.blob(0, 1.7, 0, 0.19, o.helmetCol || '#9aa0a8', { jit: 0.02, sy: 0.85, seed: 8 }); Q.box(0.17, 1.62, 0, 0.05, 0.22, 0.05, '#8a9098');
    } else if (o.helmet === 'kettle') {
      Q.blob(0, 1.68, 0, 0.17, o.helmetCol || '#8a9098', { jit: 0.02, sy: 0.6, seed: 8 }); Q.box(0, 1.74, 0, 0.5, 0.05, 0.5, o.helmetCol || '#8a9098', { top: 0.4 });
    }
    if (o.spear) { Q.box(0.34, 1.3, 0.3, 0.06, 1.9, 0.06, '#7a5a3c', { rz: -0.12 }); Q.cone(0.51, 2.2, 0.3, 0.07, 0.28, o.spearTip || '#9aa0a8', { n: 4 }); }
    if (o.shield === 'round') { Q.cyl(0.02, 1.1, 0.4, 0.34, 0.07, o.shieldCol || '#b8433a', { n: 10 }); Q.cyl(0.02, 1.1, 0.45, 0.09, 0.05, '#d9b24a', { n: 8 }); }
    else if (o.shield === 'roman') { Q.box(0.02, 1.05, 0.42, 0.62, 0.9, 0.07, o.shieldCol || '#a83a32'); Q.box(0.02, 1.05, 0.47, 0.14, 0.34, 0.05, '#d9b24a'); }
    else if (o.shield === 'kite') { Q.prism([[-0.28, 0.2], [0.28, 0.2], [0.3, -0.25], [0, -0.7], [-0.3, -0.25]], 0.42, 0.07, o.shieldCol || '#2f4a7a', { y: 1.15 }); Q.box(0, 1.15, 0.47, 0.5, 0.07, 0.05, '#e8d28a'); }
  }

  // =============================================================================================
  // animals
  // =============================================================================================
  /** a leg built around its hip (0,0,0): upper / lower part and hoof, pointing down */
  function legParts(len, w, col, hoof, sock) {
    var l = new Parts(), L = X(l, 1, 0, 0, 0), up = len * 0.5, lo = len * 0.46;
    L.box(0, -up / 2, 0, w, up, w, col, { top: 0.7 });
    L.box(0, -up - lo / 2, 0, w * 0.62, lo, w * 0.62, sock || col);
    L.box(w * 0.08, -len + 0.04, 0, w * 0.95, 0.09, w * 0.98, hoof || '#2a221c');
    return l;
  }
  /**
   * A horse (s = scale, 1 = a horse about 1.5 m at the withers), standing on y0, centred on x, at depth z. Returns nothing: draws into
   * Xs and pushes the animated legs / tail into `an`. o: col, mane, cloth (caparison colour), blaze.
   */
  function horse(Xs, an, o) {
    var s = (o.s || 1) * Xs.s, col = o.col || '#8a5a34', dark = shade(col, 0.62), mane = o.mane || shade(col, 0.45), z = o.z || 0;
    var ox = (o.x || 0) * Xs.s + (Xs.ox || 0), oy = (o.y0 || 0) * Xs.s + (Xs.oy || 0), oz = z * Xs.s + (Xs.oz || 0);
    var Q = X(Xs.p, s, ox, oy, oz);
    // barrel (side outline, convex)
    Q.prism([[-0.82, 0.86], [0.7, 0.8], [0.96, 1.05], [0.9, 1.38], [0.25, 1.52], [-0.5, 1.5], [-0.96, 1.32], [-0.98, 1.05]], 0, 0.54, col);
    Q.box(0.1, 1.5, 0, 1.4, 0.05, 0.44, shade(col, 1.08));                               // back line
    // neck and head
    Q.box(1.12, 1.68, 0, 0.98, 0.36, 0.3, col, { rz: 0.9 });
    Q.prism([[0, 0.04], [0.12, 0.2], [0.3, 0.2], [0.64, -0.06], [0.66, -0.23], [0.5, -0.27], [0.1, -0.14]], 0, 0.22, col, { x: 1.4, y: 2.0, rz: -0.28 });
    if (o.blaze) Q.box(1.82, 1.99, 0, 0.3, 0.05, 0.05, '#f1ead8', { rz: -0.5 });
    Q.box(1.43, 2.2, 0.08, 0.07, 0.17, 0.06, dark, { rz: 0.1 }); Q.box(1.43, 2.2, -0.08, 0.07, 0.17, 0.06, dark, { rz: 0.1 });   // ears
    for (var i = 0; i < 5; i++) { var tt = (i - 2) * 0.2; Q.box(1.12 + 0.62 * tt - 0.78 * 0.17, 1.68 + 0.78 * tt + 0.62 * 0.17, 0, 0.1, 0.24, 0.07, mane, { rz: 0.7 }); }   // mane
    Q.box(1.45, 2.23, 0, 0.12, 0.12, 0.06, mane);
    if (o.cloth) { Q.box(0.05, 1.28, 0, 1.5, 0.62, 0.62, o.cloth, { top: 0.95 }); Q.box(0.05, 1.0, 0, 1.4, 0.12, 0.64, shade(o.cloth, 0.8)); }   // caparison / harness cloth
    if (o.harness) { Q.box(0.9, 1.38, 0, 0.1, 0.6, 0.58, LEATHER); Q.box(1.18, 1.82, 0, 0.1, 0.36, 0.34, LEATHER); }
    // tail (sways)
    var tail = new Parts(), T = X(tail, 1, 0, 0, 0);
    T.prism([[0, 0.05], [0.12, 0], [0.1, -0.5], [0.0, -0.85], [-0.12, -0.45]], 0, 0.12, mane);
    anim(an, tail, [ox - 0.95 * s, oy + 1.32 * s, oz], 'sway', 0.28, 0, 2.0, s);
    // legs
    var legs = [[0.62, 0.2, 0], [0.62, -0.2, Math.PI], [-0.68, 0.2, Math.PI], [-0.68, -0.2, 0]];
    legs.forEach(function (l) {
      var lg = legParts(1.0, 0.17, col, null, o.socks ? '#efe6d2' : shade(col, 0.9));
      anim(an, lg, [ox + l[0] * s, oy + 1.02 * s, oz + l[1] * s], 'swing', 0.5, l[2], o.stride || 2.2, s);
    });
  }

  /** an ox: heavy body, low head, horns (s = scale) */
  function ox(Xs, an, o) {
    var s = (o.s || 1) * Xs.s, col = o.col || '#7a5638', dark = shade(col, 0.62), z = o.z || 0;
    var ox0 = (o.x || 0) * Xs.s + (Xs.ox || 0), oy = (o.y0 || 0) * Xs.s + (Xs.oy || 0), oz = z * Xs.s + (Xs.oz || 0);
    var Q = X(Xs.p, s, ox0, oy, oz);
    Q.prism([[-0.85, 0.74], [0.7, 0.72], [0.92, 0.95], [0.9, 1.3], [0.4, 1.46], [-0.4, 1.42], [-0.92, 1.25], [-0.95, 0.95]], 0, 0.62, col);
    Q.blob(0.35, 1.5, 0, 0.36, shade(col, 1.08), { jit: 0.06, sy: 0.75, sx: 1.2, seed: 3 });                         // hump
    Q.box(0.95, 1.1, 0, 0.5, 0.62, 0.42, col, { rz: -0.5 });                                                        // short neck
    Q.prism([[0, 0.2], [0.36, 0.22], [0.62, -0.1], [0.6, -0.34], [0.2, -0.4], [-0.02, -0.2]], 0, 0.34, col, { x: 1.12, y: 1.18, rz: -0.12 });   // head
    Q.box(1.7, 0.86, 0, 0.18, 0.22, 0.32, '#cfa88a');                                                              // muzzle
    Q.box(1.2, 1.4, 0.2, 0.5, 0.07, 0.07, '#e9e0c9', { rz: 0.55 }); Q.box(1.2, 1.4, -0.2, 0.5, 0.07, 0.07, '#e9e0c9', { rz: 0.55 });   // horns
    Q.box(1.04, 1.5, 0.4, 0.2, 0.05, 0.05, '#e9e0c9', { rz: 1.0 }); Q.box(1.04, 1.5, -0.4, 0.2, 0.05, 0.05, '#e9e0c9', { rz: 1.0 });
    Q.box(0.62, 0.78, 0, 0.36, 0.32, 0.3, dark, { rz: -0.1 });                                                      // dewlap
    var tail = new Parts(), T = X(tail, 1, 0, 0, 0);
    T.box(0, -0.4, 0, 0.06, 0.8, 0.06, dark); T.blob(0, -0.85, 0, 0.1, shade(dark, 0.8), { jit: 0.05, seed: 2 });
    anim(an, tail, [ox0 - 0.92 * s, oy + 1.2 * s, oz], 'sway', 0.22, 0, 2.0, s);
    [[0.6, 0.24, 0], [0.6, -0.24, Math.PI], [-0.62, 0.24, Math.PI], [-0.62, -0.24, 0]].forEach(function (l) {
      anim(an, legParts(0.82, 0.22, col, '#1f1914', shade(col, 0.85)), [ox0 + l[0] * s, oy + 0.84 * s, oz + l[1] * s], 'swing', 0.42, l[2], 1.7, s);
    });
  }

  /** a woolly mammoth (s = scale; 1 fits the physical vehicle 5.6 m × 3.6 m); the ground is at y0 */
  function mammoth(Xs, an, o) {
    var s = (o.s || 1) * Xs.s, col = o.col || '#6b4a34', dark = shade(col, 0.68), light = shade(col, 1.16);
    var ox0 = (o.x || 0) * Xs.s + (Xs.ox || 0), oy = (o.y0 || 0) * Xs.s + (Xs.oy || 0), oz = (o.z || 0) * Xs.s + (Xs.oz || 0);
    var Q = X(Xs.p, s, ox0, oy, oz), i;
    // body: one rounded outline with the high shoulder dome built in
    Q.prism([[-1.95, 1.15], [-0.8, 1.0], [0.8, 1.0], [1.7, 1.25], [1.95, 2.1], [1.75, 3.0], [1.1, 3.45], [0.2, 3.55], [-0.7, 3.4], [-1.6, 3.0], [-2.1, 2.4], [-2.15, 1.7]], 0, 1.9, col, { x: -0.1 });
    Q.prism([[-1.3, 3.0], [-0.2, 3.7], [0.9, 3.5], [1.2, 3.0]], 0, 1.5, light, { x: -0.1 });                                        // shaggy hump
    for (i = 0; i < 10; i++) Q.prism([[0, 0], [0.36, 0], [0.18, -0.5 - (i % 3) * 0.14]], 0.0, 1.94, i % 2 ? dark : shade(col, 0.82), { x: -1.95 + i * 0.4, y: 1.18 });   // long hair of the belly
    for (i = 0; i < 6; i++) Q.prism([[0, 0], [0.3, 0], [0.12, -0.45]], 0.0, 1.0, shade(col, 0.78), { x: 1.55 + (i % 2) * 0.1, y: 1.0 - 0.0, rz: 0 });
    for (i = 0; i < 5; i++) { var sx0 = -0.7 + (i % 3) * 0.35, sl = 1.7 - (i % 2) * 0.4; Q.box(sx0, 1.75 + i * 0.35, 0.97, sl, 0.07, 0.04, i % 2 ? dark : light, { rz: -0.05 }); Q.box(sx0 + 0.3, 1.75 + i * 0.35, -0.97, sl, 0.07, 0.04, i % 2 ? dark : light, { rz: -0.05 }); }   // streaks of long hair on the flanks
    // head with a steep forehead
    Q.prism([[1.5, 1.2], [3.0, 1.1], [3.35, 1.9], [3.2, 3.1], [2.5, 3.75], [1.7, 3.7], [1.4, 2.8]], 0, 1.5, col, { x: -0.1 });
    Q.blob(2.15, 3.65, 0, 0.7, light, { jit: 0.07, sy: 0.55, sx: 1.0, seed: 6 });                                                      // tuft on the forehead
    Q.box(1.75, 2.7, 0.9, 0.9, 1.1, 0.1, dark, { rz: -0.2 }); Q.box(1.75, 2.7, -0.9, 0.9, 1.1, 0.1, dark, { rz: -0.2 });          // ears
    Q.box(2.95, 2.6, 0.76, 0.14, 0.14, 0.05, '#1a120c'); Q.box(2.95, 2.6, -0.76, 0.14, 0.14, 0.05, '#1a120c');                        // eyes
    // tusks: down, forward, up – a long curve each side
    [0.74, -0.74].forEach(function (zz) {
      Q.box(3.0, 1.6, zz, 0.9, 0.2, 0.2, '#efe6cf', { rz: -1.15 }); Q.box(3.4, 0.95, zz, 0.9, 0.18, 0.18, '#efe6cf', { rz: -0.15 }); Q.box(4.1, 0.95, zz, 0.9, 0.15, 0.15, '#efe6cf', { rz: 0.5 }); Q.box(4.55, 1.3, zz, 0.5, 0.11, 0.11, '#efe6cf', { rz: 1.0 });
    });
    // trunk (animated): hangs from the face, curls forward at the tip
    var trunk = new Parts(), T = X(trunk, 1, 0, 0, 0);
    T.box(0.0, -0.45, 0, 0.95, 0.95, 0.8, col, { top: 0.8 }); T.box(0.08, -1.2, 0, 0.78, 0.8, 0.66, col, { top: 0.8 }); T.box(0.24, -1.74, 0, 0.6, 0.5, 0.54, dark, { top: 0.7, rz: -0.25 }); T.box(0.55, -1.98, 0, 0.8, 0.28, 0.4, dark, { rz: -0.4 });
    for (i = 0; i < 4; i++) { T.box(0.0, -0.3 - i * 0.4, 0.42, 0.8, 0.04, 0.03, dark); T.box(0.0, -0.3 - i * 0.4, -0.42, 0.8, 0.04, 0.03, dark); }                                                  // wrinkles
    anim(an, trunk, [ox0 + 3.25 * s, oy + 2.3 * s, oz], 'sway', 0.1, 0, 3.2, s);
    var tail = new Parts(), TT = X(tail, 1, 0, 0, 0);
    TT.box(0, -0.45, 0, 0.1, 0.9, 0.1, dark); TT.blob(0, -0.95, 0, 0.16, shade(dark, 0.8), { jit: 0.05, seed: 2 });
    anim(an, tail, [ox0 - 2.2 * s, oy + 2.6 * s, oz], 'sway', 0.2, 1, 2.6, s);
    [[1.3, 0.6, 0], [1.3, -0.6, Math.PI], [-1.35, 0.6, Math.PI], [-1.35, -0.6, 0]].forEach(function (l) {
      var lg = new Parts(), L = X(lg, 1, 0, 0, 0);
      L.box(0, -0.3, 0, 0.82, 0.62, 0.78, dark, { top: 0.84 }); L.box(0, -0.85, 0, 0.7, 0.46, 0.66, shade(dark, 0.92)); L.box(0.1, -1.12, 0, 0.8, 0.12, 0.72, '#2f251d');
      for (var t = 0; t < 3; t++) L.box(0.5, -1.09, -0.22 + t * 0.22, 0.12, 0.1, 0.1, '#d8ccb0');                                    // toenails
      anim(an, lg, [ox0 + l[0] * s, oy + 1.2 * s, oz + l[1] * s], 'swing', 0.3, l[2], 3.0, s);
    });
  }

  // =============================================================================================
  // carts and wagons
  // =============================================================================================
  /** a wooden bed: floor of planks, side rails with stakes. x0..x1 along x, centre height y, width w (z) */
  function bed(Q, x0, x1, y, w, o) {
    o = o || {};
    var len = x1 - x0, cx = (x0 + x1) / 2, n = 5, c = o.col || WOOD2, k;
    for (k = 0; k < n; k++) Q.box(cx, y, -w / 2 + (k + 0.5) * w / n, len, 0.1, w / n - 0.01, k % 2 ? c : shade(c, 0.88));
    Q.box(cx, y - 0.14, w / 2 - 0.12, len, 0.14, 0.12, WOOD); Q.box(cx, y - 0.14, -w / 2 + 0.12, len, 0.14, 0.12, WOOD);           // chassis beams
    if (o.rails !== false) {
      var h = o.railH || 0.42;
      [w / 2, -w / 2].forEach(function (zz) {
        Q.box(cx, y + h, zz, len, 0.07, 0.08, shade(c, 1.1));
        Q.box(cx, y + h * 0.5, zz, len, h * 0.5, 0.05, shade(c, 0.9));
        for (var j = 0; j <= Math.max(2, Math.round(len / 0.9)); j++) Q.box(x0 + j * len / Math.max(2, Math.round(len / 0.9)), y + h * 0.55, zz, 0.07, h + 0.1, 0.09, WOOD);
      });
      Q.box(x0, y + h * 0.5, 0, 0.07, h, w, shade(c, 0.9)); Q.box(x1, y + h * 0.5, 0, 0.07, h * 0.7, w, shade(c, 0.9));
    }
  }
  function axle(Q, xs, w) { xs.forEach(function (x) { Q.cyl(x, 0, 0, 0.09, w, '#3c2a1a', { n: 6 }); }); }
  /** barrel / sack / crate load */
  function barrel(Q, x, y, z, r, h, c) { Q.cyl(x, y + h / 2, z, r, h, c || WOOD3, { n: 9, axis: 'y' }); Q.cyl(x, y + h * 0.28, z, r * 1.04, 0.05, '#3a3a3e', { n: 9, axis: 'y' }); Q.cyl(x, y + h * 0.72, z, r * 1.04, 0.05, '#3a3a3e', { n: 9, axis: 'y' }); }
  function sack(Q, x, y, z, r, c) { Q.blob(x, y + r * 0.8, z, r, c || STRAW, { jit: 0.1, sy: 0.82, seed: 5 + Math.round(x * 7)}); }
  function amphora(Q, x, y, z, c) { Q.cyl(x, y + 0.34, z, 0.2, 0.5, c || '#b8693a', { n: 8, axis: 'y', r2: 0.12 }); Q.cyl(x, y + 0.68, z, 0.1, 0.18, shade(c || '#b8693a', 0.85), { n: 8, axis: 'y' }); }

  var BUILD = {};
  // ---- Steinzeit -------------------------------------------------------------------------------
  BUILD.hunter = function (col) {
    var p = new Parts(), an = [], Xs = X(p, 1, 0, 0, 0);
    person(Xs, an, { y0: -0.34, tunic: col, legs: '#6b4a34', cloak: '#6b4a34', hair: '#2a1e16', spear: true, spearTip: '#8d8a82', h: 1.0, stride: 1.4 });
    Xs.box(0.04, 0.58, 0, 0.38, 0.3, 0.5, '#6b4a34', { top: 0.9 });                               // fur wrap
    return { p: p, an: an };
  };
  BUILD.furcart = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0);
    bed(Q, -1.5, 1.5, 0.62, 1.4, { col: '#8a5a34', railH: 0.38 });
    axle(Q, [-0.8, 0.8], 1.6);
    Q.blob(-0.4, 1.12, 0, 0.72, col, { jit: 0.1, sy: 0.55, sx: 1.3, seed: 5 }); Q.blob(0.2, 1.0, 0.2, 0.46, shade(col, 0.85), { jit: 0.1, sy: 0.6, seed: 9 });   // pile of furs
    Q.box(0.2, 1.4, -0.4, 0.5, 0.06, 0.06, '#7a5a3c', { rz: 0.4 });                                 // bundle of spears
    Q.box(2.4, 0.74, 0.34, 1.8, 0.07, 0.07, '#7a5a3c', { rz: 0.06 }); Q.box(2.4, 0.74, -0.34, 1.8, 0.07, 0.07, '#7a5a3c', { rz: 0.06 });  // shafts
    person(Q, an, { x: 3.3, y0: -0.5, z: 0, tunic: '#a8793a', legs: '#6b4a34', cloak: '#7a5a46', hair: '#2a1e16', h: 0.95, stride: 1.4 });      // the puller
    Q.box(3.1, 0.7, 0, 0.9, 0.05, 0.05, ROPE, { rz: 0.1 });
    return { p: p, an: an };
  };
  BUILD.mammoth = function (col) {
    var p = new Parts(), an = [], Xs = X(p, 1, 0, 0, 0);
    mammoth(Xs, an, { x: -0.1, y0: -0.85, col: col, s: 1.0 });
    return { p: p, an: an };
  };
  // ---- Antike ----------------------------------------------------------------------------------
  BUILD.oxcart = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0);
    bed(Q, -2.4, 2.0, 0.85, 1.9, { col: '#8a5a34', railH: 0.5 });
    axle(Q, [-1.0, 1.4], 2.0);
    for (var i = 0; i < 4; i++) amphora(Q, -1.9 + i * 0.7, 0.92, 0.5, i % 2 ? '#b8693a' : '#a85a30');
    for (i = 0; i < 3; i++) sack(Q, -1.8 + i * 0.8, 0.92, -0.5, 0.42, i % 2 ? STRAW : '#cdb878');
    Q.box(3.1, 0.98, 0, 2.4, 0.09, 0.09, '#7a5a3c', { rz: 0.04 });                                         // pole
    Q.box(4.2, 1.32, 0, 0.14, 0.14, 1.5, '#7a5a3c');                                                       // yoke
    ox(Q, an, { x: 4.5, y0: -0.55, z: 0.46, s: 0.78, col: '#7a5638' }); ox(Q, an, { x: 4.5, y0: -0.55, z: -0.46, s: 0.78, col: '#6a4a30' });
    person(Q, an, { x: 1.2, y0: 0.9, z: 0, sit: true, tunic: '#b8a070', legs: '#8a6a4a', hair: '#2a1e16', helmet: 'cap', helmetCol: '#c4b494', h: 0.8 });   // driver
    return { p: p, an: an };
  };
  BUILD.chariot = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0);
    Q.box(-0.4, 0.42, 0, 1.5, 0.1, 1.05, WOOD);                                                            // floor
    Q.prism([[-0.55, 0], [0.7, 0], [0.7, 0.5], [0.4, 0.62], [-0.2, 0.5]], 0.5, 0.07, col, { y: 0.45 });          // low side rails (both sides)
    Q.prism([[-0.55, 0], [0.7, 0], [0.7, 0.5], [0.4, 0.62], [-0.2, 0.5]], -0.5, 0.07, col, { y: 0.45 });
    Q.box(0.72, 0.85, 0, 0.08, 0.72, 1.06, col, { top: 0.92 }); Q.box(0.72, 1.24, 0, 0.1, 0.08, 1.1, '#d9b24a');   // the curved front guard with a gold rim
    Q.box(-1.15, 0.5, 0, 0.07, 0.15, 1.0, shade(col, 0.85));
    Q.box(-0.1, 1.3, -0.45, 0.06, 0.8, 0.06, '#7a5a3c', { rz: -0.12 }); Q.box(-0.1, 1.55, -0.45, 0.12, 0.34, 0.12, '#8a6238');   // quiver
    axle(Q, [-0.5], 1.4);
    Q.box(1.0, 0.62, 0, 1.9, 0.09, 0.09, '#7a5a3c', { rz: 0.12 });                                         // pole
    Q.box(2.0, 1.22, 0, 0.1, 0.1, 1.2, '#7a5a3c');                                                         // yoke
    horse(Q, an, { x: 2.5, y0: -0.55, z: 0.42, s: 0.8, col: '#a8794a', stride: 1.9, cloth: '#b24a3a', harness: true });
    horse(Q, an, { x: 2.5, y0: -0.55, z: -0.42, s: 0.8, col: '#7a5638', stride: 1.9, cloth: '#b24a3a', harness: true, socks: true });
    person(Q, an, { x: -0.55, y0: 0.45, z: 0, tunic: '#a83a32', legs: '#6a4a3a', helmet: 'bronze', h: 0.78, walk: false, long: false, spear: false });
    return { p: p, an: an };
  };
  BUILD.legion = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0), i, j;
    for (i = 0; i < 4; i++) for (j = 0; j < 2; j++) {
      person(Q, an, { x: -3.1 + i * 2.0, y0: -0.4, z: -0.6 + j * 1.2, tunic: j ? '#a83a32' : '#b8433a', legs: '#8a6a4a', helmet: 'bronze', spear: true, shield: 'roman', shieldCol: '#a83a32', h: 0.95, stride: 1.4, phase: (i + j) % 2 ? Math.PI : 0, long: false });
    }
    // standard bearer in front
    Q.box(3.45, 1.9, 0, 0.07, 3.0, 0.07, '#7a5a3c'); Q.box(3.45, 3.5, 0, 0.6, 0.3, 0.07, '#d9b24a'); Q.box(3.45, 3.0, 0, 0.5, 0.5, 0.06, '#a83a32');
    return { p: p, an: an };
  };
  // ---- Mittelalter -----------------------------------------------------------------------------
  BUILD.horsecart = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0), i;
    bed(Q, -3.2, 2.8, 0.95, 2.0, { col: '#8a5a34', railH: 0.62 });
    axle(Q, [-1.3, 2.0], 2.1);
    for (i = 0; i < 4; i++) barrel(Q, -2.6 + i * 0.95, 1.0, 0.45, 0.44, 0.85);
    for (i = 0; i < 4; i++) barrel(Q, -2.6 + i * 0.95, 1.0, -0.45, 0.44, 0.85, WOOD2);
    sack(Q, -1.0, 1.85, 0, 0.4, STRAW); sack(Q, -1.9, 1.85, 0, 0.4, '#cdb878');
    Q.box(3.6, 1.02, 0, 2.0, 0.09, 0.09, '#7a5a3c'); Q.box(1.9, 1.5, 0, 0.55, 0.42, 0.65, '#6a3a4a');         // driver's bench
    person(Q, an, { x: 1.9, y0: 1.0, z: 0, sit: true, tunic: '#6a4a34', legs: '#4a3a2a', helmet: 'cap', helmetCol: '#6a3a4a', h: 0.8 });
    horse(Q, an, { x: 4.9, y0: -0.6, z: 0, s: 1.05, col: '#6b4a34', stride: 2.2, harness: true, blaze: true });
    return { p: p, an: an };
  };
  BUILD.carriage = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0);
    Q.box(0.0, 0.32, 0, 3.9, 0.22, 1.5, '#4a3a2a');
    axle(Q, [-1.4, 1.4], 1.9);
    Q.prism([[-1.25, 0], [1.1, 0], [1.2, 0.5], [1.05, 1.5], [-1.1, 1.55], [-1.3, 1.0]], 0.8, 0.07, col, { y: 0.42 }); Q.prism([[-1.25, 0], [1.1, 0], [1.2, 0.5], [1.05, 1.5], [-1.1, 1.55], [-1.3, 1.0]], -0.8, 0.07, col, { y: 0.42 });
    Q.box(-0.1, 1.2, 0, 2.3, 1.4, 1.5, col, { top: 0.93 });                                                // cabin
    Q.box(0.2, 1.4, 0.87, 0.9, 0.62, 0.05, GLASS); Q.box(-0.8, 1.4, 0.87, 0.7, 0.62, 0.05, GLASS); Q.box(0.2, 1.4, -0.87, 0.9, 0.62, 0.05, GLASS); Q.box(-0.8, 1.4, -0.87, 0.7, 0.62, 0.05, GLASS);
    Q.box(0.2, 1.4, 0.9, 1.0, 0.7, 0.03, '#d9b24a'); Q.box(-0.8, 1.4, 0.9, 0.8, 0.7, 0.03, '#d9b24a'); Q.box(0.2, 1.4, -0.9, 1.0, 0.7, 0.03, '#d9b24a'); Q.box(-0.8, 1.4, -0.9, 0.8, 0.7, 0.03, '#d9b24a');
    Q.box(-0.1, 2.0, 0, 2.7, 0.16, 1.7, shade(col, 0.6), { top: 0.88 });                                    // roof
    Q.box(-0.1, 2.14, 0, 1.9, 0.07, 1.2, '#d9b24a');
    Q.box(1.65, 0.85, 0, 0.8, 0.42, 1.2, '#4a3a2a'); Q.box(1.95, 1.1, 0, 0.1, 0.36, 1.2, '#4a3a2a');       // box seat
    person(Q, an, { x: 1.7, y0: 0.9, z: 0, sit: true, tunic: '#2f3a4a', legs: '#2a2a2a', helmet: 'kettle', helmetCol: '#2a2a2a', h: 0.78 });
    Q.box(3.3, 0.5, 0, 2.2, 0.07, 0.07, '#7a5a3c');
    horse(Q, an, { x: 4.6, y0: -0.6, z: 0.4, s: 0.95, col: '#3a2f2a', stride: 2.0, harness: true });
    horse(Q, an, { x: 4.6, y0: -0.6, z: -0.4, s: 0.95, col: '#4a3a30', stride: 2.0, harness: true, socks: true });
    return { p: p, an: an };
  };
  BUILD.knights = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0), cols = ['#7a5a46', '#c9c2b0', '#4a3a30'], cloth = ['#2f4a7a', '#7a2a2a', '#2f6a4a'], i;
    for (i = 0; i < 3; i++) {
      var hx = -2.7 + i * 2.7;
      horse(Q, an, { x: hx, y0: -0.5, z: 0, s: 0.98, col: cols[i], stride: 2.3, cloth: cloth[i], blaze: i === 1, socks: i === 2 });
      person(Q, an, { x: hx - 0.15, y0: 0.82, z: 0, sit: true, tunic: '#9aa0a8', legs: '#7a8088', helmet: 'iron', shield: 'kite', shieldCol: cloth[i], h: 0.95, cloak: cloth[(i + 1) % 3] });
      Q.box(hx + 0.2, 2.3, 0.4, 0.06, 2.9, 0.06, '#7a5a3c', { rz: -0.42 });                                // lance
      Q.prism([[0, 0], [0.5, 0.12], [0, 0.24]], 0.4, 0.04, cloth[i], { x: hx + 0.5, y: 3.2 });                // pennon
    }
    return { p: p, an: an };
  };
  // ---- Industrialisierung ----------------------------------------------------------------------
  BUILD.wagon = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0), i, j;
    bed(Q, -3.6, 3.0, 1.05, 2.1, { col: '#7a5a3a', railH: 0.62 });
    axle(Q, [-1.6, 2.2], 2.2);
    for (i = 0; i < 4; i++) for (j = 0; j < 2; j++) Q.box(-3.0 + i * 1.1, 1.62, -0.5 + j * 1.0, 0.92, 0.55, 0.9, (i + j) % 2 ? '#a8794a' : '#8a6238');        // crates
    Q.box(4.0, 1.14, 0, 2.0, 0.09, 0.09, '#7a5a3c'); Q.box(2.2, 1.65, 0, 0.55, 0.42, 0.7, '#3a3a4a');
    person(Q, an, { x: 2.2, y0: 1.1, z: 0, sit: true, tunic: '#4a4a52', legs: '#3a3a3a', helmet: 'cap', helmetCol: '#2a2a2a', h: 0.8 });
    horse(Q, an, { x: 5.3, y0: -0.6, z: 0.4, s: 1.08, col: '#4a3a2a', stride: 2.2, harness: true });
    horse(Q, an, { x: 5.3, y0: -0.6, z: -0.4, s: 1.08, col: '#6b5a4a', stride: 2.2, harness: true, socks: true });
    return { p: p, an: an };
  };
  BUILD.oldcar = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0);
    Q.box(0, 0.5, 0, 3.4, 0.22, 1.5, '#2a2a2e');                                                            // frame
    Q.prism([[-1.7, 0.1], [1.05, 0.1], [1.05, 0.85], [-1.7, 0.75]], 0.0, 1.46, col, { y: 0.55 });             // body shell
    Q.box(1.5, 0.95, 0, 1.0, 0.62, 1.38, shade(col, 1.12), { top: 0.9 });                                    // bonnet
    Q.cyl(2.05, 0.95, 0, 0.3, 0.1, '#c8a24a', { n: 8, axis: 'x' });                                          // brass radiator
    Q.box(-0.6, 1.25, 0.69, 0.9, 0.55, 0.06, shade(col, 0.9)); Q.box(-0.6, 1.25, -0.69, 0.9, 0.55, 0.06, shade(col, 0.9));
    Q.box(-0.95, 1.1, 0, 0.5, 0.4, 1.2, '#6b4a34'); Q.box(0.0, 1.1, 0, 0.5, 0.4, 1.2, '#6b4a34');            // seats
    Q.box(0.65, 1.55, 0, 0.06, 0.62, 1.3, GLASS, { rz: -0.2 });                                              // windscreen
    Q.box(-1.62, 1.4, 0, 0.5, 0.42, 1.34, '#2a2a2a', { top: 0.8 }); Q.box(-1.62, 1.66, 0, 0.5, 0.06, 1.0, '#3a3a3a');   // folded hood on the back
    [-1.2, 1.2].forEach(function (ax) { Q.prism([[-0.5, 0], [0.5, 0], [0.38, 0.28], [0.0, 0.42], [-0.38, 0.28]], 0.8, 0.07, '#26262a', { x: ax, y: 0.32 }); Q.prism([[-0.5, 0], [0.5, 0], [0.38, 0.28], [0.0, 0.42], [-0.38, 0.28]], -0.8, 0.07, '#26262a', { x: ax, y: 0.32 }); });   // fenders
    Q.cyl(1.98, 1.25, 0.5, 0.14, 0.12, '#e0b24a', { n: 8, axis: 'x' }); Q.cyl(1.98, 1.25, -0.5, 0.14, 0.12, '#e0b24a', { n: 8, axis: 'x' });   // brass lamps
    axle(Q, [-1.2, 1.2], 1.5);
    person(Q, an, { x: -0.1, y0: 0.95, z: 0.2, sit: true, tunic: '#6a6a5a', legs: '#3a3a3a', helmet: 'cap', helmetCol: '#2a2a2a', h: 0.72, walk: false });
    return { p: p, an: an };
  };
  BUILD.loco = function (col) {
    var p = new Parts(), an = [], Q = X(p, 1, 0, 0, 0), i;
    Q.box(2.5, 0.5, 0, 15.5, 0.34, 2.1, '#2a2e34');                                                         // frame
    Q.cyl(7.4, 2.2, 0, 1.05, 6.4, IRON, { n: 14, axis: 'x' });                                              // boiler
    for (i = 0; i < 4; i++) Q.cyl(5.2 + i * 1.6, 2.2, 0, 1.11, 0.14, '#b8943a', { n: 14, axis: 'x' });       // brass bands
    Q.cyl(10.8, 2.2, 0, 1.12, 0.5, '#2a2e34', { n: 14, axis: 'x' }); Q.cyl(11.08, 2.2, 0, 0.85, 0.08, '#4a4f55', { n: 12, axis: 'x' });   // smokebox + door
    Q.cyl(10.4, 3.7, 0, 0.36, 1.5, '#2a2e34', { n: 10, axis: 'y', r2: 0.55 }); Q.cyl(10.4, 4.55, 0, 0.6, 0.22, '#2a2e34', { n: 10, axis: 'y' });   // funnel with a flare
    Q.cyl(8.0, 3.45, 0, 0.45, 0.5, '#b8943a', { n: 10, axis: 'y', r2: 0.3 });                                // steam dome
    Q.cyl(6.6, 3.4, 0, 0.3, 0.35, '#b8943a', { n: 8, axis: 'y' });                                           // sand dome
    Q.box(3.9, 2.7, 0, 2.5, 2.6, 2.4, '#8a2f28', { top: 0.94 }); Q.box(3.9, 3.0, 1.22, 1.5, 0.7, 0.05, GLASS); Q.box(3.9, 3.0, -1.22, 1.5, 0.7, 0.05, GLASS);   // cab
    Q.box(3.9, 4.12, 0, 3.0, 0.18, 2.7, '#33383d', { top: 0.9 });                                             // cab roof
    Q.box(11.6, 0.8, 0, 0.3, 0.7, 1.9, '#4a4f55'); Q.box(11.7, 0.75, 0.7, 0.36, 0.22, 0.2, '#2a2a2a'); Q.box(11.7, 0.75, -0.7, 0.36, 0.22, 0.2, '#2a2a2a');   // buffers
    Q.box(11.3, 1.7, 0, 0.2, 0.3, 0.3, '#f0d890'); Q.box(10.6, 1.0, 0, 1.4, 0.12, 1.0, '#4a4f55', { rz: -0.4 });   // lamp and cow-catcher
    Q.box(0.9, 1.75, 0, 3.5, 1.9, 2.3, '#3a3a3e', { top: 0.92 }); Q.box(0.9, 2.85, 0, 3.3, 0.55, 2.0, '#1a1a1c');   // tender and coal
    Q.box(-4.0, 1.7, 0, 7.4, 2.2, 2.4, '#8a6238', { top: 0.97 }); Q.box(-4.0, 2.85, 0, 7.2, 0.1, 2.5, '#6b4a2a');   // wagon behind
    for (i = 0; i < 6; i++) Q.box(-7.2 + i * 1.3, 1.7, 1.22, 0.06, 2.0, 0.05, '#6b4a2a');
    Q.box(-9.2, 1.0, 0, 0.3, 0.3, 0.3, '#4a4f55');
    // coupling rods (static, along the wheel centres)
    Q.box(-0.5, 0.0, 1.16, 8.2, 0.12, 0.08, '#aeb2b8');
    return { p: p, an: an };
  };

  // =============================================================================================
  // wheels
  // =============================================================================================
  var WH_CACHE = {};
  /** style: { kind: 'disc' | 'spoke', track, spokes, rim, iron, width } – one geometry = both wheels of an axle */
  function wheelGeometry(r, st) {
    var key = [r.toFixed(2), st.kind, st.track, st.spokes, st.rim, st.iron].join('|');
    if (WH_CACHE[key]) return WH_CACHE[key];
    var p = new Parts(), zs = [st.track / 2, -st.track / 2], wd = st.width || 0.16, i;
    zs.forEach(function (z) {
      var out = z > 0 ? 1 : -1;
      if (st.kind === 'disc') {
        p.cyl(0, 0, z, r, wd, st.rim || '#6b4a2a', { n: 14 });                                              // solid disc of planks
        p.box(0, 0, z + out * (wd / 2 + 0.01), r * 1.9, r * 0.1, 0.03, '#4a3320'); p.box(0, r * 0.45, z + out * (wd / 2 + 0.01), r * 1.5, r * 0.07, 0.03, '#4a3320'); p.box(0, -r * 0.45, z + out * (wd / 2 + 0.01), r * 1.5, r * 0.07, 0.03, '#4a3320');
        p.cyl(0, 0, z + out * (wd / 2 + 0.02), r * 0.2, 0.08, '#3c2a1a', { n: 8 });
        if (st.iron) p.cyl(0, 0, z, r * 1.02, wd * 0.6, st.iron, { n: 14 });
      } else {
        var n = 12, seg = 2 * Math.PI * r / n;
        for (i = 0; i < n; i++) { var a = (i + 0.5) / n * Math.PI * 2; p.box(Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94, z, seg * 1.04, r * 0.14, wd * 0.9, st.iron || st.rim || '#6b4a2a', { rz: a + Math.PI / 2 }); }   // rim
        var sp = st.spokes || 8;
        for (i = 0; i < sp; i++) { var b = i / sp * Math.PI; p.box(0, 0, z, r * 1.85, r * 0.07, wd * 0.45, st.rim || '#8a5a34', { rz: b }); }
        p.cyl(0, 0, z, r * 0.2, wd * 1.1, '#3c2a1a', { n: 8 });
      }
    });
    p.cyl(0, 0, 0, r * 0.08, st.track, '#3c2a1a', { n: 6 });
    var g = p.geometry(); WH_CACHE[key] = g; return g;
  }
  var WHEEL_STYLE = {
    furcart: { kind: 'disc', track: 1.55, rim: '#7a5430', width: 0.2 },
    oxcart: { kind: 'disc', track: 1.9, rim: '#6b4a2a', width: 0.18, iron: '#3c3a38' },
    chariot: { kind: 'spoke', track: 1.4, spokes: 6, rim: '#8a5a34', iron: '#8a6a3a' },
    horsecart: { kind: 'spoke', track: 2.0, spokes: 10, rim: '#7a4e2c', iron: '#3a3a3e' },
    carriage: { kind: 'spoke', track: 1.8, spokes: 12, rim: '#2f2a28', iron: '#2a2a2e' },
    wagon: { kind: 'spoke', track: 2.1, spokes: 12, rim: '#6a4a2c', iron: '#3a3a3e' },
    oldcar: { kind: 'spoke', track: 1.45, spokes: 14, rim: '#b8a070', iron: '#2a2a2e' },
  };

  // =============================================================================================
  // vessels
  // =============================================================================================
  /** hull = convex side outline extruded to the beam; sails, masts, oars; origin: waterline centre, x = bow */
  var VESSEL = {};
  VESSEL.raft = function (L, D, top, hull, cabin) {
    var p = new Parts(), Q = X(p, 1, 0, 0, 0), i, n = 8, mast = Math.min(top, 2.2);
    for (i = 0; i < n; i++) { Q.cyl(0, 0.1, -D / 2 + 0.17 + i * (D - 0.34) / (n - 1), 0.2, L - (i % 2 ? 0.0 : 0.3), i % 2 ? hull : shade(hull, 0.88), { n: 8, axis: 'x' }); Q.cyl(L / 2 - 0.1 - (i % 2 ? 0 : 0.15), 0.1, -D / 2 + 0.17 + i * (D - 0.34) / (n - 1), 0.17, 0.05, '#d8c79a', { n: 8, axis: 'x' }); }
    for (i = 0; i < 3; i++) { Q.box(-L / 2 + 0.7 + i * (L - 1.4) / 2, 0.36, 0, 0.16, 0.1, D + 0.1, '#5a3a22'); Q.box(-L / 2 + 0.7 + i * (L - 1.4) / 2, 0.44, D / 2 + 0.04, 0.2, 0.05, 0.05, ROPE); Q.box(-L / 2 + 0.7 + i * (L - 1.4) / 2, 0.44, -D / 2 - 0.04, 0.2, 0.05, 0.05, ROPE); }
    Q.box(-L * 0.18, 0.6, 0, 1.2, 0.14, 1.1, '#7a5a3c');                                                  // little hut: a hide stretched over poles
    Q.box(-L * 0.18 - 0.5, 0.95, 0.5, 0.06, 0.7, 0.06, '#7a5a3c', { rz: -0.2 }); Q.box(-L * 0.18 - 0.5, 0.95, -0.5, 0.06, 0.7, 0.06, '#7a5a3c', { rz: -0.2 });
    Q.box(-L * 0.18, 1.2, 0, 1.4, 0.08, 1.3, '#8a6238', { rz: 0.0, top: 0.85 });
    Q.box(L * 0.3, 0.55 + mast / 2, 0, 0.08, mast, 0.08, '#7a5a3c'); Q.box(L * 0.3 + 0.3, mast * 0.7, 0, 0.7, 0.8, 0.04, '#8a6238');            // pole with a hide sail
    Q.box(-L / 2 + 0.25, 0.8, 0, 0.12, 0.9, 0.12, '#7a5a3c'); Q.box(-L / 2 - 0.35, 0.55, 0, 1.8, 0.07, 0.07, '#7a5a3c', { rz: -0.3 }); Q.box(-L / 2 - 1.05, 0.18, 0, 0.7, 0.05, 0.26, '#8a6238', { rz: -0.3 });   // steering oar on a post
    return p;
  };
  VESSEL.nileboat = function (L, D, top, hull, cabin) {
    var p = new Parts(), Q = X(p, 1, 0, 0, 0), h = Math.min(1.1, Math.max(0.7, top * 0.2)), mast = Math.max(1.4, top - 0.3), i;
    Q.prism([[-L / 2, h * 2.1], [-L / 2 + 0.7, h * 0.4], [-L / 2 + 1.6, 0], [L / 2 - 2.0, 0], [L / 2 - 0.5, h * 0.5], [L / 2, h * 2.0], [L / 2 - 0.4, h * 1.2], [-L / 2 + 0.5, h * 1.0]], 0, D, hull);   // papyrus-boat shape: both ends curl up
    Q.box(0, h * 0.95, 0, L - 2.2, 0.1, D * 0.86, shade(hull, 0.78));
    [D / 2, -D / 2].forEach(function (zz) {                                                                      // reed bundles along both sides, tied with ropes
      Q.cyl(0.1, h * 0.95, zz, 0.2, L - 1.2, shade(hull, 1.08), { n: 8, axis: 'x' }); Q.cyl(0.1, h * 0.6, zz, 0.17, L - 1.8, shade(hull, 0.95), { n: 8, axis: 'x' });
      for (var b = 0; b < 8; b++) Q.box(-L / 2 + 1.6 + b * (L - 3.6) / 7, h * 0.85, zz, 0.07, 0.62, 0.46, '#6a4a2a');
    });
    for (i = 0; i < 6; i++) Q.box(-L / 2 + 1.5 + i * (L - 3.2) / 5, h * 0.8, 0, 0.1, 0.1, D + 0.15, '#7a5a3c');         // thwarts
    Q.box(-L * 0.3, h + 0.7, 0, L * 0.22, 1.1, D * 0.62, cabin, { top: 0.82 }); Q.box(-L * 0.3, h + 1.32, 0, L * 0.24, 0.1, D * 0.7, '#8a6238');     // reed cabin
    Q.box(L * 0.08, h * 0.8 + mast / 2, 0, 0.14, mast, 0.14, '#7a5a3c');
    var sh = Math.max(1.2, Math.min(mast * 0.7, top * 0.7));
    Q.prism([[0, 0], [1.5, 0], [0.3, sh]], 0.0, 0.05, '#efe6cf', { x: L * 0.08, y: h * 0.8 + mast - sh });          // triangular sail
    Q.box(L * 0.08 + 0.7, h * 0.8 + mast - sh - 0.02, 0, 1.6, 0.07, 0.07, '#7a5a3c');
    Q.box(-L / 2 - 0.6, h * 1.2, -D / 2 + 0.05, 1.9, 0.07, 0.07, '#7a5a3c', { rz: -0.25 }); Q.box(-L / 2 - 1.4, h * 0.7, -D / 2 + 0.05, 0.6, 0.05, 0.22, '#8a6238');   // steering oar
    return p;
  };
  VESSEL.galley = function (L, D, top, hull, cabin) {
    var p = new Parts(), Q = X(p, 1, 0, 0, 0), h = Math.min(1.2, Math.max(0.7, top * 0.18)), mast = Math.max(1.4, top - 0.3), i;
    Q.prism([[-L / 2, h * 1.7], [-L / 2 + 0.9, 0], [L / 2 - 2.6, 0], [L / 2 - 0.4, h * 0.7], [L / 2, h * 1.0], [L / 2 - 0.6, h * 1.5], [-L / 2, h * 1.7]], 0, D * 0.82, hull);   // long narrow hull
    Q.box(L / 2 + 0.5, h * 0.25, 0, 1.6, 0.16, 0.34, '#8a5a34');                                                          // ram at the waterline
    Q.box(L / 2 + 1.3, h * 0.3, 0, 0.3, 0.1, 0.2, '#b8943a');
    Q.box(0, h * 1.45, 0, L - 1.2, 0.1, D * 0.72, shade(hull, 0.75));                                                       // deck
    Q.box(0, h * 1.0, D * 0.4 + 0.05, L - 1.2, 0.2, 0.06, '#d9b24a');                                                       // gold stripe
    for (i = 0; i < 10; i++) {                                                                                                // rower benches + oars (the oars come as animated parts)
      var bx = -L / 2 + 1.5 + i * (L - 3.6) / 9;
      Q.box(bx, h * 1.5 + 0.18, 0, 0.3, 0.14, D * 0.7, '#7a5a3c');
      Q.box(bx, h * 1.3, D * 0.41 + 0.03, 0.12, 0.2, 0.06, '#4a3a2a'); Q.box(bx, h * 1.3, -D * 0.41 - 0.03, 0.12, 0.2, 0.06, '#4a3a2a');          // oar ports
    }
    Q.box(L * 0.06, h + mast / 2, 0, 0.16, mast, 0.16, '#7a5a3c');
    var sh = Math.max(1.0, mast * 0.5);
    Q.box(L * 0.06, mast + h - sh / 2 - 0.2, 0, 0.07, sh, D * 1.05, '#ece1c8'); Q.box(L * 0.06 + 0.05, mast + h - sh / 2 - 0.2, 0, 0.02, sh, 0.55, '#a83a32');   // square sail with a stripe
    Q.box(L * 0.06, mast + h - 0.1, 0, 0.1, 0.1, D * 1.15, '#7a5a3c');
    Q.box(-L * 0.4, h * 1.5 + 0.7, 0, 1.4, 1.3, D * 0.62, cabin, { top: 0.8 }); Q.box(-L * 0.4, h * 1.5 + 1.4, 0, 1.6, 0.1, D * 0.7, '#8a5a34');   // stern cabin
    Q.box(-L / 2 - 0.2, h * 1.7 + 0.5, 0, 0.3, 1.0, 0.3, '#d9b24a', { rz: 0.0 });                                          // curled stern post
    return p;
  };
  VESSEL.cog = function (L, D, top, hull, cabin) {
    var p = new Parts(), Q = X(p, 1, 0, 0, 0), h = Math.min(1.3, Math.max(0.8, top * 0.2)), mast = Math.max(1.5, top - 0.3), i;
    Q.prism([[-L / 2, h * 1.9], [-L / 2 + 0.9, 0.1], [L / 2 - 1.8, 0], [L / 2 - 0.1, h * 1.6], [L / 2 - 0.1, h * 2.0], [-L / 2, h * 2.0]], 0, D, hull);                         // round hull
    for (i = 0; i < 5; i++) Q.box(0, h * (0.35 + i * 0.32), D / 2 + 0.02, L - 1.4 - i * 0.1, 0.05, 0.05, shade(hull, 0.72));      // clinker planking lines
    Q.box(0, h * 2.0, 0, L - 0.3, 0.12, D * 0.95, shade(hull, 0.75));
    Q.box(L / 2 - 1.3, h * 2.0 + 0.55, 0, 2.0, 1.1, D * 0.9, shade(hull, 0.92)); Q.box(L / 2 - 1.3, h * 2.0 + 1.14, 0, 2.2, 0.08, D * 0.96, '#4a3a2a');   // fore castle
    Q.box(-L / 2 + 1.6, h * 2.0 + 0.8, 0, 2.8, 1.6, D * 0.9, shade(hull, 0.92)); Q.box(-L / 2 + 1.6, h * 2.0 + 1.64, 0, 3.0, 0.08, D * 0.96, '#4a3a2a');       // aft castle
    for (i = 0; i < 5; i++) { Q.box(-L / 2 + 0.5 + i * 0.5, h * 2.0 + 1.78, D * 0.46, 0.2, 0.2, 0.06, '#8a8a82'); Q.box(-L / 2 + 0.5 + i * 0.5, h * 2.0 + 1.78, -D * 0.46, 0.2, 0.2, 0.06, '#8a8a82'); }   // crenellations
    Q.box(L * 0.04, h + mast / 2, 0, 0.2, mast, 0.2, '#7a5a3c');
    var sh = Math.max(1.4, mast * 0.5);
    Q.box(L * 0.04, mast + h - sh / 2 - 0.5, 0, 0.1, sh, D * 1.35, '#e8e0cc'); Q.box(L * 0.04 + 0.06, mast + h - sh / 2 - 0.5, 0, 0.02, sh * 0.8, 0.28, '#b8433a');
    Q.box(L * 0.04 + 0.06, mast + h - sh / 2 - 0.5, D * 0.5, 0.02, sh * 0.8, 0.2, '#b8433a'); Q.box(L * 0.04 + 0.06, mast + h - sh / 2 - 0.5, -D * 0.5, 0.02, sh * 0.8, 0.2, '#b8433a');
    Q.box(L * 0.04, mast + h - 0.5 - sh - 0.05, 0, 0.12, 0.12, D * 1.4, '#7a5a3c');
    Q.prism([[0, 0], [0.9, 0.2], [0, 0.4]], 0.0, 0.04, '#b8433a', { x: L * 0.04 + 0.1, y: mast + h });               // pennant
    Q.box(-L / 2 - 0.3, h * 1.2, 0, 0.14, 1.4, 0.5, '#4a3a2a');                                                      // stern rudder
    return p;
  };
  VESSEL.steamer = function (L, D, top, hull, cabin) {
    var p = new Parts(), Q = X(p, 1, 0, 0, 0), h = Math.min(1.3, Math.max(0.7, top * 0.2)), i;
    Q.prism([[-L / 2, h * 1.5], [-L / 2 + 0.8, 0], [L / 2 - 2.4, 0], [L / 2, h * 1.5], [L / 2, h * 1.8], [-L / 2, h * 1.8]], 0, D, hull);                       // iron hull with a raked bow
    for (i = 0; i < 12; i++) Q.cyl(-L / 2 + 0.8 + i * (L - 1.8) / 11, h * 1.1, D / 2 + 0.02, 0.05, 0.04, '#6a6f76', { n: 6 });                         // rivets
    Q.box(0, h * 1.8 + 0.05, 0, L - 0.4, 0.1, D * 0.95, shade(hull, 0.7));
    var dh = Math.min(2.2, Math.max(1.0, top - h * 1.8 - 0.9));
    Q.box(-L * 0.1, h * 1.8 + dh / 2 + 0.1, 0, L * 0.38, dh, D * 0.7, cabin, { top: 0.95 });
    Q.box(-L * 0.1, h * 1.8 + dh * 0.62, D * 0.36, L * 0.36, Math.min(0.6, dh * 0.3), 0.04, GLASS); Q.box(-L * 0.1, h * 1.8 + dh * 0.62, -D * 0.36, L * 0.36, Math.min(0.6, dh * 0.3), 0.04, GLASS);
    Q.box(-L * 0.1, h * 1.8 + dh + 0.2, 0, L * 0.4, 0.1, D * 0.78, '#4a4f55');
    var fh = Math.max(1.0, Math.min(top - h * 1.8 - 0.2, 3.4));
    Q.cyl(-L * 0.02, h * 1.8 + fh / 2 + 0.2, 0, 0.5, fh, '#2a2e34', { n: 10, axis: 'y', r2: 0.4 }); Q.cyl(-L * 0.02, h * 1.8 + fh - 0.15, 0, 0.52, 0.34, '#b8433a', { n: 10, axis: 'y' });
    Q.cyl(-L * 0.3, h * 1.8 + 0.6, D / 2 + 0.25, Math.min(1.3, h * 1.2 + 0.5), 0.3, '#5a3a2a', { n: 12 }); Q.cyl(-L * 0.3, h * 1.8 + 0.6, -D / 2 - 0.25, Math.min(1.3, h * 1.2 + 0.5), 0.3, '#5a3a2a', { n: 12 });   // paddle boxes
    for (i = 0; i < 6; i++) { Q.box(-L * 0.3, h * 1.8 + 0.6, D / 2 + 0.42, 0.06, Math.min(2.4, (h * 1.2 + 0.5) * 2) * 0.9, 0.04, '#7a5a3a', { rz: i * Math.PI / 6 }); }
    Q.box(L * 0.3, h * 1.8 + 0.6, 0, 0.12, 1.2, 0.12, '#7a5a3a'); Q.box(L * 0.3, h * 1.8 + 1.3, 0, 0.8, 0.05, 0.05, '#7a5a3a');
    return p;
  };
  // animated parts of vessels: oars of the galley
  function vesselAnims(style, L, D, top, hull) {
    var an = [];
    if (style === 'galley') {
      var h = Math.min(1.2, Math.max(0.7, top * 0.18)), i, side;
      for (i = 0; i < 10; i++) {
        var bx = -L / 2 + 1.5 + i * (L - 3.6) / 9;
        [1, -1].forEach(function (sd) {
          var o = new Parts(), O = X(o, 1, 0, 0, 0);
          O.box(0, -0.6, sd * 0.9, 0.08, 2.0, 0.08, '#c9b27c', { rz: 0 }); O.box(0, -1.6, sd * 1.15, 0.12, 0.6, 0.3, '#a8793a');
          anim(an, o, [bx, h * 1.3 + 0.1, sd * (D * 0.41 + 0.05)], 'sway', 0.38, i * 0.35, 1.0, 1);
        });
      }
    }
    return an;
  }

  // =============================================================================================
  // registration
  // =============================================================================================
  var bodies = {}, parts = {};
  Object.keys(BUILD).forEach(function (k) {
    bodies[k] = function (col) { return BUILD[k](col).p; };
    parts[k] = function (col) { return BUILD[k](col).an; };
  });
  var vessels = {};
  Object.keys(VESSEL).forEach(function (k) { vessels[k] = VESSEL[k]; });
  M.register({ bodies: bodies, parts: parts, wheelStyle: WHEEL_STYLE, wheelGeometry: wheelGeometry, vessels: vessels, vesselAnims: vesselAnims });
})(globalThis.BB = globalThis.BB || {});
