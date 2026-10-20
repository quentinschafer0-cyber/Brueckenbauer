/*
 * Brückenbauer – r3d-util.js
 * ----------------------------------------------------------------------------
 * Helpers for the 3D low-poly renderer (render3d.js): colour utilities, a deterministic PRNG, a tiny
 * "merged flat-shaded parts" geometry builder and the colour themes of the worlds.
 * Needs THREE (js/vendor/three.min.js). All geometry is built in code – no model files.
 */
(function (BB) {
  'use strict';

  var R3 = BB.R3 = BB.R3 || {};

  // ---------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hash32(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function hash2(a, b) { return hash32(Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)); }
  function rnd01(a, b) { return hash2(a, b) / 4294967296; }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function strHash(s) { var h = 5381; s = String(s); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; }

  // colours are plain [r,g,b] arrays in 0..1
  function hex(c) {
    if (typeof c !== 'string') return c;
    var s = c.charAt(0) === '#' ? c.slice(1) : c;
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function mix(a, b, t) { a = hex(a); b = hex(b); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function shade(c, f) { c = hex(c); return f >= 1 ? [lerp(c[0], 1, f - 1), lerp(c[1], 1, f - 1), lerp(c[2], 1, f - 1)] : [c[0] * f, c[1] * f, c[2] * f]; }
  function toHexNum(c) { c = hex(c); return ((Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255)); }
  function css(c) { c = hex(c); return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')'; }

  // stress (0..1) → colour: blue → green → yellow → red (same idea as the 2D renderer)
  var STRESS_STOPS = [[0, '#3b8bff'], [0.35, '#34c759'], [0.65, '#ffd60a'], [0.85, '#ff7a1a'], [1, '#ff2d2d']];
  function stressRGB(s) {
    s = clamp(s, 0, 1);
    for (var i = 1; i < STRESS_STOPS.length; i++) {
      if (s <= STRESS_STOPS[i][0]) {
        var a = STRESS_STOPS[i - 1], b = STRESS_STOPS[i];
        return mix(a[1], b[1], (s - a[0]) / (b[0] - a[0]));
      }
    }
    return hex(STRESS_STOPS[STRESS_STOPS.length - 1][1]);
  }

  // ---------------------------------------------------------------------------------------------
  // Flat-shaded part builder: collect boxes / prisms / cylinders / cones with a colour each and
  // produce ONE non-indexed BufferGeometry (positions, flat normals, vertex colours).
  // part spaces are y-up, x forward, z across (depth).
  // ---------------------------------------------------------------------------------------------
  function Parts() { this.pos = []; this.col = []; }
  Parts.prototype._tri = function (a, b, c, color) {
    var p = this.pos;
    p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (var i = 0; i < 3; i++) this.col.push(color[0], color[1], color[2]);
  };
  Parts.prototype._quad = function (a, b, c, d, color) { this._tri(a, b, c, color); this._tri(a, c, d, color); };

  /** Transformed point: scale (sx,sy,sz) → rotate around Z (rz) → rotate around Y (ry) → translate (x,y,z). */
  function xf(p, t) {
    var x = p[0] * t.sx, y = p[1] * t.sy, z = p[2] * t.sz, c, s, nx, ny, nz;
    if (t.rz) { c = Math.cos(t.rz); s = Math.sin(t.rz); nx = x * c - y * s; ny = x * s + y * c; x = nx; y = ny; }
    if (t.ry) { c = Math.cos(t.ry); s = Math.sin(t.ry); nx = x * c + z * s; nz = -x * s + z * c; x = nx; z = nz; }
    return [x + t.x, y + t.y, z + t.z];
  }
  function T(o) {
    return { x: o.x || 0, y: o.y || 0, z: o.z || 0, sx: o.sx === undefined ? 1 : o.sx, sy: o.sy === undefined ? 1 : o.sy, sz: o.sz === undefined ? 1 : o.sz, rz: o.rz || 0, ry: o.ry || 0 };
  }

  /** Box centred at (x,y,z) of size (w,h,d); o: rz, ry (radians). A box with taper: top width scaled by `top` (0..1) in x. */
  Parts.prototype.box = function (x, y, z, w, h, d, color, o) {
    o = o || {};
    color = hex(color);
    var hw = 0.5, hh = 0.5, hd = 0.5, tp = o.top === undefined ? 1 : o.top, tz = o.topZ === undefined ? tp : o.topZ;
    var t = T({ x: x, y: y, z: z, sx: w, sy: h, sz: d, rz: o.rz, ry: o.ry });
    var v = [
      [-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd],
      [-hw * tp, hh, -hd * tz], [hw * tp, hh, -hd * tz], [hw * tp, hh, hd * tz], [-hw * tp, hh, hd * tz],
    ].map(function (q) { return xf(q, t); });
    var c = color, top = shade(c, 1.12), bot = shade(c, 0.62), side = shade(c, 0.86), side2 = shade(c, 0.78);
    this._quad(v[3], v[2], v[6], v[7], c);          // +z front
    this._quad(v[1], v[0], v[4], v[5], side2);       // -z back
    this._quad(v[2], v[1], v[5], v[6], side);        // +x
    this._quad(v[0], v[3], v[7], v[4], side2);       // -x
    this._quad(v[7], v[6], v[5], v[4], top);         // top
    this._quad(v[0], v[1], v[2], v[3], bot);         // bottom
    return this;
  };

  /** Convex prism from a 2D outline in the x-y plane (counter-clockwise), extruded along z (depth d) at z. */
  Parts.prototype.prism = function (outline, z, d, color, o) {
    o = o || {};
    color = hex(color);
    var t = T({ x: o.x, y: o.y, z: z, sx: o.sx, sy: o.sy, sz: 1, rz: o.rz, ry: o.ry });
    var n = outline.length, f = [], b = [], i;
    for (i = 0; i < n; i++) { f.push(xf([outline[i][0], outline[i][1], d / 2], t)); b.push(xf([outline[i][0], outline[i][1], -d / 2], t)); }
    var top = shade(color, 1.1), side = shade(color, 0.82);
    for (i = 1; i + 1 < n; i++) { this._tri(f[0], f[i], f[i + 1], color); this._tri(b[0], b[i + 1], b[i], shade(color, 0.7)); }
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var dx = outline[j][0] - outline[i][0], dy = outline[j][1] - outline[i][1];
      this._quad(f[i], b[i], b[j], f[j], dy < -0.01 ? shade(color, 0.6) : (dy > 0.01 ? top : side));
    }
    return this;
  };

  /** Cylinder (n-gon) with axis along x (default), y or z; radius r, length l, centred at (x,y,z). */
  Parts.prototype.cyl = function (x, y, z, r, l, color, o) {
    o = o || {};
    color = hex(color);
    var n = o.n || 8, axis = o.axis || 'z', r2 = o.r2 === undefined ? r : o.r2, i;
    var ring = function (zz, rr, a) { var out = []; for (var k = 0; k < n; k++) { var th = (k + 0.5) / n * Math.PI * 2; out.push(axisPt(Math.cos(th) * rr, Math.sin(th) * rr, zz, a)); } return out; };
    function axisPt(u, v, w, a) {
      if (a === 'x') return [w, u, v];
      if (a === 'y') return [u, w, v];
      return [u, v, w];
    }
    var A = ring(-l / 2, r, axis), B = ring(l / 2, r2, axis);
    function add(p) { return [p[0] + x, p[1] + y, p[2] + z]; }
    A = A.map(add); B = B.map(add);
    var ca = add(axisPt(0, 0, -l / 2, axis)), cb = add(axisPt(0, 0, l / 2, axis));
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var f = (i % 2 ? 0.9 : 1.0) * (0.78 + 0.3 * Math.cos((i + 0.5) / n * Math.PI * 2 - 1.2));
      this._quad(A[i], A[j], B[j], B[i], shade(color, clamp(f, 0.55, 1.15)));
      this._tri(ca, A[j], A[i], shade(color, 0.7));
      this._tri(cb, B[i], B[j], shade(color, 1.05));
    }
    return this;
  };

  /** Low-poly blob (icosahedron-ish octa/ico) of radius r, jittered by `jit`, flattened by `sy`. */
  Parts.prototype.blob = function (x, y, z, r, color, o) {
    o = o || {};
    color = hex(color);
    var jit = o.jit === undefined ? 0.18 : o.jit, sy = o.sy === undefined ? 1 : o.sy, seed = o.seed || 1, sx = o.sx === undefined ? 1 : o.sx;
    var t = (1 + Math.sqrt(5)) / 2, base = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    var faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var pts = base.map(function (b, i) {
      var l = Math.hypot(b[0], b[1], b[2]), k = r * (1 + (rnd01(seed, i) - 0.5) * 2 * jit);
      return [x + b[0] / l * k * sx, y + b[1] / l * k * sy, z + b[2] / l * k];
    });
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i], a = pts[f[0]], b = pts[f[1]], c = pts[f[2]];
      var nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      var ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      var nl = Math.hypot(nx, ny, (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) || 1;
      this._tri(a, b, c, shade(color, 0.78 + 0.34 * clamp(ny / nl * 0.5 + 0.5, 0, 1) + (rnd01(seed + 7, i) - 0.5) * 0.12));
    }
    return this;
  };

  /** Cone / pyramid with n sides, base radius r at y0, apex at y0+h. */
  Parts.prototype.cone = function (x, y0, z, r, h, color, o) {
    o = o || {};
    color = hex(color);
    var n = o.n || 6, apex = [x, y0 + h, z], i, ring = [];
    for (i = 0; i < n; i++) { var th = (i + (o.rot || 0)) / n * Math.PI * 2; ring.push([x + Math.cos(th) * r, y0, z + Math.sin(th) * r]); }
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      this._tri(ring[i], apex, ring[j], shade(color, clamp(0.82 + 0.3 * Math.cos((i + 0.5) / n * Math.PI * 2 - 0.9), 0.6, 1.12)));
      this._tri([x, y0, z], ring[i], ring[j], shade(color, 0.6));
    }
    return this;
  };

  Parts.prototype.merge = function (other, dx, dy, dz) {
    var o = other.pos, i;
    for (i = 0; i < o.length; i += 3) this.pos.push(o[i] + (dx || 0), o[i + 1] + (dy || 0), o[i + 2] + (dz || 0));
    for (i = 0; i < other.col.length; i++) this.col.push(other.col[i]);
    return this;
  };

  /** Flat normals from the triangle list; returns a THREE.BufferGeometry with position, normal, color. */
  Parts.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    var pos = new Float32Array(this.pos), col = new Float32Array(this.col), nor = new Float32Array(pos.length);
    for (var i = 0; i < pos.length; i += 9) {
      var ax = pos[i], ay = pos[i + 1], az = pos[i + 2], bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5], cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
      var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (var k = 0; k < 9; k += 3) { nor[i + k] = nx; nor[i + k + 1] = ny; nor[i + k + 2] = nz; }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  };

  // ---------------------------------------------------------------------------------------------
  // world themes (levels carry level.world → BB.Worlds theme id; custom levels use 'green')
  // ---------------------------------------------------------------------------------------------
  // Calm, matching palettes (about 7 colours per world): sky, grass, soil, rock, water, tree, haze.
  // grass[0] = lit top, grass[1] = slope, grass[2] = lip;  soil[0..2] = strata (light → dark);  cliff[0..1] = rock faces.
  var THEMES = {
    green: {
      skyTop: '#7fb5de', skyBottom: '#e9f1f2', fog: '#dde9ec', fogNear: 90, fogFar: 380,
      sun: '#fff1d8', sunI: 0.9, hemiSky: '#dfeaf0', hemiGround: '#8d9b7c', hemiI: 0.9, shadow: 0.3,
      grass: ['#8fb86a', '#82a85f', '#6f9650'], soil: ['#b58f68', '#a47f5a', '#8f6c4c'], cliff: ['#a39c92', '#8f887e'],
      water: '#4f93b8', waterTop: '#79b4cf', trees: 'round', treeCols: ['#5f9a58', '#6aa562'], trunk: '#7a5a3c', rock: ['#9a958c', '#aaa59b'], hills: ['#a9c79c', '#bdd3b2', '#d0e0c8'], cloud: '#ffffff',
    },
    desert: {
      skyTop: '#86b6d6', skyBottom: '#f4e6c8', fog: '#ecdcc0', fogNear: 80, fogFar: 340,
      sun: '#fff0d2', sunI: 0.95, hemiSky: '#f1e4cc', hemiGround: '#b08c5e', hemiI: 0.9, shadow: 0.34,
      grass: ['#dcba7c', '#cfa86c', '#bd965c'], soil: ['#cf9c68', '#bd8956', '#a47448'], cliff: ['#c0875a', '#a9744a'],
      water: '#4f9aa8', waterTop: '#7fbcc2', trees: 'cactus', treeCols: ['#6a9a58', '#5f8e50'], trunk: '#7a5a3c', rock: ['#c49068', '#b3805a'], hills: ['#dcbb8c', '#e6cca4', '#efdcbc'], cloud: '#fffaf0',
    },
    autumn: {
      skyTop: '#8db4d0', skyBottom: '#f2e3d2', fog: '#e8dacb', fogNear: 80, fogFar: 340,
      sun: '#ffe6c2', sunI: 0.88, hemiSky: '#efe2d3', hemiGround: '#8a7050', hemiI: 0.9, shadow: 0.32,
      grass: ['#c2a45c', '#b3944e', '#9d7f42'], soil: ['#a47a56', '#92694a', '#7c583e'], cliff: ['#968a7c', '#82776a'],
      water: '#4f8ca8', waterTop: '#7ab0c6', trees: 'pine', treeCols: ['#b9622f', '#cf8a3a', '#a04a28'], trunk: '#654630', rock: ['#8d8378', '#9d9388'], hills: ['#cba37c', '#dcbe9c', '#e8d4bc'], cloud: '#fff6ec',
    },
    harbor: {
      skyTop: '#80b0d8', skyBottom: '#e6eff4', fog: '#d9e4ea', fogNear: 90, fogFar: 360,
      sun: '#fff3de', sunI: 0.9, hemiSky: '#dce8f0', hemiGround: '#7f8a96', hemiI: 0.92, shadow: 0.3,
      grass: ['#93b078', '#869f6e', '#748c60'], soil: ['#a1a6ad', '#8f959d', '#7c828b'], cliff: ['#8f959e', '#7d838c'],
      water: '#3e82ae', waterTop: '#6aa8cb', trees: 'round', treeCols: ['#6c9a5c', '#5f8d52'], trunk: '#6e5a42', rock: ['#8f949c', '#9fa4ac'], hills: ['#a9bccd', '#bccbd9', '#cfdae5'], cloud: '#ffffff',
    },
    winter: {
      skyTop: '#9ebbd6', skyBottom: '#f0f5f9', fog: '#e6edf3', fogNear: 70, fogFar: 320,
      sun: '#f6f9ff', sunI: 0.86, hemiSky: '#e8f0f8', hemiGround: '#a2b2c4', hemiI: 0.95, shadow: 0.28,
      grass: ['#eef3f7', '#dfe8ef', '#cdd9e3'], soil: ['#929eab', '#818d9b', '#6f7b8a'], cliff: ['#8996a5', '#76838f'],
      water: '#5890b4', waterTop: '#86b4d0', trees: 'pine', treeCols: ['#3e6e57', '#356250'], trunk: '#5b4a3a', rock: ['#8a95a3', '#9aa5b3'], hills: ['#d3dfea', '#e0e9f1', '#ecf2f7'], cloud: '#ffffff', snow: true,
    },
    candy: {
      skyTop: '#9cc4e6', skyBottom: '#f6e6ee', fog: '#efe0e8', fogNear: 90, fogFar: 360,
      sun: '#fff3e0', sunI: 0.9, hemiSky: '#f0e6ee', hemiGround: '#a58fae', hemiI: 0.92, shadow: 0.28,
      grass: ['#8fc79a', '#82b78d', '#6fa27c'], soil: ['#d1a2bd', '#bf8fab', '#a87b96'], cliff: ['#c79cba', '#b389a6'],
      water: '#5a9ad0', waterTop: '#86b8e0', trees: 'lolli', treeCols: ['#e48aa8', '#eeb06a', '#7cc4de'], trunk: '#eadfd0', rock: ['#c79cba', '#d6adc8'], hills: ['#e6bcd0', '#eecddc', '#f4dce6'], cloud: '#fff8fb',
    },
    yard: {
      skyTop: '#94b4cc', skyBottom: '#eceff0', fog: '#e0e5e8', fogNear: 80, fogFar: 340,
      sun: '#fff2dc', sunI: 0.88, hemiSky: '#e0e8ee', hemiGround: '#7d838b', hemiI: 0.92, shadow: 0.32,
      grass: ['#a2a88f', '#959b83', '#838972'], soil: ['#8f939a', '#7e828a', '#6c7077'], cliff: ['#7b8189', '#6a7078'],
      water: '#4c82a0', waterTop: '#78a6c0', trees: 'crate', treeCols: ['#d09a48', '#bd5a3e'], trunk: '#6a6f77', rock: ['#7f858e', '#8f959e'], hills: ['#b4bec7', '#c6cfd6', '#d6dde2'], cloud: '#f6f8f9',
    },
    volcano: {
      skyTop: '#7a6684', skyBottom: '#f0c6a0', fog: '#e2b898', fogNear: 60, fogFar: 300,
      sun: '#ffdcb0', sunI: 0.8, hemiSky: '#efcdb4', hemiGround: '#5e443c', hemiI: 0.9, shadow: 0.4,
      grass: ['#6f5648', '#624b3f', '#54403a'], soil: ['#58443e', '#4a3834', '#3c2d2a'], cliff: ['#4a3a36', '#3b2e2c'],
      water: '#e86a1e', waterTop: '#f6a640', trees: 'dead', treeCols: ['#2f221f', '#3d2d28'], trunk: '#2f221f', rock: ['#4a3a36', '#5a4640'], hills: ['#8f6a58', '#a68068', '#bc9a82'], cloud: '#cdb2a6', ash: true, lava: true,
    },
    rail: {
      skyTop: '#98a8cc', skyBottom: '#f2e0d0', fog: '#e6d6c8', fogNear: 80, fogFar: 340,
      sun: '#ffe3bc', sunI: 0.86, hemiSky: '#ece0d6', hemiGround: '#7d7868', hemiI: 0.9, shadow: 0.34,
      grass: ['#93a672', '#869968', '#748758'], soil: ['#a08466', '#8f7458', '#7a6249'], cliff: ['#898176', '#776f65'],
      water: '#4f86a8', waterTop: '#7aaac4', trees: 'pine', treeCols: ['#527a54', '#486d4a'], trunk: '#654a38', rock: ['#8a8278', '#9a9288'], hills: ['#aab2c6', '#bcc2d2', '#d0d4de'], cloud: '#fff2e8',
    },
    sky: {
      skyTop: '#6ea6dc', skyBottom: '#e8f2fa', fog: '#dde9f4', fogNear: 110, fogFar: 420,
      sun: '#ffffff', sunI: 0.95, hemiSky: '#e4eef8', hemiGround: '#9aaec4', hemiI: 0.95, shadow: 0.26,
      grass: ['#a8cbd8', '#9bbfce', '#89afbf'], soil: ['#b9c4d4', '#a8b3c4', '#95a1b3'], cliff: ['#a4b0c2', '#939fb2'],
      water: '#5d9ad0', waterTop: '#88b6dc', trees: 'round', treeCols: ['#86be9a', '#76b08c'], trunk: '#94a0b2', rock: ['#a4b0c2', '#b4bfcf'], hills: ['#bed2e6', '#cfdeee', '#dfeaf4'], cloud: '#ffffff',
    },
    tropic: {
      skyTop: '#6fb4dc', skyBottom: '#e6f4f2', fog: '#d8ebea', fogNear: 100, fogFar: 400,
      sun: '#fff6dc', sunI: 0.95, hemiSky: '#e0f0f0', hemiGround: '#74a070', hemiI: 0.9, shadow: 0.3,
      grass: ['#6fb878', '#62a96c', '#55995f'], soil: ['#d9c08e', '#c9ae7c', '#b49968'], cliff: ['#c0a982', '#aa946e'],
      water: '#2fa5b4', waterTop: '#68c8cf', trees: 'palm', treeCols: ['#3e9a58', '#4aa764'], trunk: '#8e6a42', rock: ['#b8a888', '#c8b898'], hills: ['#8cc8a8', '#a6d6bc', '#c0e4d2'], cloud: '#ffffff',
    },
    city: {
      skyTop: '#8aa6c8', skyBottom: '#eceff2', fog: '#dfe4e9', fogNear: 80, fogFar: 340,
      sun: '#fff1dc', sunI: 0.88, hemiSky: '#e0e6ec', hemiGround: '#7c8088', hemiI: 0.92, shadow: 0.32,
      grass: ['#9aa890', '#8e9c86', '#7c8a74'], soil: ['#9a9a9c', '#8a8a8e', '#76767a'], cliff: ['#8a8c92', '#797b82'],
      water: '#4a7fa0', waterTop: '#76a4c0', trees: 'round', treeCols: ['#6a9468', '#5d855c'], trunk: '#6a6258', rock: ['#8a8c92', '#9a9ca2'], hills: ['#b2bccb', '#c4ccd8', '#d4dae3'], cloud: '#f8f9fb',
    },
    // ---- Zeitreise: one calm palette per epoch ----
    stone: {
      skyTop: '#92b8d4', skyBottom: '#eee9d6', fog: '#e4e2d0', fogNear: 80, fogFar: 340,
      sun: '#fff0d0', sunI: 0.9, hemiSky: '#e8e6d4', hemiGround: '#7c8a5c', hemiI: 0.92, shadow: 0.32,
      grass: ['#7f9c5c', '#728f52', '#617c46'], soil: ['#a07f5a', '#8d6e4c', '#785c3f'], cliff: ['#8f877a', '#7c7468'],
      water: '#4a8aa0', waterTop: '#7cb4c4', trees: 'z_stone', treeCols: ['#4f7a48', '#5d8a50'], trunk: '#6a4a30', rock: ['#8f8a80', '#a29d92'], hills: ['#a0b490', '#b4c4a4', '#c8d4ba'], cloud: '#fffaf0',
    },
    antique: {
      skyTop: '#86bde6', skyBottom: '#f4ead2', fog: '#efe3c8', fogNear: 80, fogFar: 340,
      sun: '#fff1d2', sunI: 0.95, hemiSky: '#f0e6cf', hemiGround: '#a0905e', hemiI: 0.92, shadow: 0.34,
      grass: ['#bfb47a', '#b0a46d', '#9c915e'], soil: ['#d2b98c', '#c1a77a', '#a98f64'], cliff: ['#cbb998', '#b6a380'],
      water: '#3f9bb0', waterTop: '#76c3cf', trees: 'z_antique', treeCols: ['#5f7a4a', '#6f8a52'], trunk: '#7a5a3c', rock: ['#c4b494', '#d2c4a6'], hills: ['#dcc9a0', '#e6d8b4', '#f0e6c8'], cloud: '#fffaf0',
    },
    medieval: {
      skyTop: '#8cb2d6', skyBottom: '#e9eef0', fog: '#dfe8e8', fogNear: 80, fogFar: 340,
      sun: '#fff3dc', sunI: 0.88, hemiSky: '#dfe9ee', hemiGround: '#6f8a5a', hemiI: 0.92, shadow: 0.32,
      grass: ['#82a45e', '#759652', '#648245'], soil: ['#9c866a', '#8a755a', '#756249'], cliff: ['#8f8f88', '#7c7c76'],
      water: '#4a7c9c', waterTop: '#7aa8c4', trees: 'z_medieval', treeCols: ['#5a8a4a', '#4f7a44'], trunk: '#5e4630', rock: ['#8f8f88', '#a0a09a'], hills: ['#9ab4a0', '#b0c6b4', '#c6d6c8'], cloud: '#ffffff',
    },
    industry: {
      skyTop: '#9aa6b4', skyBottom: '#e6dccc', fog: '#d4cabc', fogNear: 70, fogFar: 320,
      sun: '#ffe6c0', sunI: 0.82, hemiSky: '#e0d8cc', hemiGround: '#7a7468', hemiI: 0.92, shadow: 0.34,
      grass: ['#7c8a66', '#6f7c5b', '#5f6b4d'], soil: ['#85766a', '#746659', '#625648'], cliff: ['#76726c', '#66625c'],
      water: '#58788a', waterTop: '#82a0b0', trees: 'z_industry', treeCols: ['#4a5a44', '#56664a'], trunk: '#4e3e30', rock: ['#7a766f', '#8a867f'], hills: ['#aaa6a0', '#bcb8b2', '#cecac4'], cloud: '#d8d4cc',
    },
    modern: {
      skyTop: '#78b0de', skyBottom: '#ecf2f6', fog: '#dfe9f0', fogNear: 90, fogFar: 380,
      sun: '#fff4e0', sunI: 0.9, hemiSky: '#e0ebf2', hemiGround: '#82967a', hemiI: 0.92, shadow: 0.3,
      grass: ['#8cb872', '#7fa966', '#6d9657'], soil: ['#a8967a', '#968468', '#7f6f56'], cliff: ['#9a9ca0', '#86888c'],
      water: '#3e82ae', waterTop: '#6aa8cb', trees: 'z_modern', treeCols: ['#6aa066', '#5c9059'], trunk: '#6a5a46', rock: ['#9a9ca0', '#aaacb0'], hills: ['#a9c4b4', '#bcd2c4', '#cfe0d2'], cloud: '#ffffff',
    },
    night: {
      skyTop: '#16224a', skyBottom: '#4c5e94', fog: '#34447a', fogNear: 70, fogFar: 320,
      sun: '#c2ceff', sunI: 0.8, hemiSky: '#8496d0', hemiGround: '#444e78', hemiI: 1.1, shadow: 0.38,
      grass: ['#4f6c64', '#46605d', '#3a524f'], soil: ['#4a5472', '#404966', '#363e58'], cliff: ['#4c5478', '#41486a'],
      water: '#264f86', waterTop: '#4a7ab8', trees: 'pine', treeCols: ['#23403b', '#1d3732'], trunk: '#2b2a34', rock: ['#3c4260', '#484f6c'], hills: ['#222c58', '#2c3868', '#384576'], cloud: '#68789e', night: true, stars: true,
    },
  };

  /** Theme for a level: world → theme id (BB.Worlds) → palette. */
  function themeFor(level) {
    var id = 'green';
    try {
      var w = level && level.world && BB.Worlds && BB.Worlds.get ? BB.Worlds.get(level.world) : null;
      if (!w && level && level.world && BB.TIME && BB.TIME.get) w = BB.TIME.get(level.world);        // v3.4: the epochs of the Zeitreise (they were never found here – every epoch looked 'green')
      if (w && w.theme) id = w.theme;
    } catch (e) { /* default */ }
    return { id: id, t: THEMES[id] || THEMES.green };
  }

  // ---------------------------------------------------------------------------------------------
  R3.u = {
    clamp: clamp, lerp: lerp, hash32: hash32, hash2: hash2, rnd01: rnd01, mulberry32: mulberry32, strHash: strHash,
    hex: hex, mix: mix, shade: shade, toHexNum: toHexNum, css: css, stressRGB: stressRGB,
    Parts: Parts, THEMES: THEMES, themeFor: themeFor,
  };
})(globalThis.BB = globalThis.BB || {});
