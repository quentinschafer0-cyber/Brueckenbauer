(function (BB) {
  'use strict';

  /* ==========================================================================
   * Brückenbauer – physics.js
   * Self-written XPBD ("small steps": many substeps, one constraint iteration
   * each). No DOM access – loadable in Node via vm.runInThisContext.
   *
   * World units: metres, kilograms, seconds, Newtons. x → right, y → UP.
   *
   * FINAL TUNING VALUES (verified by the tests in scratchpad/tests/physics)
   * --------------------------------------------------------------------------
   *  Material     price   mass    strength   max len   stiffness EA   notes
   *               €/m     kg/m    kN         m         MN
   *  road         200     60      50         4         10             drivable
   *  steelroad    400     90      160        5         50             drivable
   *  wood         100     25      55         4         100
   *  steel        300     45      300        6         400
   *  rope         150     8       160        20        200            tension only
   *
   *  Vehicle   mass kg  length m  height m  wheel r m  axles (x from centre)   speed m/s
   *  bike      100      1.8       1.7       0.34       -0.55, 0.55             4.5
   *  car       1200     4.2       1.4       0.34       -1.35, 1.35             8.0
   *  bus       10000    11.0      3.0       0.50       -3.0, 3.2               6.5
   *  truck     20000    10.0      3.4       0.50       -3.7, -2.4, 3.3         5.5
   *
   *  Simulation: FRAME_DT 1/60 s, 30 substeps; gravity ramps in over 0.6 s,
   *  vehicles start driving at 0.8 s; beam forces low-pass filtered (τ 45 ms);
   *  axial beam damping 200 /s (structures settle within ~4 s).
   *
   *  Vehicles: 4-particle rigid chassis, wheels on a 1.6 Hz suspension (digressive
   *  damper, progressive bump stop), compliant damped tyres (2.5 cm static deflection).
   *  Slope changes of the deck are smoothed for the wheels by fillets (≤ 1.5 m tangent
   *  length) at concave joints, the chassis' deck contact has 32° approach / departure
   *  angles, and drivers slow down before sharp slope changes (speed × Δθ ≤ 0.8 m/s).
   * ========================================================================== */

  // ---------------------------------------------------------------- constants
  const G = 9.81;
  const FRAME_DT = 1 / 60;
  const SUBSTEPS = 30;
  const H = FRAME_DT / SUBSTEPS;      // substep length
  const H2 = H * H;
  const INV_H = 1 / H;

  const TUNING = Object.freeze({
    GRAVITY_RAMP: 0.6,       // s, bridge gravity fades in (smoothstep) – avoids start-up overshoot
    DRIVE_START: 0.8,        // s, vehicles start driving
    FORCE_TAU: 0.045,        // s, low-pass time constant of the beam force before the break test
    BEAM_DAMP: 200,          // 1/s, decay rate of the relative axial velocity of a beam's two nodes
    ROT_DAMP: 8,             // 1/s, decay rate of a beam's rotation relative to its neighbours
    GLOBAL_DAMP: 0.04,       // 1/s, tiny global velocity damping
    NODE_MIN_MASS: 5,        // kg added to every bridge node
    NODE_RADIUS: 0.12,       // m, collision radius of bridge nodes / debris vs terrain
    BODY_RADIUS: 0.08,       // m, collision radius of vehicle body corners
    BODY_DEPTH: 0.35,        // m, body corners deeper than this below a deck are not pushed up
    BODY_APPROACH: 32,       // degrees, approach / departure angle of the chassis' deck-contact shape
    FRICTION: 0.6,           // Coulomb friction of debris / bodies on terrain and decks
    TRACTION: 1.0,           // max drive force / normal force per wheel
    WATER_DRAG: 2.5,         // 1/s
    WATER_BUOYANCY: 0.85,    // fraction of gravity cancelled under water (slow sinking)
    SPLASH_SPEED: 1.0,       // m/s, minimum downward speed for a splash event
    SPAWN_GAP: 3,            // m, next vehicle spawns when the previous rear is this far past startX
    FOLLOW_GAP: 3.5,         // m, preferred gap of the adaptive cruise control
    MIN_GAP: 2.5,            // m, below this gap the follower brakes to standstill
    CRUISE_KP: 2.0,          // 1/s, speed controller gain
    HOLD_KP: 12,             // 1/s, extra gain when the target speed is (nearly) zero
    ACCEL_MAX: 2.0,          // m/s², max commanded acceleration on flat ground
    DRIVE_MAX: 3.2,          // N/kg, max drive force (≈ 20 % slope + 1.2 m/s²)
    BRAKE_MAX: 6.0,          // N/kg, max brake force
    ICE_FRICTION: 0.2,       // fraction of FRICTION kept on an icy level
    ICE_TRACTION: 0.4,       // fraction of TRACTION kept on an icy level
    CARGO_RADIUS: 0.32,      // m, crate collision radius
    CARGO_MASS: 180,         // kg, per crate
    BRAKE_ACCEL: 4.0,        // m/s², max commanded deceleration
    WHEEL_MASS_FRAC: 0.08,   // fraction of the vehicle mass in the wheels
    SUSP_FREQ: 1.6,          // Hz, suspension natural frequency
    SUSP_ZETA: 0.55,         // suspension damping ratio (vertical)
    SUSP_HSTIFF: 25,         // horizontal / vertical suspension stiffness ratio
    SUSP_TRAVEL: 0.5,        // bump-stop travel beyond static sag, fraction of the wheel radius
    SUSP_KNEE: 0.3,          // m/s, digressive damper: force stops rising above this relative speed
    SUSP_BUMP: 8,            // bump-stop stiffness / suspension stiffness (rigid after 60 % more travel)
    TYRE_DEFL: 0.025,        // m, static tyre deflection (wheel contact stiffness = static wheel load / this)
    TYRE_ZETA: 0.3,          // tyre damping ratio (relative to the wheel mass)
    TYRE_MAXPEN: 0.3,        // tyre deflection beyond this fraction of the wheel radius is resolved rigidly
    FILLET_LEN: 1.5,         // m, max tangent length of the wheel-contact fillet at concave deck joints
    FILLET_MAX_ANGLE: 60,    // degrees, sharper slope changes keep a hard corner
    KINK_DV: 0.8,            // m/s, drivers slow down so that speed × slope change (rad) ≤ this
    KINK_VMIN: 1.5,          // m/s, … but not below this speed
    KINK_DECEL: 1.5,         // m/s², planned deceleration towards a slope change
    KINK_LOOK: 16,           // m, look-ahead of the driver beyond the front wheel
    STUCK_TIME: 8,           // s without progress → 'stuck'
    STUCK_DIST: 0.5,         // m, minimum progress
    FLIP_ANGLE: 110,         // degrees
    REMOVE_DIST: 40,         // m behind the flag a finished vehicle disappears
    TIMEOUT_BASE: 40,        // s
    TIMEOUT_PER_VEHICLE: 30, // s
    EMPTY_WIN_TIME: 3,       // s, a run without vehicles is won after this time if nothing broke
    HYD_STROKE: 0.5,         // hydraulic piston: extended length = retracted length × (1 + this) …
    HYD_STROKE_MAX: 4,       // … but at most this many metres longer
    HYD_SPEED: 1.0,          // m/s, extension speed of a hydraulic beam
    HYD_ACCEL: 2.5,          // m/s², smooth start / stop of a hydraulic beam
    OBSTACLE_R: 0.3,         // m, vehicles closer than this to an obstacle beam crash
  });

  const FILLET_COS_MAX = Math.cos(TUNING.FILLET_MAX_ANGLE * Math.PI / 180);
  const FILLET_FADE = 0.05;   // rad, below this slope change the fillet shrinks linearly to nothing
  const FILLET_GAP = 0.45;    // m, upper bound of the fillet's distance from the joint (broad phase)
  const KINK_DS = 0.5;        // m, sample spacing of the driver's road look-ahead

  // ---------------------------------------------------------------- materials
  // k: constant spring rate (N/m) instead of an axial stiffness EA; damp: factor on the axial beam
  // damping (springs must be able to oscillate); hyd: variable length (phases).
  const MATERIALS = {
    road: { key: 'road', name: 'Straße', price: 200, mass: 60, strength: 50000, maxLength: 4,
      drivable: true, tensionOnly: false, stiffness: 1.0e7, color: '#4a4a52' },
    steelroad: { key: 'steelroad', name: 'Verstärkte Straße', price: 400, mass: 90, strength: 160000, maxLength: 5,
      drivable: true, tensionOnly: false, stiffness: 5.0e7, color: '#5d7286' },
    wood: { key: 'wood', name: 'Holz', price: 100, mass: 25, strength: 55000, maxLength: 4,
      drivable: false, tensionOnly: false, stiffness: 1.0e8, color: '#b5793a' },
    steel: { key: 'steel', name: 'Stahl', price: 300, mass: 45, strength: 300000, maxLength: 6,
      drivable: false, tensionOnly: false, stiffness: 4.0e8, color: '#d4532a' },
    rope: { key: 'rope', name: 'Seil', price: 150, mass: 8, strength: 160000, maxLength: 20,
      drivable: false, tensionOnly: true, stiffness: 2.0e8, color: '#3a2e26' },
    cable: { key: 'cable', name: 'Kabel', price: 420, mass: 16, strength: 560000, maxLength: 28,
      drivable: false, tensionOnly: true, stiffness: 6.0e8, color: '#8d99a6' },
    spring: { key: 'spring', name: 'Feder', price: 260, mass: 22, strength: 200000, maxLength: 5,
      drivable: false, tensionOnly: false, stiffness: 1.0e8, k: 8.0e5, damp: 0.07, color: '#2fa84f' },
    hydraulic: { key: 'hydraulic', name: 'Hydraulik', price: 450, mass: 42, strength: 600000, maxLength: 6,
      drivable: false, tensionOnly: false, stiffness: 3.0e8, hyd: true, color: '#f0b429' },
    rail: { key: 'rail', name: 'Schiene', price: 500, mass: 140, strength: 520000, maxLength: 6,
      drivable: true, tensionOnly: false, stiffness: 6.0e8, color: '#4b4540' },
    concrete: { key: 'concrete', name: 'Beton-Pfeiler', price: 850, mass: 260, strength: 1200000, maxLength: 14,
      drivable: false, tensionOnly: false, stiffness: 1.2e9, color: '#8a8f98', vertical: true },
  };
  const MATERIAL_ORDER = ['road', 'steelroad', 'wood', 'steel', 'rope', 'cable', 'spring', 'hydraulic', 'rail', 'concrete'];
  // "Fundament": not a beam but a rigidly planted anchor point the player places on the ground
  // (see Bridge.foundationAt). Expensive, but it adds a fixed support exactly where the load is.
  const FOUNDATION = { key: 'foundation', name: 'Fundament', price: 1500, defaultMax: 3, color: '#9aa0a8' };
  const FOUNDATION_MAX_SLOPE = 0.9;   // tan of the steepest ground a foundation may stand on (≈ 42°)
  const HYD_PHASES = 6;     // number of phases the player can program per hydraulic beam

  // ----------------------------------------------------------------- vehicles
  // axles: x offsets of the wheel centres from the body centre (body frame).
  // In the body frame (origin = chassis bottom centre) the wheel centres rest at y ≈ 0,
  // i.e. the body's bottom edge passes through the wheel centres.
  const VEHICLES = {
    bike: { key: 'bike', name: 'Fahrrad', mass: 100, length: 1.8, height: 1.7, wheelRadius: 0.34,
      axles: [-0.55, 0.55], speed: 4.5, color: '#2e86de' },
    car: { key: 'car', name: 'Auto', mass: 1200, length: 4.2, height: 1.4, wheelRadius: 0.34,
      axles: [-1.35, 1.35], speed: 8, color: '#e74c3c' },
    bus: { key: 'bus', name: 'Bus', mass: 10000, length: 11, height: 3.0, wheelRadius: 0.5,
      axles: [-3.0, 3.2], speed: 6.5, color: '#f5b700' },
    truck: { key: 'truck', name: 'LKW', mass: 20000, length: 10, height: 3.4, wheelRadius: 0.5,
      axles: [-3.7, -2.4, 3.3], speed: 5.5, color: '#2f9e44' },
    motorcycle: { key: 'motorcycle', name: 'Motorrad', mass: 220, length: 2.0, height: 1.3, wheelRadius: 0.32,
      axles: [-0.75, 0.75], speed: 11, color: '#c0392b' },
    tanker: { key: 'tanker', name: 'Tanklaster', mass: 24000, length: 12, height: 3.3, wheelRadius: 0.5,
      axles: [-4.2, -2.9, 4.5], speed: 5, color: '#95a5a6' },
    crane: { key: 'crane', name: 'Kran-LKW', mass: 26000, length: 9.5, height: 3.6, wheelRadius: 0.55,
      axles: [-3.5, -2.1, 3.1], speed: 4.5, color: '#f5b700' },
    train: { key: 'train', name: 'Zug', mass: 70000, length: 24, height: 3.8, wheelRadius: 0.55,
      axles: [-10.5, -7, -3.5, 0, 3.5, 7, 10.5], speed: 7, color: '#34495e' },
  };
  const VEHICLE_ORDER = ['bike', 'motorcycle', 'car', 'bus', 'truck', 'tanker', 'crane', 'train'];

  // particle kinds
  const K_NODE = 0;   // bridge node / debris point (gravity ramp, terrain + friction)
  const K_BODY = 1;   // vehicle chassis corner (terrain + deck from above, friction)
  const K_WHEEL = 2;  // vehicle wheel (terrain + deck two-sided, no friction except drive/brake)

  // ================================================================== Terrain
  // The terrain is the polygon below the polyline `ground` (x non-decreasing, vertical walls
  // allowed). Outside the x-range of the polyline there is no terrain.

  function segClosest(ax, ay, bx, by, px, py, out) {
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    out[0] = ax + ex * t; out[1] = ay + ey * t; out[2] = t;
    const dx = px - out[0], dy = py - out[1];
    return dx * dx + dy * dy;
  }
  const _tmp = [0, 0, 0];

  const Terrain = {
    /** Highest ground surface y at x (flat extension beyond the polyline ends). */
    surfaceY(ground, x) {
      const n = ground ? ground.length : 0;
      if (!n) return -1000;
      if (x <= ground[0][0]) return x < ground[0][0] ? ground[0][1] : maxYAt(ground, x);
      if (x >= ground[n - 1][0]) return x > ground[n - 1][0] ? ground[n - 1][1] : maxYAt(ground, x);
      return maxYAt(ground, x);
    },
    /** Point strictly inside the solid terrain. */
    inside(ground, x, y) {
      const n = ground ? ground.length : 0;
      if (n < 2) return false;
      let found = false, minY = Infinity;
      for (let i = 0; i < n - 1; i++) {
        const ax = ground[i][0], bx = ground[i + 1][0];
        if (bx <= ax || x < ax || x > bx) continue;   // only non-vertical segments spanning x
        const sy = ground[i][1] + (ground[i + 1][1] - ground[i][1]) * (x - ax) / (bx - ax);
        found = true; if (sy < minY) minY = sy;
      }
      return found && y < minY - 1e-9;
    },
    /** Distance from the point to the ground polyline. */
    distance(ground, x, y) {
      const n = ground ? ground.length : 0;
      if (n === 0) return Infinity;
      if (n === 1) return Math.hypot(x - ground[0][0], y - ground[0][1]);
      let best = Infinity;
      for (let i = 0; i < n - 1; i++) {
        const d2 = segClosest(ground[i][0], ground[i][1], ground[i + 1][0], ground[i + 1][1], x, y, _tmp);
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best);
    },
  };

  function maxYAt(ground, x) {
    let best = -Infinity;
    for (let i = 0; i < ground.length - 1; i++) {
      const ax = ground[i][0], bx = ground[i + 1][0];
      if (x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
      let sy;
      if (bx === ax) sy = Math.max(ground[i][1], ground[i + 1][1]);
      else sy = ground[i][1] + (ground[i + 1][1] - ground[i][1]) * (x - ax) / (bx - ax);
      if (sy > best) best = sy;
    }
    if (best === -Infinity) {   // x between points but no segment (cannot happen for sorted input)
      best = ground[0][1];
    }
    return best;
  }

  // Fast terrain representation for the simulation.
  function prepTerrain(ground) {
    const n = ground ? ground.length : 0;
    const gx = new Float64Array(n), gy = new Float64Array(n);
    let minY = Infinity;
    for (let i = 0; i < n; i++) {
      gx[i] = +ground[i][0]; gy[i] = +ground[i][1];
      if (gy[i] < minY) minY = gy[i];
    }
    return { gx, gy, n, minY: n ? minY : -1000 };
  }
  // first segment index whose end x ≥ xmin (segments i = 0 .. n-2)
  function segFirst(T, xmin) {
    const gx = T.gx;
    let lo = 0, hi = T.n - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gx[mid + 1] < xmin) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // last segment index whose start x ≤ xmax (−1 if none)
  function segLast(T, xmax) {
    const gx = T.gx;
    let lo = 0, hi = T.n - 2;
    if (hi < 0 || gx[0] > xmax) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (gx[mid] <= xmax) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // =================================================================== Bridge
  // Bridge = { beams: [{x1,y1,x2,y2,m, s1?, s2?, ph?}], found?: [[x,y], …] }
  //   s1 / s2 = 1: that beam end sits in the SPLIT node of its grid point (a second, independent
  //               hinge at the same position – beams of different groups are not connected).
  //   ph: hydraulic beams only – action ('out' | 'hold' | 'in') per phase.
  //   found: foundations (fixed anchors planted on the ground, see Bridge.foundationY).
  // Level extras used here: zones (build rectangles), prebuilt { beams } (fixed parts of the level;
  //   beams flagged o:1 are solid obstacles), foundations (max count), materials (allow-list).
  function key(x, y) { return x + ',' + y; }
  function gkey(x, y, g) { return g ? x + ',' + y + '#1' : x + ',' + y; }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  const PHASE_ACTIONS = ['hold', 'out', 'in'];

  function zonesOf(level) {
    if (level && Array.isArray(level.zones) && level.zones.length) return level.zones;
    const bd = level && level.build;
    return bd ? [{ x0: bd.minX, y0: bd.minY, x1: bd.maxX, y1: bd.maxY }] : null;
  }
  function inZones(level, x, y) {
    const zs = zonesOf(level);
    if (!zs) return true;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return true;
    }
    return false;
  }
  function prebuiltBeams(level) {
    return (level && level.prebuilt && Array.isArray(level.prebuilt.beams)) ? level.prebuilt.beams : [];
  }
  function isPrebuiltNode(level, x, y) {
    const pb = prebuiltBeams(level);
    for (let i = 0; i < pb.length; i++) {
      if ((pb[i].x1 === x && pb[i].y1 === y) || (pb[i].x2 === x && pb[i].y2 === y)) return true;
    }
    return false;
  }
  /** Segments crossing properly (touching at shared end points does not count). */
  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  }

  /** The level with the bridge's foundations added to its anchors (unchanged level if none). */
  function effLevel(level, bridge) {
    const f = bridge && Array.isArray(bridge.found) ? bridge.found : null;
    if (!f || !f.length) return level;
    return Object.assign({}, level, { anchors: ((level && level.anchors) || []).concat(f) });
  }

  const Bridge = {
    key,
    gkey,
    length(b) { return Math.hypot(b.x2 - b.x1, b.y2 - b.y1); },
    zonesOf, inZones, prebuiltBeams, isPrebuiltNode, effLevel,
    cost(bridge) {
      let s = 0;
      const beams = (bridge && bridge.beams) || [];
      for (let i = 0; i < beams.length; i++) {
        const m = MATERIALS[beams[i].m];
        if (m) s += m.price * Bridge.length(beams[i]);
      }
      if (bridge && Array.isArray(bridge.found)) s += bridge.found.length * FOUNDATION.price;
      return Math.round(s);
    },
    /** y of the foundation node standing on the ground at integer x (≤ 1 m above the surface). */
    foundationY(level, x) {
      const surf = Terrain.surfaceY((level && level.ground) || [], x);
      return isFinite(surf) ? Math.ceil(surf - 1e-6) : null;
    },
    foundationMax(level) {
      if (level && level.sandbox) return 99;
      return (level && typeof level.foundations === 'number') ? level.foundations : FOUNDATION.defaultMax;
    },
    crossesObstacle(level, x1, y1, x2, y2) {
      const pb = prebuiltBeams(level);
      for (let i = 0; i < pb.length; i++) {
        if (pb[i].o && segCross(x1, y1, x2, y2, pb[i].x1, pb[i].y1, pb[i].x2, pb[i].y2)) return true;
      }
      return false;
    },
    allows(level, k) {
      return !(level && Array.isArray(level.materials) && level.materials.length) || level.materials.indexOf(k) >= 0;
    },
    /** The spot a foundation would take for a pointer at world x: { x, y (node), surf (ground below it), ok, reason }.
     *  The x snaps to the grid, y to the ground below – never into the air. */
    foundationSpot(level, bridge, wx) {
      const x = Math.round(wx), y = Bridge.foundationY(level, x);
      if (y === null) return { x: x, y: null, surf: null, ok: false, reason: 'Hier ist kein Boden' };
      const surf = Terrain.surfaceY((level && level.ground) || [], x);
      const reason = Bridge.checkFoundation(level, bridge, x);
      return { x: x, y: y, surf: surf, ok: !reason, reason: reason };
    },
    /** null when a foundation may be planted at (x, y = foundationY) else a German reason. */
    checkFoundation(level, bridge, x) {
      if (!Bridge.allows(level, 'foundation')) return 'Fundamente sind in diesem Level nicht erlaubt';
      if (!isInt(x)) return 'Punkt liegt nicht auf dem Raster';
      const y = Bridge.foundationY(level, x);
      if (y === null) return 'Hier ist kein Boden';
      // foundations stand on the ground, not on a wall: the surface must be reasonably flat around the spot
      const gnd = level.ground || [], s0 = Terrain.surfaceY(gnd, x), sl = Terrain.surfaceY(gnd, x - 0.5), sr = Terrain.surfaceY(gnd, x + 0.5);
      if (isFinite(s0) && isFinite(sl) && isFinite(sr) && Math.max(Math.abs(sr - s0), Math.abs(s0 - sl)) > 0.5 * FOUNDATION_MAX_SLOPE) return 'Der Boden ist hier zu steil';
      if (!inZones(level, x, y)) return 'Außerhalb der Bauzone';
      const gs = gatesOf(level);
      for (let i = 0; i < gs.length; i++) {
        if (x >= gs[i].x0 - 0.5 && x <= gs[i].x1 + 0.5) return gs[i].kind === 'ship' ? 'Hier fährt ein Schiff durch' : gs[i].kind === 'train' ? 'Hier fährt der Zug durch' : 'Hier fährt der Verkehr durch';
      }
      const list = (bridge && bridge.found) || [];
      for (let i = 0; i < list.length; i++) if (list[i][0] === x) return 'Hier steht schon ein Fundament';
      if (list.length >= Bridge.foundationMax(level)) return 'Mehr als ' + Bridge.foundationMax(level) + ' Fundamente sind hier nicht erlaubt';
      if (Bridge.isAnchor(level, x, y)) return 'Hier ist schon ein Ankerpunkt';
      return null;
    },
    nodes(bridge, level) {
      const out = [], seen = new Set();
      const anchors = (level && level.anchors) || [];
      for (let i = 0; i < anchors.length; i++) {
        const k = key(anchors[i][0], anchors[i][1]);
        if (seen.has(k)) continue;
        seen.add(k); out.push({ x: anchors[i][0], y: anchors[i][1], anchor: true });
      }
      const found = (bridge && bridge.found) || [];
      for (let i = 0; i < found.length; i++) {
        const k = key(found[i][0], found[i][1]);
        if (seen.has(k)) continue;
        seen.add(k); out.push({ x: found[i][0], y: found[i][1], anchor: true, found: true });
      }
      const pb = prebuiltBeams(level);
      for (let i = 0; i < pb.length; i++) {
        for (let e = 0; e < 2; e++) {
          const x = e ? pb[i].x2 : pb[i].x1, y = e ? pb[i].y2 : pb[i].y1;
          const k = key(x, y);
          if (seen.has(k)) continue;
          seen.add(k); out.push({ x, y, anchor: false, pre: true });
        }
      }
      const beams = (bridge && bridge.beams) || [];
      for (let i = 0; i < beams.length; i++) {
        const b = beams[i];
        for (let e = 0; e < 2; e++) {
          const x = e ? b.x2 : b.x1, y = e ? b.y2 : b.y1;
          const k = key(x, y);
          if (seen.has(k)) continue;
          seen.add(k); out.push({ x, y, anchor: false });
        }
      }
      return out;
    },
    isAnchor(level, x, y) {
      const anchors = (level && level.anchors) || [];
      for (let i = 0; i < anchors.length; i++) if (anchors[i][0] === x && anchors[i][1] === y) return true;
      return false;
    },
    /** null if a (non-anchor) node may be placed at (x, y), else a German reason.
     *  touchOk (used for the foot of a vertical concrete pillar) allows the point to rest
     *  directly ON the ground instead of requiring the usual 0.5 m clearance. */
    checkNode(level, x, y, touchOk) {
      if (Bridge.isAnchor(level, x, y)) return null;
      if (!isInt(x) || !isInt(y)) return 'Punkt liegt nicht auf dem Raster';
      if (isPrebuiltNode(level, x, y)) return null;
      if (!inZones(level, x, y)) return (level && Array.isArray(level.zones) && level.zones.length) ? 'Außerhalb der Bauzone' : 'Außerhalb des Baubereichs';
      const ground = (level && level.ground) || [];
      if (Terrain.inside(ground, x, y)) return 'Punkt liegt im Gelände';
      if (!touchOk && Terrain.distance(ground, x, y) < 0.5 - 1e-9) return 'Zu nah am Gelände';
      return null;
    },
    /** Checks all building rules of SPEC §4. errors: unique German messages;
     *  details: [{msg, beam:index}] or [{msg, node:[x,y]}] for highlighting. */
    validate(level0, bridge) {
      const errors = [], details = [];
      const add = (msg, d) => { if (errors.indexOf(msg) < 0) errors.push(msg); d.msg = msg; details.push(d); };
      if (!bridge || !Array.isArray(bridge.beams)) {
        add('Ungültige Brücke', {});
        return { ok: false, errors, details };
      }
      // foundations first (they become anchors for the node checks below)
      const found = Array.isArray(bridge.found) ? bridge.found : [];
      const okFound = [];
      for (let i = 0; i < found.length; i++) {
        const f = found[i];
        const fx = Array.isArray(f) ? f[0] : NaN;
        const msg = Array.isArray(f) && f[1] === Bridge.foundationY(level0, fx)
          ? Bridge.checkFoundation(level0, { found: okFound }, fx) : 'Ungültiges Fundament';
        if (msg) add(msg, { node: Array.isArray(f) ? [f[0], f[1]] : [0, 0] }); else okFound.push(f);
      }
      const level = effLevel(level0, { found: okFound });
      const allowed = (level && Array.isArray(level.materials) && level.materials.length) ? level.materials : MATERIAL_ORDER;
      const ground = (level && level.ground) || [];
      const seen = new Set();
      const nodeKeys = new Set(), nodeList = [];
      const obstacles = prebuiltBeams(level).filter((p) => p.o);
      for (let i = 0; i < bridge.beams.length; i++) {
        const b = bridge.beams[i];
        if (!b || !isInt(b.x1) || !isInt(b.y1) || !isInt(b.x2) || !isInt(b.y2)) { add('Ungültige Koordinaten', { beam: i }); continue; }
        const mat = MATERIALS[b.m];
        if (!mat) { add('Unbekanntes Material', { beam: i }); continue; }
        if (allowed.indexOf(b.m) < 0) add('Material in diesem Level nicht erlaubt', { beam: i });
        const len = Bridge.length(b);
        if (!(len > 0)) { add('Balken hat keine Länge', { beam: i }); continue; }
        if (len > mat.maxLength + 1e-9) add('Zu lang für dieses Material', { beam: i });
        if (mat.vertical && b.x1 !== b.x2) add(mat.name + (mat.key === 'concrete' ? '' : '') + ' müssen senkrecht stehen', { beam: i });
        if ((b.s1 !== undefined && b.s1 !== 0 && b.s1 !== 1) || (b.s2 !== undefined && b.s2 !== 0 && b.s2 !== 1)) add('Ungültiges geteiltes Gelenk', { beam: i });
        if (b.ph !== undefined && (!Array.isArray(b.ph) || b.ph.length > HYD_PHASES || b.ph.some((a) => PHASE_ACTIONS.indexOf(a) < 0))) add('Ungültige Hydraulik-Phasen', { beam: i });
        for (let q = 0; q < obstacles.length; q++) {
          const o = obstacles[q];
          if (segCross(b.x1, b.y1, b.x2, b.y2, o.x1, o.y1, o.x2, o.y2)) { add('Kreuzt ein festes Hindernis', { beam: i }); break; }
        }
        const k1 = key(b.x1, b.y1), k2 = key(b.x2, b.y2);
        const pk = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (seen.has(pk)) add('Doppelter Balken', { beam: i });
        seen.add(pk);
        if (!nodeKeys.has(k1)) { nodeKeys.add(k1); nodeList.push([b.x1, b.y1]); }
        if (!nodeKeys.has(k2)) { nodeKeys.add(k2); nodeList.push([b.x2, b.y2]); }
      }
      // Only the lowest point of each vertical (concrete) pillar stack must actually touch solid
      // ground (or an anchor); intermediate joints between stacked segments are normal nodes.
      const touchOk = new Set();
      const feet = pillarFeet(bridge);
      for (let i = 0; i < feet.length; i++) {
        const fx = feet[i][0], fy = feet[i][1];
        const onAnchor = Bridge.isAnchor(level, fx, fy);
        const surf = Terrain.surfaceY(ground, fx);
        if (!onAnchor && !(isFinite(surf) && Math.abs(fy - surf) <= 0.25)) {
          add('Ein senkrechter Pfeiler braucht festen Boden am unteren Ende', { node: [fx, fy] });
        } else {
          touchOk.add(key(fx, fy));
        }
      }
      for (let i = 0; i < nodeList.length; i++) {
        const nk = key(nodeList[i][0], nodeList[i][1]);
        const msg = Bridge.checkNode(level, nodeList[i][0], nodeList[i][1], touchOk.has(nk));
        if (msg) add(msg, { node: nodeList[i] });
      }
      return { ok: errors.length === 0, errors, details };
    },
    clone(bridge) {
      const beams = (bridge && bridge.beams) || [];
      const out = { beams: beams.map((b) => {
        const c = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m };
        if (b.s1) c.s1 = 1;
        if (b.s2) c.s2 = 1;
        if (Array.isArray(b.ph)) c.ph = b.ph.slice();
        return c;
      }) };
      if (bridge && Array.isArray(bridge.found) && bridge.found.length) out.found = bridge.found.map((f) => [f[0], f[1]]);
      return out;
    },
  };

  // ============================================================ sim building
  function newParticle(x, y, mass, r, kind) {
    // All particles share one object shape (keeps the hot loops monomorphic).
    return {
      x: x, y: y, px: x, py: y, vx: 0, vy: 0,
      w: mass > 0 ? 1 / mass : 0, r: r, anchor: false, deg: 0,
      // ---- internal ----
      mass: mass, kind: kind, on: false,
      ox: x, oy: y,                  // position at the start of the current substep
      tlo: 0, thi: -1, tnear: false, // terrain segment range of this frame
      cand: null,                    // drivable beam candidates of this frame (vehicle particles)
      clam: 0,                       // accumulated normal contact multiplier (kg·m) this substep
      cbest: 0, cnx: 0, cny: 0,      // strongest contact of this substep: multiplier + normal
      cbeam: null, ct: 0,            // … and its beam + barycentric position (null = terrain)
      om: 0, omc: 0,                 // sum / count of attached beams' angular velocities (damping)
      tc: 0, td: 0,                  // wheels: tyre compliance α̃ (1/(k h²)) and damping (N·s/m)
    };
  }

  function beamCompliance(mat, rest) { return (mat.k ? 1 / mat.k : rest / mat.stiffness) / H2; }
  function makeBeam(a, b, mat, rest, debris) {
    return {
      a: a, b: b, m: mat.key, rest: rest, force: 0, stress: 0, broken: false, debris: debris,
      // ---- internal ----
      mat: mat, strength: mat.strength, strengthC: mat.strengthC || mat.strength, tensionOnly: mat.tensionOnly,
      at: beamCompliance(mat, rest),     // XPBD compliance α̃ = α / h², α = rest / EA (or 1 / k)
      damp: mat.damp === undefined ? 1 : mat.damp, hyd: !!mat.hyd, restMin: rest, restMax: rest, ph: null, pre: false, hv: 0,
      lam: 0, nx: 0, ny: 0, om: 0, src: -1,
      pa: null, pb: null,            // drivable beams: fillet partner at end a / b (see rebuildLists)
    };
  }

  function smooth01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  // The lowest point of every vertical (concrete) beam "stack" at each x, i.e. the pillar's
  // actual foot. Mirrors the grouping in Bridge.validate(); used there (to relax the normal
  // ground-clearance rule for that one point) and in createSim (to anchor it: a pillar foot that
  // reaches solid ground is meant to be rigidly planted, not a free node resting on it via
  // contact – the latter would fight the beam's fixed rest length and never settle).
  function pillarFeet(bridge) {
    const beams = (bridge && Array.isArray(bridge.beams)) ? bridge.beams : [];
    const minY = new Map();
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i], mat = MATERIALS[b.m];
      if (!mat || !mat.vertical || b.x1 !== b.x2) continue;
      const footY = Math.min(b.y1, b.y2);
      const cur = minY.get(b.x1);
      if (cur === undefined || footY < cur) minY.set(b.x1, footY);
    }
    const out = [];
    minY.forEach((y, x) => out.push([x, y]));
    return out;
  }

  // Vehicle entries of a level: 'car' or { t: 'car', r: routeIndex, c: '#rrggbb', d: delaySeconds }.
  function vehicleEntries(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const k = typeof e === 'string' ? e : (e && typeof e === 'object' ? e.t : null);
      if (!VEHICLES[k]) continue;
      out.push({
        key: k,
        route: (e && typeof e === 'object' && isFinite(e.r)) ? Math.max(0, Math.floor(e.r)) : 0,
        color: (e && typeof e === 'object' && typeof e.c === 'string') ? e.c : null,
        delay: (e && typeof e === 'object' && isFinite(e.d)) ? Math.max(0, +e.d) : 0,
        // v3.4: the vehicle leaves only when vehicle a[0] (index in the list) has reached its station a[1] (1 = first flag … n = goal)
        after: (e && typeof e === 'object' && Array.isArray(e.a) && Number.isInteger(e.a[0]) && Number.isInteger(e.a[1])) ? [e.a[0], Math.max(1, e.a[1])] : null,
      });
    }
    return out;
  }
  /** Vehicle routes: level.routes [{ startX, flagX, color }] or the single startX → flagX route. */
  const ROUTE_COLORS = ['#e8453c', '#2e86de', '#2fb344', '#f5b700', '#a55eea'];
  function surfaceOfLevel(level, x) {
    const g = level && level.ground;
    if (!Array.isArray(g) || !g.length) return 0;
    const y = BB.Terrain && BB.Terrain.surfaceY ? BB.Terrain.surfaceY(g, x) : NaN;
    return isFinite(y) ? y : g[0][1];
  }
  /**
   * v3.4: a route is an ordered list of stations (flags). level.routes[i] = { startX, flagX, color, via: [{ x, y? }…], flagY? };
   * `via` are the intermediate flags (in driving order, x ascending), the goal flag is the last station. y = the height of the flag
   * base (default: the ground at x; give it for a flag on a bridge deck). A route with `via` or `flagY` is "strict": every
   * station must be reached at its height, in order – a vehicle that passes one at the wrong height has missed it.
   */
  function routesOf(level) {
    const out = [];
    function build(startX, flagX, color, r) {
      const via = (r && Array.isArray(r.via) ? r.via : []).filter((q) => q && isFinite(q.x)).map((q) => ({ x: +q.x, y: isFinite(q.y) ? +q.y : null })).sort((a, b) => a.x - b.x);
      const stations = via.concat([{ x: flagX, y: r && isFinite(r.flagY) ? +r.flagY : null }]);
      stations.forEach((q, k) => { q.n = k + 1; if (q.y === null) q.y = surfaceOfLevel(level, q.x); });
      return { startX: startX, flagX: flagX, color: color, stations: stations, strict: !!(via.length || (r && isFinite(r.flagY))), after: r && r.after ? r.after : null };
    }
    if (level && Array.isArray(level.routes)) {
      for (let i = 0; i < level.routes.length; i++) {
        const r = level.routes[i];
        if (r && isFinite(r.startX) && isFinite(r.flagX)) out.push(build(+r.startX, +r.flagX, r.color || ROUTE_COLORS[out.length % ROUTE_COLORS.length], r));
      }
    }
    if (!out.length) out.push(build((level && isFinite(level.startX)) ? +level.startX : 0, (level && isFinite(level.flagX)) ? +level.flagX : 0, ROUTE_COLORS[0], level));
    return out;
  }

  function createSim(level, bridge, opts) {
    opts = opts || {};
    level = level || {};
    const effL = effLevel(level, bridge);
    const T = prepTerrain(level.ground || []);
    const water = (typeof level.water === 'number' && isFinite(level.water)) ? level.water : null;
    const anchors = Array.isArray(effL.anchors) ? effL.anchors : [];
    let minAnchorY = Infinity;
    for (let i = 0; i < anchors.length; i++) if (anchors[i][1] < minAnchorY) minAnchorY = anchors[i][1];
    if (minAnchorY === Infinity) minAnchorY = 0;
    const fallY = (typeof level.fallY === 'number' && isFinite(level.fallY)) ? level.fallY
      : (water !== null ? water : minAnchorY - 6);

    const sim = {
      level: level, t: 0, status: 'running', reason: null,
      particles: [], joints: [], beams: [], vehicles: [], events: [],
      found: (bridge && Array.isArray(bridge.found)) ? bridge.found.map((f) => [f[0], f[1]]) : [],
      _s: null,
    };
    const entries = vehicleEntries(Array.isArray(opts.vehicles) ? opts.vehicles : level.vehicles);
    const routes = routesOf(level);
    sim.routes = routes;
    const isIce = !!level.ice;
    const S = {
      T: T, water: water, fallY: fallY,
      killY: Math.min(T.minY, water !== null ? water : T.minY) - 30,
      frame: 0,
      active: [],          // simulated particles (w > 0, on)
      nodes: [],           // bridge node + debris particles (kind 0)
      live: [],            // beams that are solved (intact + debris)
      intact: [],          // intact, non-debris beams (break test)
      drivable: [],        // intact drivable beams (wheel/body contact)
      hyds: [],            // intact hydraulic beams
      obstacles: [],       // solid prebuilt obstacle segments { x1, y1, x2, y2 }
      liveVehicles: [],    // spawned, not removed vehicles
      cargo: [],           // crates (see buildCargo)
      gates: [],           // passage gates (ships / trucks / trains passing the bridge plane, see buildGates)
      holds: [],           // stop lines where vehicles wait (traffic light of a gate, lift platform)
      holdActive: false,
      pistons: [],         // hydraulic pistons (see buildPistons)
      routes: routes.map((r) => ({ startX: r.startX, flagX: r.flagX, color: r.color, stations: r.stations, strict: r.strict, last: null })),
      phase: 0,            // current hydraulics phase (advanced by a HUD button or checkpoints)
      checkpointHit: null, // Set of triggered checkpoint indices
      dirty: true,
      maxStress: 0, maxStressBeam: null, brokenCount: 0, finished: 0,
      startX: routes[0].startX,
      flagX: routes[0].flagX,
      timeout: TUNING.TIMEOUT_BASE + TUNING.TIMEOUT_PER_VEHICLE * entries.length,
      lastSplashT: -1e9, lastSplashX: 0,
      wind: (typeof level.wind === 'number' && isFinite(level.wind)) ? level.wind : 0,
      ice: isIce,
      friction: isIce ? TUNING.FRICTION * TUNING.ICE_FRICTION : TUNING.FRICTION,
      traction: isIce ? TUNING.TRACTION * TUNING.ICE_TRACTION : TUNING.TRACTION,
      hitReason: null,
    };
    sim._s = S;

    // ---- bridge nodes & beams
    const map = new Map();
    for (let i = 0; i < anchors.length; i++) {
      const ax = +anchors[i][0], ay = +anchors[i][1];
      const k = key(ax, ay);
      if (map.has(k)) continue;
      const p = newParticle(ax, ay, 0, TUNING.NODE_RADIUS, K_NODE);
      p.anchor = true; p.w = 0;
      map.set(k, p);
      sim.particles.push(p); sim.joints.push(p);
    }
    // The foot of a concrete pillar that reaches solid ground is rigidly planted (like an anchor),
    // not a free node resting on the ground via contact – that would fight the beam's fixed rest
    // length (a few cm of settling read back as a huge velocity over one physics substep) and
    // never come to rest. Validated bridges guarantee every foot here really does touch ground.
    const ground = level.ground || [];
    const feet = pillarFeet(bridge);
    for (let i = 0; i < feet.length; i++) {
      const fx = feet[i][0], fy = feet[i][1], k = key(fx, fy);
      if (map.has(k)) continue;
      const surf = Terrain.surfaceY(ground, fx);
      if (!(isFinite(surf) && Math.abs(fy - surf) <= 0.25)) continue;   // not actually touching → leave free
      const p = newParticle(fx, fy, 0, TUNING.NODE_RADIUS, K_NODE);
      p.anchor = true; p.w = 0;
      map.set(k, p);
      sim.particles.push(p); sim.joints.push(p);
    }
    // nodes of solid obstacles are fixed too (the obstacle itself is not simulated, see S.obstacles)
    const pre = prebuiltBeams(level);
    for (let i = 0; i < pre.length; i++) {
      if (!pre[i].o) continue;
      for (let e = 0; e < 2; e++) {
        const x = e ? pre[i].x2 : pre[i].x1, y = e ? pre[i].y2 : pre[i].y1, k = key(x, y);
        if (map.has(k)) continue;
        const p = newParticle(x, y, 0, TUNING.NODE_RADIUS, K_NODE);
        p.anchor = true; p.w = 0;
        map.set(k, p);
        sim.particles.push(p); sim.joints.push(p);
      }
      S.obstacles.push({ x1: pre[i].x1, y1: pre[i].y1, x2: pre[i].x2, y2: pre[i].y2 });
    }
    // getNode(x, y, g): g = 1 selects the split node of the grid point (anchors are shared)
    const getNode = (x, y, g) => {
      const k0 = key(x, y);
      const p0 = map.get(k0);
      if (p0 && p0.anchor) return p0;
      const k = g ? gkey(x, y, 1) : k0;
      let p = map.get(k);
      if (!p) {
        p = newParticle(x, y, 0, TUNING.NODE_RADIUS, K_NODE);
        p.on = true;
        map.set(k, p);
        sim.particles.push(p); sim.joints.push(p);
      }
      return p;
    };
    const seen = new Set();
    const beamsIn = [];
    for (let i = 0; i < pre.length; i++) if (!pre[i].o) beamsIn.push(Object.assign({ pre: true, srcIdx: -1 - i }, pre[i]));
    const nPre = beamsIn.length;
    const mine = (bridge && Array.isArray(bridge.beams)) ? bridge.beams : [];
    for (let i = 0; i < mine.length; i++) beamsIn.push(mine[i]);
    for (let i = 0; i < beamsIn.length; i++) {
      const bb = beamsIn[i];
      const mat = bb && MATERIALS[bb.m];
      if (!mat) continue;
      const x1 = +bb.x1, y1 = +bb.y1, x2 = +bb.x2, y2 = +bb.y2;
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!(len > 1e-6)) continue;
      const k1 = key(x1, y1), k2 = key(x2, y2);
      const pk = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
      if (seen.has(pk)) continue;      // duplicate beams are ignored by the simulation
      seen.add(pk);
      const a = getNode(x1, y1, bb.s1 ? 1 : 0), b = getNode(x2, y2, bb.s2 ? 1 : 0);
      const beam = makeBeam(a, b, mat, len, false);
      beam.src = i < nPre ? -1 - i : i - nPre;
      if (i < nPre) beam.pre = true;
      if (mat.hyd) {
        beam.restMax = len + Math.min(len * TUNING.HYD_STROKE, TUNING.HYD_STROKE_MAX);
        const ph = Array.isArray(bb.ph) ? bb.ph.slice(0, HYD_PHASES) : ['hold', 'out'];
        beam.ph = ph;
      }
      a.mass += mat.mass * len / 2; b.mass += mat.mass * len / 2;
      a.deg++; b.deg++;
      sim.beams.push(beam);
    }
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i];
      if (p.anchor) { p.w = 0; continue; }
      p.mass += TUNING.NODE_MIN_MASS;
      p.w = 1 / p.mass;
    }

    // ---- vehicles
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const v = buildVehicle(S, VEHICLES[e.key], i);
      v.route = Math.min(e.route, routes.length - 1);
      v.delay = e.delay;
      v.after = e.after;       // [vehicle index, station number] or null
      v.stIdx = 0;             // stations reached so far (the goal counts as the last one)
      v.waitFor = null;        // HUD: { v, n } while the vehicle waits for another one
      v.color = e.color || (routes.length > 1 ? routes[v.route].color : VEHICLES[e.key].color);
      sim.vehicles.push(v);
    }
    trySpawn(sim, S);      // the first vehicle of every route stands at its start from t = 0
    rebuildLists(sim, S);

    buildPistons(sim, S, level, getNode);
    buildGates(sim, S, level);
    buildCargo(sim, S, level);
    for (let i = 0; i < sim.vehicles.length; i++) {
      const v0 = sim.vehicles[i];
      if (v0.state !== 'waiting') placeCargo(S, v0);   // the first vehicles already spawned above
    }
    let numPhases = 1;
    for (let i = 0; i < S.pistons.length; i++) numPhases = Math.max(numPhases, S.pistons[i].phaseActions.length);
    for (let i = 0; i < sim.beams.length; i++) if (sim.beams[i].ph) numPhases = Math.max(numPhases, sim.beams[i].ph.length);
    const checkpoints = Array.isArray(level.checkpoints) ? level.checkpoints : [];
    for (let i = 0; i < checkpoints.length; i++) {
      const ph = checkpoints[i] && checkpoints[i].phase;
      if (typeof ph === 'number' && isFinite(ph)) numPhases = Math.max(numPhases, Math.floor(ph) + 1);
    }
    S.numPhases = numPhases;
    S.checkpointHit = new Set();
    for (let i = 0; i < S.gates.length; i++) numPhases = Math.max(numPhases, Math.max(S.gates[i].openPhase === null ? 0 : S.gates[i].openPhase, S.gates[i].closePhase === null ? 0 : S.gates[i].closePhase) + 1);
    S.numPhases = numPhases;
    if (S.gates.length) S.timeout = Math.max(S.timeout, S.gates.reduce((m, g) => Math.max(m, g.t + g.dur), 0) + 30 + 10 * entries.length);
    sim.gates = S.gates;
    updateGates(sim, S);
    return sim;
  }

  // ------------------------------------------------------------- hydraulics (pistons)
  // level.pistons: [{ id, pivotX, pivotY, angleDeg, minLen, maxLen, startLen, speed, phaseActions }]
  // phaseActions[i] is 'out' | 'in' | 'hold' for phase i. The pivot and the piston's starting head
  // position both become fixed (anchor-like) nodes the player can attach beams to while building;
  // during the test drive the head is then moved along (pivot → head) by the active phase's action.
  function buildPistons(sim, S, level, getNode) {
    const defs = Array.isArray(level.pistons) ? level.pistons : [];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      if (!d || !isFinite(d.pivotX) || !isFinite(d.pivotY)) continue;
      const rad = (+d.angleDeg || 0) * Math.PI / 180;
      const dirX = Math.cos(rad), dirY = Math.sin(rad);
      const minLen = Math.max(0, +d.minLen || 0), maxLen = Math.max(minLen, +d.maxLen || minLen);
      let len = isFinite(d.startLen) ? Math.max(minLen, Math.min(maxLen, +d.startLen)) : minLen;
      const pivot = getNode(+d.pivotX, +d.pivotY);
      pivot.anchor = true; pivot.w = 0;
      const hx = +d.pivotX + dirX * len, hy = +d.pivotY + dirY * len;
      const head = getNode(Math.round(hx * 1e6) / 1e6, Math.round(hy * 1e6) / 1e6);
      head.anchor = true; head.w = 0;
      head.x = head.px = head.ox = hx; head.y = head.py = head.oy = hy;
      S.pistons.push({
        id: d.id, pivot, head, dirX, dirY, minLen, maxLen, len,
        speed: Math.max(0.05, +d.speed || 0.6),
        phaseActions: Array.isArray(d.phaseActions) ? d.phaseActions : [],
      });
    }
  }

  function updatePistons(S, h) {
    const ps = S.pistons;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const action = p.phaseActions[S.phase] || 'hold';
      const delta = p.speed * h;
      if (action === 'out') p.len = Math.min(p.maxLen, p.len + delta);
      else if (action === 'in') p.len = Math.max(p.minLen, p.len - delta);
      const nx = p.pivot.x + p.dirX * p.len, ny = p.pivot.y + p.dirY * p.len;
      const head = p.head;
      head.vx = (nx - head.x) / h; head.vy = (ny - head.y) / h;
      head.x = head.px = head.ox = nx; head.y = head.py = head.oy = ny;
    }
  }

  function updateHydraulics(S, h) {
    const hs = S.hyds;
    for (let i = 0; i < hs.length; i++) {
      const b = hs[i];
      const action = b.ph[S.phase] || 'hold';
      const target = action === 'out' ? TUNING.HYD_SPEED : action === 'in' ? -TUNING.HYD_SPEED : 0;
      // smooth start / stop (limited acceleration): no jerk through the whole structure
      const dv = TUNING.HYD_ACCEL * h;
      b.hv += target > b.hv ? Math.min(dv, target - b.hv) : -Math.min(dv, b.hv - target);
      if (b.hv === 0) continue;
      let r = b.rest + b.hv * h;
      if (r >= b.restMax) { r = b.restMax; b.hv = 0; } else if (r <= b.restMin) { r = b.restMin; b.hv = 0; }
      b.rest = r;
      b.at = beamCompliance(b.mat, r);
    }
  }

  /** Advances to the next hydraulics phase (wraps if level.phaseLoop, else stays on the last). */
  function nextPhase(sim) {
    const S = sim._s;
    if (!S || S.numPhases <= 1) return S ? S.phase : 0;
    const loop = !!(sim.level && sim.level.phaseLoop);
    S.phase = (S.phase + 1 >= S.numPhases) ? (loop ? 0 : S.numPhases - 1) : S.phase + 1;
    return S.phase;
  }
  function setPhase(sim, n) {
    const S = sim._s;
    if (!S) return 0;
    S.phase = Math.max(0, Math.min(S.numPhases - 1, Math.floor(n) || 0));
    return S.phase;
  }

  // ------------------------------------------------------------- gates (Durchfahrts-Tore)
  // level.gates: [{ kind: 'ship' | 'truck' | 'train', x0, x1, y0, y1, t, v, len, lead, openPhase, closePhase, hold, stopX, label }]
  // A gate is a rectangle [x0, x1] × [y0, y1] IN THE BRIDGE PLANE. A ship (river), truck (motorway) or train (railway)
  // travels along the channel, i.e. perpendicular to the bridge axis (in the 3D view: through the picture, towards the
  // viewer), and is inside the bridge plane from time t to t + dur (dur = (len + plane thickness) / v). While it is, no part
  // of the bridge (beam, piston, vehicle, crate) may reach into the rectangle – otherwise it stops in front of the bridge,
  // sounds its horn and the level is lost. `lead` seconds before it arrives the ship comes into view; at that moment the
  // hydraulics jump to `openPhase`, when it has passed to `closePhase`. With `hold` the road vehicles wait in front of the
  // stop line `stopX` until the gate is done AND the hydraulics are at rest again (the bridge must be closed to drive on it).
  const GATE_HALF = 1.35;             // half thickness of the bridge plane (z)
  const GATE_KINDS = {
    ship: { v: 5, len: 8, lead: 6 },
    truck: { v: 9, len: 10, lead: 4 },
    train: { v: 13, len: 26, lead: 5 },
  };
  function gateDefaultStop(level) {
    if (level && level.build && isFinite(level.build.minX)) return level.build.minX + 2;
    return (level && isFinite(level.startX) ? level.startX : -10) + 8;
  }
  function gatesOf(level) {
    const out = [];
    if (!level) return out;
    if (Array.isArray(level.gates)) {
      for (let i = 0; i < level.gates.length; i++) { const g = normGate(level.gates[i], level); if (g) out.push(g); }
      return out;
    }
    // legacy sideways ships (v3.0 / v3.1 levels and saved custom levels) become one gate each
    if (Array.isArray(level.ships)) {
      for (let i = 0; i < level.ships.length; i++) {
        const d = level.ships[i];
        if (!d || !isFinite(d.x0) || !isFinite(d.x1) || !isFinite(d.y0) || !isFinite(d.y1)) continue;
        const hw = Math.max(0.2, +d.halfWidth || 1.5), sp = Math.max(0.1, +d.speed || 2);
        const span = Math.abs(d.x1 - d.x0), dur = Math.max(0.8, span / sp);
        const g = normGate({
          kind: 'ship', x0: Math.min(d.x0, d.x1) - hw, x1: Math.max(d.x0, d.x1) + hw, y0: Math.min(d.y0, d.y1), y1: Math.max(d.y0, d.y1),
          t: d.once ? Math.max(0, +d.delay || 0) : 3 + i * 2, v: 5, len: Math.max(0.5, dur * 5 - 2 * GATE_HALF),
        }, level);
        if (g) out.push(g);
      }
    }
    return out;
  }
  function normGate(d, level) {
    if (!d || !isFinite(d.x0) || !isFinite(d.x1) || !isFinite(d.y0) || !isFinite(d.y1)) return null;
    const kind = GATE_KINDS[d.kind] ? d.kind : 'ship', def = GATE_KINDS[kind];
    const v = d.v > 0 ? +d.v : def.v, len = d.len > 0 ? +d.len : def.len;
    const openPhase = Number.isInteger(d.openPhase) && d.openPhase >= 0 ? d.openPhase : null;
    const closePhase = Number.isInteger(d.closePhase) && d.closePhase >= 0 ? d.closePhase : null;
    const g = {
      kind: kind, x0: Math.min(d.x0, d.x1), x1: Math.max(d.x0, d.x1), y0: Math.min(d.y0, d.y1), y1: Math.max(d.y0, d.y1),
      t: isFinite(d.t) ? Math.max(0, +d.t) : 6, v: v, len: len, lead: isFinite(d.lead) ? Math.max(0, +d.lead) : def.lead,
      openPhase: openPhase, closePhase: closePhase,
      hold: d.hold === undefined ? openPhase !== null : !!d.hold,
      stopX: isFinite(d.stopX) ? +d.stopX : gateDefaultStop(level),
      label: typeof d.label === 'string' ? d.label : null,
      vessel: typeof d.vessel === 'string' ? d.vessel : null,
      color: typeof d.color === 'string' ? d.color : null,
    };
    g.dur = (len + 2 * GATE_HALF) / v;
    g.zStart = -(len / 2 + GATE_HALF) - v * g.lead;      // centre z of the vessel at the start of its approach
    return g;
  }
  /** Centre z of the vessel at time t (0 = bridge plane, + = towards the viewer). */
  function gateZ(g, t) { return g.zStart + g.v * (t - (g.t - g.lead)); }

  function buildGates(sim, S, level) {
    const defs = gatesOf(level);
    for (let i = 0; i < defs.length; i++) {
      const g = Object.assign({}, defs[i]);
      g.state = 'idle'; g.openDone = false; g.closeDone = false; g.failAt = 0; g.zc = gateZ(g, 0); g.index = i;
      S.gates.push(g);
      if (g.hold) S.holds.push({ gate: i, x: g.stopX });
    }
    const hs = Array.isArray(level.holds) ? level.holds : [];
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h && isFinite(h.x) && Number.isInteger(h.cp)) S.holds.push({ cp: h.cp, x: +h.x, v: Number.isInteger(h.v) ? h.v : null });
    }
  }

  /** True while any hydraulic beam or piston is still travelling towards its target length of the current phase. */
  function hydraulicsMoving(S) {
    for (let i = 0; i < S.hyds.length; i++) {
      const b = S.hyds[i];
      if (b.hv !== 0) return true;
      const a = b.ph[S.phase] || 'hold';
      if (a === 'out' && b.rest < b.restMax - 1e-3) return true;
      if (a === 'in' && b.rest > b.restMin + 1e-3) return true;
    }
    for (let i = 0; i < S.pistons.length; i++) {
      const p = S.pistons[i], a = p.phaseActions[S.phase] || 'hold';
      if (a === 'out' && p.len < p.maxLen - 1e-3) return true;
      if (a === 'in' && p.len > p.minLen + 1e-3) return true;
    }
    return false;
  }

  function gateBlocked(g, S) {
    const pad = 0.04, rx0 = g.x0 - pad, rx1 = g.x1 + pad, ry0 = g.y0 - pad, ry1 = g.y1 + pad;
    const intact = S.intact;
    for (let i = 0; i < intact.length; i++) {
      const b = intact[i], a = b.a, e = b.b;
      if (Math.max(a.x, e.x) < rx0 || Math.min(a.x, e.x) > rx1) continue;
      if (segHitsRect(a.x, a.y, e.x, e.y, rx0, rx1, ry0, ry1)) return true;
    }
    for (let i = 0; i < S.pistons.length; i++) {
      const p = S.pistons[i];
      if (segHitsRect(p.pivot.x, p.pivot.y, p.head.x, p.head.y, rx0, rx1, ry0, ry1)) return true;
    }
    const lv = S.liveVehicles;
    for (let i = 0; i < lv.length; i++) {
      const v = lv[i];
      for (let k = 0; k < 4; k++) { const q = v.body[k]; if (q.x >= rx0 && q.x <= rx1 && q.y >= ry0 && q.y <= ry1) return true; }
    }
    for (let i = 0; i < S.cargo.length; i++) { const q = S.cargo[i].p; if (q.x >= rx0 && q.x <= rx1 && q.y >= ry0 && q.y <= ry1) return true; }
    return false;
  }

  /** Advances the gates (called once per frame after the time step); returns true when a vessel was blocked for long enough. */
  function updateGates(sim, S) {
    const t = sim.t;
    let lost = false;
    for (let i = 0; i < S.gates.length; i++) {
      const g = S.gates[i];
      if (!g.openDone && t >= g.t - g.lead) {
        g.openDone = true;
        if (g.openPhase !== null) setPhase(sim, g.openPhase);
        sim.events.push({ type: 'gate-approach', index: i });
      }
      if (g.state === 'blocked') { if (t >= g.failAt) lost = true; continue; }
      const t1 = g.t + g.dur;
      if (t >= g.t && t <= t1) {
        g.state = 'passing';
        if (gateBlocked(g, S)) { g.state = 'blocked'; g.failAt = t + 1.6; g.zc = gateZ(g, t); sim.events.push({ type: 'horn', index: i }); continue; }
      } else if (t > t1 && g.state !== 'done') {
        g.state = 'done';
        if (!g.closeDone) { g.closeDone = true; if (g.closePhase !== null) setPhase(sim, g.closePhase); }
      }
      g.zc = gateZ(g, t);
    }
    // stop lines
    let active = false;
    if (S.holds.length) {
      const moving = hydraulicsMoving(S);
      for (let i = 0; i < S.holds.length; i++) {
        const h = S.holds[i];
        if (h.gate !== undefined) h.active = S.gates[h.gate].state !== 'done' || moving;
        else h.active = !(S.checkpointHit && S.checkpointHit.has(h.cp) && !moving);
        if (h.active) active = true;
      }
    }
    S.holdActive = active;
    return lost;
  }

  /** Liang–Barsky segment-vs-AABB test. */
  function segHitsRect(ax, ay, bx, by, rx0, rx1, ry0, ry1) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (!clip(-dx, ax - rx0)) return false;
    if (!clip(dx, rx1 - ax)) return false;
    if (!clip(-dy, ay - ry0)) return false;
    if (!clip(dy, ry1 - ay)) return false;
    return t0 <= t1;
  }

  // ------------------------------------------------------------- cargo (crates)
  // level.cargo: [{ vehicleIndex, count }] – spawns `count` crates on the flatbed (between the top
  // chassis corners TR/TF) of level.vehicles[vehicleIndex]. A crate rests on that synthetic "bed"
  // segment via the same one-sided contact + friction as everything else; if the ride is too rough
  // or steep it slides off the bed's ends exactly like any object sliding off a tilted surface, and
  // then free-falls – lost for the "Alle Kisten heil ins Ziel" bonus objective, never for the level.
  function buildCargo(sim, S, level) {
    const defs = Array.isArray(level.cargo) ? level.cargo : [];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const v = sim.vehicles[d && d.vehicleIndex];
      if (!v) continue;
      const count = Math.max(1, Math.min(6, Math.floor(d.count) || 1));
      for (let k = 0; k < count; k++) {
        const u = count === 1 ? 0.5 : 0.18 + (0.64 * k) / (count - 1);
        const p = newParticle(0, 0, TUNING.CARGO_MASS, TUNING.CARGO_RADIUS, K_BODY);
        p.on = false;
        sim.particles.push(p);
        S.cargo.push({ p, vehicle: v, u, lost: false, bed: { a: v.body[3], b: v.body[2] } });
      }
    }
  }

  function placeCargo(S, v) {
    for (let i = 0; i < S.cargo.length; i++) {
      const c = S.cargo[i];
      if (c.vehicle !== v) continue;
      const TR = v.body[3], TF = v.body[2];
      const x = TR.x + (TF.x - TR.x) * c.u, y = TR.y + (TF.y - TR.y) * c.u + TUNING.CARGO_RADIUS;
      c.p.x = c.p.px = c.p.ox = x; c.p.y = c.p.py = c.p.oy = y; c.p.vx = c.p.vy = 0;
      c.p.on = true;
      S.dirty = true;
    }
  }

  // ------------------------------------------------------------- vehicles
  function buildVehicle(S, def, index) {
    const L = def.length, Hh = def.height, r = def.wheelRadius, M = def.mass;
    const nA = def.axles.length;
    const mWheel = M * TUNING.WHEEL_MASS_FRAC / nA;
    const Ms = M - mWheel * nA;                       // sprung mass
    // Chassis: BR, BF (bottom, carry most mass → low centre of gravity), TF, TR (top)
    const masses = [0.4 * Ms, 0.4 * Ms, 0.1 * Ms, 0.1 * Ms];
    const local = [[-L / 2, 0], [L / 2, 0], [L / 2, Hh], [-L / 2, Hh]];
    const body = [];
    for (let i = 0; i < 4; i++) body.push(newParticle(0, 0, masses[i], TUNING.BODY_RADIUS, K_BODY));
    const rigid = [];
    const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]];
    for (let i = 0; i < pairs.length; i++) {
      const a = local[pairs[i][0]], b = local[pairs[i][1]];
      rigid.push({ a: body[pairs[i][0]], b: body[pairs[i][1]], rest: Math.hypot(b[0] - a[0], b[1] - a[1]) });
    }
    // Static wheel loads of a rigid body on equal springs (solves 3-axle trucks too).
    const omega = 2 * Math.PI * TUNING.SUSP_FREQ;
    const kv = (Ms / nA) * omega * omega;           // vertical stiffness per wheel
    let sa = 0, saa = 0;
    for (let i = 0; i < nA; i++) { sa += def.axles[i]; saa += def.axles[i] * def.axles[i]; }
    // centre of gravity of the sprung mass is at x = 0 → Σ(d0 + θ a) = W/k, Σ(d0 + θ a)a = 0
    const W = Ms * G;
    let d0, th;
    if (nA === 1) { d0 = W / kv; th = 0; }
    else {
      const det = nA * saa - sa * sa;
      d0 = (W / kv) * saa / det; th = -(W / kv) * sa / det;
    }
    const wheels = [], susp = [];
    for (let i = 0; i < nA; i++) {
      const ax = def.axles[i];
      const p = newParticle(0, 0, mWheel, r, K_WHEEL);
      const sag = Math.max(0.01, d0 + th * ax);
      const yT = -sag;                               // spring target point below the body bottom
      const u = (ax + L / 2) / L, v = yT / Hh;
      const c = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];   // bilinear weights BR, BF, TF, TR
      let wEff = p.w;
      for (let j = 0; j < 4; j++) wEff += c[j] * c[j] * body[j].w;
      const load = kv * sag;
      const mShare = load / G;
      // tyre: compliant, damped wheel contact; equal static deflection on every axle
      const kt = (load + mWheel * G) / TUNING.TYRE_DEFL;
      p.tc = 1 / (kt * H2);
      p.td = 2 * TUNING.TYRE_ZETA * Math.sqrt(kt * mWheel);
      const kh = kv * TUNING.SUSP_HSTIFF;
      const cv = 2 * TUNING.SUSP_ZETA * Math.sqrt(kv * mShare);
      const ch = 2 * 0.7 * Math.sqrt(kh * mShare);
      susp.push({
        p: p, c: c, wEff: wEff, sag: sag,
        atx: 1 / (kh * H2), aty: 1 / (kv * H2),
        limit: sag + TUNING.SUSP_TRAVEL * r,
        fdx: 1 - Math.exp(-ch * wEff * H), fdy: 1 - Math.exp(-cv * wEff * H),
        dmax: cv * TUNING.SUSP_KNEE * H,             // max damper impulse per substep
        atb: 1 / (TUNING.SUSP_BUMP * kv * H2),       // bump-stop compliance
        hard: sag + TUNING.SUSP_TRAVEL * r * 1.6,    // rigid end of travel
      });
      wheels.push({ p: p, r: r, angle: 0, omega: 0, ax: ax });
    }
    // Deck contact of the bottom chassis corners: the contact point is raised along the body's
    // up axis so that the overhangs have the approach / departure angle BODY_APPROACH (chamfered
    // bumpers). Otherwise long overhangs (bus 2.3 / 2.5 m at wheel-centre height) ram slope changes
    // of the deck (1:4 ramps, dips) with the whole vehicle mass in one substep.
    const tanA = Math.tan(TUNING.BODY_APPROACH * Math.PI / 180);
    const hc = r - TUNING.TYRE_DEFL - TUNING.BODY_RADIUS;    // corner circle bottom above the tyre contact
    let axMin = Infinity, axMax = -Infinity;
    for (let i = 0; i < nA; i++) { axMin = Math.min(axMin, def.axles[i]); axMax = Math.max(axMax, def.axles[i]); }
    const lift = [Math.max(0, (L / 2 + axMin) * tanA - hc), Math.max(0, (L / 2 - axMax) * tanA - hc)];
    return {
      type: def.key, def: def, state: 'waiting', visible: false,
      pose: { x: S.startX - L / 2, y: 0, angle: 0 },
      wheels: wheels, body: body,
      // ---- internal ----
      index: index, local: local, rigid: rigid, susp: susp, mass: M, lift: lift,
      kink: new Float64Array(80),       // road profile samples of the driver's look-ahead
      drive: 0, speed: 0, removed: false, bestX: -Infinity, progT: 0,
      route: 0, delay: 0, color: def.color, finT: 0, stillT: 0,
    };
  }

  function placeVehicle(S, v, frontX) {
    const def = v.def, L = def.length;
    const cx = frontX - L / 2;
    const gy = surfaceAt(S.T, cx);
    const by = gy + def.wheelRadius - TUNING.TYRE_DEFL;   // body bottom = wheel centre height
    for (let i = 0; i < 4; i++) {
      const p = v.body[i];
      p.x = p.px = p.ox = cx + v.local[i][0];
      p.y = p.py = p.oy = by + v.local[i][1];
      p.vx = p.vy = 0;
    }
    for (let i = 0; i < v.wheels.length; i++) {
      const p = v.wheels[i].p;
      p.x = p.px = p.ox = cx + v.wheels[i].ax;
      p.y = p.py = p.oy = surfaceAt(S.T, p.x) + def.wheelRadius - TUNING.TYRE_DEFL;
      p.vx = p.vy = 0;
    }
    updatePose(v);
  }

  function surfaceAt(T, x) {
    if (T.n < 2) return 0;
    const lo = segFirst(T, x), hi = segLast(T, x);
    let best = -Infinity;
    for (let i = lo; i <= hi; i++) {
      const ax = T.gx[i], bx = T.gx[i + 1];
      if (x < ax || x > bx) continue;
      const sy = bx > ax ? T.gy[i] + (T.gy[i + 1] - T.gy[i]) * (x - ax) / (bx - ax) : Math.max(T.gy[i], T.gy[i + 1]);
      if (sy > best) best = sy;
    }
    return best === -Infinity ? (x < T.gx[0] ? T.gy[0] : T.gy[T.n - 1]) : best;
  }

  /** height of the ground contact of the FRONT wheel (the station is passed by the front of the vehicle; long vehicles on a slope have other wheels lower / higher) */
  function vehicleBottom(v) {
    let bx = -Infinity, y = null;
    for (let i = 0; i < v.wheels.length; i++) { const w = v.wheels[i]; if (w.p.x > bx) { bx = w.p.x; y = w.p.y - (w.r || 0.4); } }
    return y === null ? v.pose.y : y;
  }
  const STATION_TOL = 1.6;       // m: a flag counts when the vehicle drives past it at most this far above / below its base
  /** the vehicle is at its next station (front has reached it) at the right height → advances the progress; false = wrong height */
  function stationReached(sim, S, v) {
    const st = S.routes[v.route].stations[v.stIdx];
    if (Math.abs(vehicleBottom(v) - st.y) <= STATION_TOL) { v.stIdx++; sim.events.push({ type: 'station', index: v.index, n: st.n, x: st.x, y: st.y }); return true; }
    return false;
  }

  function spawnVehicle(sim, S, v) {
    const R = S.routes[v.route];
    placeVehicle(S, v, R.startX);
    v.state = 'driving'; v.visible = true;
    v.bestX = R.startX; v.progT = Math.max(sim.t, TUNING.DRIVE_START);
    for (let i = 0; i < 4; i++) { v.body[i].on = true; sim.particles.push(v.body[i]); }
    for (let i = 0; i < v.wheels.length; i++) { v.wheels[i].p.on = true; sim.particles.push(v.wheels[i].p); }
    placeCargo(S, v);
    R.last = v;
    S.dirty = true;
  }

  // Per route the vehicles leave in level order, each one when the previous one is clear of the start.
  function trySpawn(sim, S) {
    for (let r = 0; r < S.routes.length; r++) {
      const R = S.routes[r];
      let nv = null;
      for (let i = 0; i < sim.vehicles.length; i++) {
        const v = sim.vehicles[i];
        if (v.route === r && v.state === 'waiting') { nv = v; break; }
      }
      if (!nv || nv.delay > sim.t + 1e-9) continue;
      nv.waitFor = null;
      if (nv.after) {                                  // waits until another vehicle has reached the given station
        const dv = sim.vehicles[nv.after[0]];
        if (dv && dv !== nv && !(dv.stIdx >= nv.after[1])) { nv.waitFor = { v: nv.after[0], n: nv.after[1] }; continue; }
      }
      const prev = R.last;
      const rear = prev ? Math.min(prev.body[0].x, prev.body[3].x) : Infinity;
      if (!prev || prev.removed || rear >= R.startX + TUNING.SPAWN_GAP) spawnVehicle(sim, S, nv);
    }
  }

  function updatePose(v) {
    const a = v.body[0], b = v.body[1];
    v.pose.x = (a.x + b.x) / 2;
    v.pose.y = (a.y + b.y) / 2;
    v.pose.angle = Math.atan2(b.y - a.y, b.x - a.x);
  }

  function rebuildLists(sim, S) {
    S.active.length = 0; S.nodes.length = 0;
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i];
      if (!p.on || p.w === 0) continue;
      S.active.push(p);
      if (p.kind === K_NODE) S.nodes.push(p);
    }
    S.live.length = 0; S.intact.length = 0; S.drivable.length = 0; S.hyds.length = 0;
    for (let i = 0; i < sim.beams.length; i++) {
      const b = sim.beams[i];
      if (b.broken) continue;
      S.live.push(b);
      if (!b.debris) {
        S.intact.push(b);
        if (b.mat.drivable) S.drivable.push(b);
        if (b.hyd) S.hyds.push(b);
      }
    }
    // fillet partners: at each end the most collinear other drivable beam (mutual choice only)
    const dr = S.drivable;
    for (let i = 0; i < dr.length; i++) {
      const b = dr[i];
      b.pa = filletPartner(b, b.a, b.b, dr);
      b.pb = filletPartner(b, b.b, b.a, dr);
    }
    for (let i = 0; i < dr.length; i++) {
      const b = dr[i];
      if (b.pa !== null && (b.pa.a === b.a ? b.pa.pa : b.pa.pb) !== b) b.pa = null;
      if (b.pb !== null && (b.pb.a === b.b ? b.pb.pa : b.pb.pb) !== b) b.pb = null;
    }
    S.liveVehicles.length = 0;
    for (let i = 0; i < sim.vehicles.length; i++) {
      const v = sim.vehicles[i];
      if (v.state !== 'waiting' && !v.removed) S.liveVehicles.push(v);
    }
    S.dirty = false;
  }

  function filletPartner(bm, J, K, dr) {
    let ax = K.x - J.x, ay = K.y - J.y;
    const la = Math.sqrt(ax * ax + ay * ay) || 1; ax /= la; ay /= la;
    let best = null, bestCos = FILLET_COS_MAX;
    for (let i = 0; i < dr.length; i++) {
      const c = dr[i];
      if (c === bm || (c.a !== J && c.b !== J)) continue;
      const O = c.a === J ? c.b : c.a;
      if (O === K) continue;
      const bx = O.x - J.x, by = O.y - J.y, lb = Math.sqrt(bx * bx + by * by) || 1;
      const cs = -(ax * bx + ay * by) / lb;
      if (cs > bestCos) { bestCos = cs; best = c; }
    }
    return best;
  }

  // ======================================================== per-frame prep
  function prepareFrame(sim, S) {
    const T = S.T, act = S.active;
    for (let i = 0; i < act.length; i++) { const p = act[i]; p.px = p.x; p.py = p.y; }
    // terrain candidate segment ranges
    for (let i = 0; i < act.length; i++) {
      const p = act[i];
      if (T.n < 2) { p.tlo = 0; p.thi = -1; p.tnear = false; continue; }
      const m = p.r + 0.3 + (p.kind === K_BODY ? 1.5 : 0) + (Math.abs(p.vx) + Math.abs(p.vy)) * FRAME_DT * 1.5;
      const lo = segFirst(T, p.x - m), hi = segLast(T, p.x + m);
      p.tlo = lo; p.thi = hi;
      let near = false;
      if (hi >= lo) {
        if (p.kind !== K_NODE) near = true;
        else {
          let top = -Infinity;
          for (let k = lo; k <= hi; k++) { const y = T.gy[k] > T.gy[k + 1] ? T.gy[k] : T.gy[k + 1]; if (y > top) top = y; }
          near = p.y - m < top;
        }
      }
      p.tnear = near;
    }
    // drivable beam candidates for vehicle particles
    const dr = S.drivable;
    for (let vi = 0; vi < S.liveVehicles.length; vi++) {
      const v = S.liveVehicles[vi];
      for (let j = 0; j < 4 + v.wheels.length; j++) {
        const p = j < 4 ? v.body[j] : v.wheels[j - 4].p;
        if (!p.cand) p.cand = [];
        const c = p.cand; c.length = 0;
        const m = p.r + 0.35 + (j < 2 ? v.lift[j] : 0) + (Math.abs(p.vx) + Math.abs(p.vy)) * FRAME_DT * 1.5;
        const x0 = p.x - m, x1 = p.x + m, y0 = p.y - m, y1 = p.y + m;
        for (let k = 0; k < dr.length; k++) {
          const b = dr[k], a = b.a, e = b.b;
          if ((a.x < x0 && e.x < x0) || (a.x > x1 && e.x > x1) || (a.y < y0 && e.y < y0) || (a.y > y1 && e.y > y1)) continue;
          c.push(b);
        }
      }
      controlVehicle(sim, S, v);
    }
    // crate candidates: real drivable beams (in case it slid off onto the road) + its own vehicle's
    // flatbed "beam" (the TR–TF chassis edge) – see buildCargo().
    const cargo = S.cargo;
    for (let i = 0; i < cargo.length; i++) {
      const c = cargo[i], p = c.p;
      if (!p.on) continue;
      if (!p.cand) p.cand = [];
      const cl = p.cand; cl.length = 0;
      const m = p.r + 0.35 + (Math.abs(p.vx) + Math.abs(p.vy)) * FRAME_DT * 1.5;
      const x0 = p.x - m, x1 = p.x + m, y0 = p.y - m, y1 = p.y + m;
      for (let k = 0; k < dr.length; k++) {
        const b = dr[k], a = b.a, e = b.b;
        if ((a.x < x0 && e.x < x0) || (a.x > x1 && e.x > x1) || (a.y < y0 && e.y < y0) || (a.y > y1 && e.y > y1)) continue;
        cl.push(b);
      }
      cl.push(c.bed);
    }
  }

  // Driver: slows down before sharp slope changes of the road (dips, crests, ramps) so that the
  // vertical velocity change v·Δθ stays ≤ KINK_DV. Scans the surface profile (terrain and intact
  // drivable beams) from just behind the rear wheel to KINK_LOOK m ahead of the front wheel.
  function kinkSpeedLimit(S, v) {
    const wr = v.wheels[0].p, wf = v.wheels[v.wheels.length - 1].p, r = v.wheels[0].r;
    const buf = v.kink, x0 = wr.x - 2 * KINK_DS;
    const n = Math.min(buf.length, Math.ceil((wf.x - x0 + TUNING.KINK_LOOK) / KINK_DS) + 1);
    let y = surfaceNear(S, x0, wr.y - r, 0.6, 0.6);
    if (y !== y) return Infinity;
    buf[0] = y;
    let m = 1;
    for (; m < n; m++) {
      y = surfaceNear(S, x0 + m * KINK_DS, y, 0.6, 0.6);   // ≤ 50° slopes; cliffs end the scan
      if (y !== y) break;
      buf[m] = y;
    }
    let vmax = Infinity;
    for (let k = 2; k + 1 < m; k++) {
      // slope change across chord k (chord k = samples k-1 → k)
      const d = Math.abs(Math.atan2(buf[k + 1] - buf[k], KINK_DS) - Math.atan2(buf[k - 1] - buf[k - 2], KINK_DS));
      if (d < 0.05) continue;
      const vs = Math.max(TUNING.KINK_VMIN, TUNING.KINK_DV / d);
      let dist = x0 + (k - 0.5) * KINK_DS - wf.x - 1;
      if (dist < 0) dist = 0;
      const va = Math.sqrt(vs * vs + 2 * TUNING.KINK_DECEL * dist);
      if (va < vmax) vmax = va;
    }
    return vmax;
  }

  // Highest road surface (terrain or intact drivable beam) at x within [yRef - below, yRef + above].
  function surfaceNear(S, x, yRef, below, above) {
    const lo = yRef - below, hi = yRef + above, T = S.T;
    let best = NaN;
    if (T.n >= 2) {
      const i1 = segLast(T, x);
      for (let i = segFirst(T, x); i <= i1; i++) {
        const ax = T.gx[i], bx = T.gx[i + 1];
        if (!(bx > ax) || x < ax || x > bx) continue;
        const y = T.gy[i] + (T.gy[i + 1] - T.gy[i]) * (x - ax) / (bx - ax);
        if (y >= lo && y <= hi && !(y <= best)) best = y;
      }
    }
    const dr = S.drivable;
    for (let k = 0; k < dr.length; k++) {
      const a = dr[k].a, b = dr[k].b;
      const L = a.x < b.x ? a : b, R = a.x < b.x ? b : a;
      if (x < L.x || x > R.x || R.x - L.x < 1e-6) continue;
      const y = L.y + (R.y - L.y) * (x - L.x) / (R.x - L.x);
      if (y >= lo && y <= hi && !(y <= best)) best = y;
    }
    return best;
  }

  // Cruise control with adaptive following distance. Sets v.drive (N, + = forward).
  function controlVehicle(sim, S, v) {
    v.drive = 0;
    if (v.state !== 'driving' && v.state !== 'finished') return;
    const b = v.body;
    let mvx = 0, mvy = 0, ms = 0;
    for (let i = 0; i < 4; i++) { mvx += b[i].vx * b[i].mass; mvy += b[i].vy * b[i].mass; ms += b[i].mass; }
    mvx /= ms; mvy /= ms;
    let ex = b[1].x - b[0].x, ey = b[1].y - b[0].y;
    const l = Math.hypot(ex, ey) || 1; ex /= l; ey /= l;
    const vf = mvx * ex + mvy * ey;
    v.speed = vf;
    if (sim.t < TUNING.DRIVE_START) return;
    if (ex < 0.2) return;            // badly tilted / upside down: wheels spin freely
    let target = v.def.speed;
    // adaptive cruise: follow the nearest spawned vehicle ahead (earlier in the queue)
    for (let i = v.index - 1; i >= 0; i--) {
      const o = sim.vehicles[i];
      if (o.removed || o.state === 'waiting' || o.route !== v.route) continue;
      const ob = o.body;
      const oRear = Math.min(ob[0].x, ob[3].x);
      const front = Math.max(b[1].x, b[2].x);
      const gap = oRear - front;
      let ov = 0, om = 0;
      for (let k = 0; k < 4; k++) { ov += ob[k].vx * ob[k].mass; om += ob[k].mass; }
      ov /= om;
      let t2 = ov + 0.8 * (gap - TUNING.FOLLOW_GAP);
      if (gap < TUNING.MIN_GAP) t2 = 0;
      if (t2 < 0) t2 = 0;
      if (t2 < target) target = t2;
      break;
    }
    // stop lines (traffic light of a gate while the bridge is open, lift platform): brake to a halt in front of the line
    if (S.holdActive) {
      const front0 = Math.max(b[1].x, b[2].x);
      for (let hi = 0; hi < S.holds.length; hi++) {
        const h = S.holds[hi];
        if (!h.active || (h.v !== null && h.v !== undefined && h.v !== v.index)) continue;
        const dist = h.x - front0;
        if (dist < -0.5 || dist > 45) continue;
        const vs = Math.sqrt(2 * 2.0 * Math.max(0, dist - 2.2));
        if (vs < target) target = vs;
      }
    }
    const vk = kinkSpeedLimit(S, v);
    if (vk < target) target = vk;
    // stronger speed hold near standstill (a stopped vehicle must not creep down a sagging deck)
    const kp = target < 0.5 ? TUNING.CRUISE_KP + TUNING.HOLD_KP * (1 - 2 * target) : TUNING.CRUISE_KP;
    let a = kp * (target - vf);
    if (a > TUNING.ACCEL_MAX) a = TUNING.ACCEL_MAX;
    if (a < -TUNING.BRAKE_ACCEL) a = -TUNING.BRAKE_ACCEL;
    let F = v.mass * (a + G * ey + TUNING.GLOBAL_DAMP * vf);   // feed-forward: slope + damping losses
    const fMax = v.mass * TUNING.DRIVE_MAX, fMin = -v.mass * TUNING.BRAKE_MAX;
    if (F > fMax) F = fMax; else if (F < fMin) F = fMin;
    v.drive = F;
  }

  // ============================================================== substep
  function substep(sim, S, gBridge) {
    const act = S.active, n = act.length;
    const water = S.water, hasWater = water !== null;
    const buoy = 1 - TUNING.WATER_BUOYANCY;

    if (S.pistons.length) updatePistons(S, H);
    if (S.hyds.length) updateHydraulics(S, H);

    // 1) predict
    const wind = S.wind;
    for (let i = 0; i < n; i++) {
      const p = act[i];
      p.ox = p.x; p.oy = p.y;
      let g = p.kind === K_NODE ? gBridge : G;
      if (hasWater && p.y < water) g *= buoy;
      p.vy -= g * H;
      if (wind !== 0) p.vx += wind * H;
      p.x += p.vx * H; p.y += p.vy * H;
      p.clam = 0; p.cbest = 0; p.cbeam = null;
      if (hasWater && p.oy >= water && p.y < water && p.vy < -TUNING.SPLASH_SPEED) splash(sim, S, p.x);
    }

    // 2) beams (distance constraints; ropes only when stretched)
    const live = S.live, kf = 1 - Math.exp(-H / TUNING.FORCE_TAU), invH2 = 1 / H2;
    for (let i = 0; i < live.length; i++) {
      const bm = live[i], a = bm.a, b = bm.b;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      let dl = 0;
      if (d > 1e-9) {
        const C = d - bm.rest;
        const nx = dx / d, ny = dy / d;
        bm.nx = nx; bm.ny = ny;
        if (!(bm.tensionOnly && C <= 0)) {
          const ws = a.w + b.w + bm.at;
          if (ws > 0) {
            dl = -C / ws;
            const ca = a.w * dl, cb = b.w * dl;
            a.x -= ca * nx; a.y -= ca * ny;
            b.x += cb * nx; b.y += cb * ny;
          }
        }
      }
      bm.lam = dl;
      if (!bm.debris) bm.force += (-dl * invH2 - bm.force) * kf;   // + = tension
    }

    // 3) vehicle chassis (rigid) + suspension
    const lv = S.liveVehicles;
    for (let vi = 0; vi < lv.length; vi++) solveVehicle(lv[vi]);

    // 4) contacts
    for (let vi = 0; vi < lv.length; vi++) {
      const v = lv[vi];
      for (let j = 0; j < v.wheels.length; j++) {
        const p = v.wheels[j].p, c = p.cand;
        for (let k = 0; k < c.length; k++) wheelBeamContact(p, c[k]);
        if (p.tnear) terrainContact(S, p);
      }
      const BR = v.body[0], BF = v.body[1];
      let ux = BR.y - BF.y, uy = BF.x - BR.x;                 // body up axis
      const ul = Math.sqrt(ux * ux + uy * uy) || 1; ux /= ul; uy /= ul;
      for (let j = 0; j < 4; j++) {
        const p = v.body[j], c = p.cand, lf = j < 2 ? v.lift[j] : 0;
        for (let k = 0; k < c.length; k++) bodyBeamContact(p, c[k], ux * lf, uy * lf);
        if (p.tnear) {            // terrain: same raised contact point (shift, solve, shift back)
          p.x += ux * lf; p.y += uy * lf;
          terrainContact(S, p);
          p.x -= ux * lf; p.y -= uy * lf;
        }
      }
    }
    const nodes = S.nodes;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].tnear) terrainContact(S, nodes[i]);
    const cargo = S.cargo;
    for (let i = 0; i < cargo.length; i++) {
      const p = cargo[i].p;
      if (!p.on) continue;
      const c = p.cand;
      for (let k = 0; k < c.length; k++) bodyBeamContact(p, c[k], 0, 0);
      if (p.tnear) terrainContact(S, p);
    }

    // 5) velocities
    for (let i = 0; i < n; i++) {
      const p = act[i];
      p.vx = (p.x - p.ox) * INV_H; p.vy = (p.y - p.oy) * INV_H;
    }

    // 6) velocity passes
    // 6a) beam damping (makes structures settle quickly without looking floaty):
    //  - axial: relative velocity along the beam
    //  - rotational: a beam's angular velocity relative to the mean angular velocity of the
    //    beams at its two nodes. Rigid swinging/rotation of whole parts is NOT damped, but
    //    deformation modes (e.g. the transverse mode of a nearly straight chain) are.
    const fb = 1 - Math.exp(-TUNING.BEAM_DAMP * H);
    const fr = 1 - Math.exp(-TUNING.ROT_DAMP * H);
    for (let i = 0; i < live.length; i++) { const bm = live[i]; bm.a.om = 0; bm.a.omc = 0; bm.b.om = 0; bm.b.omc = 0; }
    for (let i = 0; i < live.length; i++) {
      const bm = live[i];
      if (bm.tensionOnly && bm.lam === 0) { bm.om = 0; continue; }   // slack rope
      const a = bm.a, b = bm.b;
      const om = ((b.vy - a.vy) * bm.nx - (b.vx - a.vx) * bm.ny) / bm.rest;
      bm.om = om;
      a.om += om; a.omc++; b.om += om; b.omc++;
    }
    for (let i = 0; i < live.length; i++) {
      const bm = live[i];
      if (bm.tensionOnly && bm.lam === 0) continue;
      const a = bm.a, b = bm.b, ws = a.w + b.w;
      if (ws === 0) continue;
      const nx = bm.nx, ny = bm.ny;
      const vr = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      const P = vr * fb * bm.damp / ws;
      const dev = bm.om - 0.5 * (a.om / a.omc + b.om / b.omc);
      const Q = dev * bm.rest * fr / ws;      // perpendicular impulse, perp = (-ny, nx)
      const jx = P * nx - Q * ny, jy = P * ny + Q * nx;
      a.vx += a.w * jx; a.vy += a.w * jy;
      b.vx -= b.w * jx; b.vy -= b.w * jy;
    }
    // 6b) suspension damping, drive / brake, friction
    for (let vi = 0; vi < lv.length; vi++) vehicleVelocityPass(S, lv[vi]);
    for (let i = 0; i < nodes.length; i++) { const p = nodes[i]; if (p.cbest > 0) frictionPass(S, p); }
    for (let i = 0; i < cargo.length; i++) { const p = cargo[i].p; if (p.on && p.cbest > 0) frictionPass(S, p); }
    // 6c) water drag + global damping
    const gd = 1 - TUNING.GLOBAL_DAMP * H, wd = Math.exp(-TUNING.WATER_DRAG * H);
    for (let i = 0; i < n; i++) {
      const p = act[i];
      let f = gd;
      if (hasWater && p.y < water) f *= wd;
      p.vx *= f; p.vy *= f;
    }
  }

  function solveVehicle(v) {
    const rg = v.rigid;
    for (let i = 0; i < rg.length; i++) {
      const c = rg[i], a = c.a, b = c.b;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) continue;
      const dl = -(d - c.rest) / (a.w + b.w);
      const nx = dx / d, ny = dy / d;
      a.x -= a.w * dl * nx; a.y -= a.w * dl * ny;
      b.x += b.w * dl * nx; b.y += b.w * dl * ny;
    }
    const BR = v.body[0], BF = v.body[1], TF = v.body[2], TR = v.body[3];
    let ex = BF.x - BR.x, ey = BF.y - BR.y;
    const l = Math.sqrt(ex * ex + ey * ey) || 1; ex /= l; ey /= l;
    const nx = -ey, ny = ex;       // body "up"
    const sp = v.susp;
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i], W = s.p, c = s.c;
      const tx = c[0] * BR.x + c[1] * BF.x + c[2] * TF.x + c[3] * TR.x;
      const ty = c[0] * BR.y + c[1] * BF.y + c[2] * TF.y + c[3] * TR.y;
      const dx = W.x - tx, dy = W.y - ty;
      // along the body x axis (stiff) and the body y axis (spring + bump stop)
      const Cx = dx * ex + dy * ey;
      const dlx = -Cx / (s.wEff + s.atx);
      const Cy = dx * nx + dy * ny;
      let dly = -Cy / (s.wEff + s.aty);
      let Cn = Cy + s.wEff * dly;
      if (Cn > s.limit) {                     // progressive (compliant) bump stop, rigid end of travel
        dly -= (Cn - s.limit) / (s.wEff + s.atb);
        Cn = Cy + s.wEff * dly;
        if (Cn > s.hard) dly -= (Cn - s.hard) / s.wEff;
      }
      const jx = dlx * ex + dly * nx, jy = dlx * ey + dly * ny;
      W.x += W.w * jx; W.y += W.w * jy;
      BR.x -= c[0] * BR.w * jx; BR.y -= c[0] * BR.w * jy;
      BF.x -= c[1] * BF.w * jx; BF.y -= c[1] * BF.w * jy;
      TF.x -= c[2] * TF.w * jx; TF.y -= c[2] * TF.w * jy;
      TR.x -= c[3] * TR.w * jx; TR.y -= c[3] * TR.w * jy;
    }
  }

  function vehicleVelocityPass(S, v) {
    const BR = v.body[0], BF = v.body[1], TF = v.body[2], TR = v.body[3];
    let ex = BF.x - BR.x, ey = BF.y - BR.y;
    const l = Math.sqrt(ex * ex + ey * ey) || 1; ex /= l; ey /= l;
    const nx = -ey, ny = ex;
    // suspension damping
    const sp = v.susp;
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i], W = s.p, c = s.c;
      const tvx = c[0] * BR.vx + c[1] * BF.vx + c[2] * TF.vx + c[3] * TR.vx;
      const tvy = c[0] * BR.vy + c[1] * BF.vy + c[2] * TF.vy + c[3] * TR.vy;
      const rx = W.vx - tvx, ry = W.vy - tvy;
      const Px = -(rx * ex + ry * ey) * s.fdx / s.wEff;
      let Py = -(rx * nx + ry * ny) * s.fdy / s.wEff;
      if (Py > s.dmax) Py = s.dmax; else if (Py < -s.dmax) Py = -s.dmax;   // digressive damper
      const jx = Px * ex + Py * nx, jy = Px * ey + Py * ny;
      W.vx += W.w * jx; W.vy += W.w * jy;
      BR.vx -= c[0] * BR.w * jx; BR.vy -= c[0] * BR.w * jy;
      BF.vx -= c[1] * BF.w * jx; BF.vy -= c[1] * BF.w * jy;
      TF.vx -= c[2] * TF.w * jx; TF.vy -= c[2] * TF.w * jy;
      TR.vx -= c[3] * TR.w * jx; TR.vy -= c[3] * TR.w * jy;
    }
    // tyre damping along the strongest contact normal (never pulls the wheel onto the surface)
    for (let i = 0; i < v.wheels.length; i++) {
      const p = v.wheels[i].p;
      if (p.cbest <= 0) continue;
      const nx = p.cnx, ny = p.cny, bm = p.cbeam;
      let svx = 0, svy = 0, wEff = p.w;
      if (bm) {
        const a = bm.a, b = bm.b, tb = p.ct, ta = 1 - tb;
        svx = ta * a.vx + tb * b.vx; svy = ta * a.vy + tb * b.vy;
        wEff += ta * ta * a.w + tb * tb * b.w;
      }
      const vn = (p.vx - svx) * nx + (p.vy - svy) * ny;
      let J = -vn * (1 - Math.exp(-p.td * wEff * H)) / wEff;
      const jMin = -p.clam / H;
      if (J < jMin) J = jMin;
      applyTangential(p, J, nx, ny);
    }
    // drive / brake: distributed over the wheels in contact by normal force, traction-limited
    const F = v.drive;
    if (F !== 0) {
      let sumN = 0;
      for (let i = 0; i < v.wheels.length; i++) sumN += v.wheels[i].p.clam;
      if (sumN > 0) {
        for (let i = 0; i < v.wheels.length; i++) {
          const p = v.wheels[i].p;
          if (p.clam <= 0) continue;
          let f = F * p.clam / sumN;
          const lim = S.traction * p.clam / H2;
          if (f > lim) f = lim; else if (f < -lim) f = -lim;
          let tx = p.cny, ty = -p.cnx;
          if (tx * ex + ty * ey < 0) { tx = -tx; ty = -ty; }
          applyTangential(p, f * H, tx, ty);
        }
      }
    }
    for (let i = 0; i < 4; i++) if (v.body[i].cbest > 0) frictionPass(S, v.body[i]);
  }

  // Applies a tangential impulse J (N·s) to particle p and the reaction to its contact surface.
  function applyTangential(p, J, tx, ty) {
    p.vx += p.w * J * tx; p.vy += p.w * J * ty;
    const bm = p.cbeam;
    if (bm) {
      const a = bm.a, b = bm.b, tb = p.ct, ta = 1 - tb;
      a.vx -= ta * a.w * J * tx; a.vy -= ta * a.w * J * ty;
      b.vx -= tb * b.w * J * tx; b.vy -= tb * b.w * J * ty;
    }
  }

  // Coulomb friction for debris / bodies on terrain or decks (velocity level).
  function frictionPass(S, p) {
    const nx = p.cnx, ny = p.cny, tx = ny, ty = -nx;
    let svx = 0, svy = 0, wEff = p.w;
    const bm = p.cbeam;
    if (bm) {
      const a = bm.a, b = bm.b, tb = p.ct, ta = 1 - tb;
      svx = ta * a.vx + tb * b.vx; svy = ta * a.vy + tb * b.vy;
      wEff += ta * ta * a.w + tb * tb * b.w;
    }
    const vt = (p.vx - svx) * tx + (p.vy - svy) * ty;
    // normal impulse of this substep: clam / h ; max tangential impulse μ · that
    const maxJ = S.friction * p.clam / H;
    let J = -vt / wEff;
    if (J > maxJ) J = maxJ; else if (J < -maxJ) J = -maxJ;
    applyTangential(p, J, tx, ty);
  }

  // Wheel vs drivable beam: two-sided circle–segment contact, the correction is shared with the
  // segment's two nodes by barycentric weight (this is how vehicles load the bridge).
  // Concave joints between consecutive drivable beams (fillet partners pa / pb, see rebuildLists)
  // are rounded off with a circular fillet of tangent length ≤ FILLET_LEN, so the wheel-centre
  // path has no corner there (a sharp slope change would hit the vehicle with a velocity jump).
  function wheelBeamContact(p, bm) {
    const a = bm.a, b = bm.b;
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    if (l2 < 1e-12) return;
    const tu = ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2;
    let t = tu < 0 ? 0 : tu > 1 ? 1 : tu;
    let nx = p.x - (a.x + ex * t), ny = p.y - (a.y + ey * t);
    const d2 = nx * nx + ny * ny, r = p.r;
    if (bm.pa !== null || bm.pb !== null) {
      const rq = r + FILLET_GAP;
      if (d2 >= rq * rq) return;
      const l = Math.sqrt(l2), s = tu * l;
      if (bm.pa !== null && s < TUNING.FILLET_LEN) {
        const lt = filletEnd(p, bm, a, b, bm.pa, l, false);
        if (lt > 0 && s < lt) return;          // fillet zone of end a (arc handled by filletEnd)
      }
      if (bm.pb !== null && l - s < TUNING.FILLET_LEN) {
        const lt = filletEnd(p, bm, b, a, bm.pb, l, true);
        if (lt > 0 && l - s < lt) return;      // fillet zone of end b
      }
    }
    if (d2 >= r * r) return;
    const d = Math.sqrt(d2);
    if (d > 1e-9) { nx /= d; ny /= d; }
    else { const l = Math.sqrt(l2); nx = -ey / l; ny = ex / l; if (ny < 0) { nx = -nx; ny = -ny; } }
    wheelContactApply(p, bm, t, nx, ny, r - d);
  }

  // Fillet at end J of beam bm (other end K, partner beam B, length l). Returns the tangent length
  // when the joint is concave as seen from the wheel (0 = no fillet: plain segment end). Resolves
  // the contact with this beam's half of the arc (the other half belongs to the partner).
  function filletEnd(p, bm, J, K, B, l, atB) {
    const O = B.a === J ? B.b : B.a;
    const ax = (K.x - J.x) / l, ay = (K.y - J.y) / l;
    let bx = O.x - J.x, by = O.y - J.y;
    const lb = Math.sqrt(bx * bx + by * by);
    if (lb < 1e-6) return 0;
    bx /= lb; by /= lb;
    const cosD = -(ax * bx + ay * by);              // cos of the slope change
    if (cosD < FILLET_COS_MAX || cosD > 1 - 1e-9) return 0;
    const px = p.x - J.x, py = p.y - J.y;
    // wheel inside the joint angle (on the concave side of both beams)?
    if ((ax * py - ay * px) * (ax * by - ay * bx) <= 0) return 0;
    if ((bx * py - by * px) * (bx * ay - by * ax) <= 0) return 0;
    const dth = Math.acos(cosD);
    let lt = Math.min(TUNING.FILLET_LEN, 0.45 * l, 0.45 * lb);
    if (dth < FILLET_FADE) lt *= dth / FILLET_FADE;  // fades out for nearly straight joints
    const half = 0.5 * dth, rf = lt / Math.tan(half), r = p.r;
    if (rf < 1.2 * r) return 0;
    let sx = ax + bx, sy = ay + by;                  // bisector (into the joint angle)
    const sl = Math.sqrt(sx * sx + sy * sy);
    sx /= sl; sy /= sl;
    const cd = rf / Math.cos(half);
    const cx = J.x + sx * cd, cy = J.y + sy * cd;    // fillet centre
    const ux = p.x - cx, uy = p.y - cy;
    // on this beam's half of the arc: direction C→P between C→T (tangent point) and -bisector
    const tx = J.x + ax * lt - cx, ty = J.y + ay * lt - cy;
    const c0 = -tx * sy + ty * sx;
    if ((tx * uy - ty * ux) * c0 < 0 || (-ux * sy + uy * sx) * c0 < 0) return lt;
    const dw = Math.sqrt(ux * ux + uy * uy);
    if (dw < 1e-9) return lt;
    const pen = r - rf + dw;
    if (pen <= 0) return lt;
    const nx = -ux / dw, ny = -uy / dw;
    // contact point on the arc → barycentric position along the beam
    let t = ((cx - nx * rf - J.x) * ax + (cy - ny * rf - J.y) * ay) / l;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    wheelContactApply(p, bm, atB ? 1 - t : t, nx, ny, pen);
    return lt;
  }

  function wheelContactApply(p, bm, t, nx, ny, pen) {
    const a = bm.a, b = bm.b, r = p.r;
    const ta = 1 - t, tb = t;
    const wsum = p.w + ta * ta * a.w + tb * tb * b.w;
    // compliant tyre; deflection beyond TYRE_MAXPEN·r is resolved rigidly
    let dl = pen / (wsum + p.tc);
    const rest = pen - wsum * dl - TUNING.TYRE_MAXPEN * r;
    if (rest > 0) dl += rest / wsum;
    p.x += p.w * dl * nx; p.y += p.w * dl * ny;
    a.x -= ta * a.w * dl * nx; a.y -= ta * a.w * dl * ny;
    b.x -= tb * b.w * dl * nx; b.y -= tb * b.w * dl * ny;
    p.clam += dl;
    if (dl > p.cbest) { p.cbest = dl; p.cnx = nx; p.cny = ny; p.cbeam = bm; p.ct = t; }
  }

  // Body corner vs drivable beam: one-sided, only from above (prevents sinking through decks).
  // The contact point is the corner raised by (lx, ly) (chamfered overhangs, see buildVehicle).
  function bodyBeamContact(p, bm, lx, ly) {
    const a = bm.a, b = bm.b;
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    if (l2 < 1e-12) return;
    const cx = p.x + lx - a.x, cy = p.y + ly - a.y;
    const t = (cx * ex + cy * ey) / l2;
    if (t < 0 || t > 1) return;
    const l = Math.sqrt(l2);
    let nx = -ey / l, ny = ex / l;
    if (ny < 0) { nx = -nx; ny = -ny; }
    if (ny < 0.3) return;                    // (near) vertical deck pieces do not carry bodies
    const s = cx * nx + cy * ny;
    if (s >= p.r || s < -TUNING.BODY_DEPTH) return;
    const ta = 1 - t, tb = t;
    const wsum = p.w + ta * ta * a.w + tb * tb * b.w;
    const dl = (p.r - s) / wsum;
    p.x += p.w * dl * nx; p.y += p.w * dl * ny;
    a.x -= ta * a.w * dl * nx; a.y -= ta * a.w * dl * ny;
    b.x -= tb * b.w * dl * nx; b.y -= tb * b.w * dl * ny;
    p.clam += dl;
    if (dl > p.cbest) { p.cbest = dl; p.cnx = nx; p.cny = ny; p.cbeam = bm; p.ct = t; }
  }

  // Circle vs terrain polygon (robust: uses the inside test, so deep penetrations are resolved
  // towards the nearest surface point).
  function terrainContact(S, p) {
    const T = S.T, gx = T.gx, gy = T.gy;
    const px = p.x, py = p.y, r = p.r;
    let best = Infinity, qx = 0, qy = 0, bi = -1;
    let found = false, surf = Infinity;
    for (let i = p.tlo; i <= p.thi; i++) {
      const ax = gx[i], ay = gy[i], bx = gx[i + 1], by = gy[i + 1];
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = ax + ex * t, cy = ay + ey * t;
      const dx = px - cx, dy = py - cy, d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; qx = cx; qy = cy; bi = i; }
      if (ex > 0 && px >= ax && px <= bx) {
        const sy = ay + ey * (px - ax) / ex;
        found = true; if (sy < surf) surf = sy;
      }
    }
    if (bi < 0) return;
    const inside = found && py < surf;
    if (!inside && best >= r * r) return;
    const d = Math.sqrt(best);
    let nx, ny;
    if (d > 1e-9) {
      nx = (px - qx) / d; ny = (py - qy) / d;
      if (inside) { nx = -nx; ny = -ny; }
    } else {
      const ex = gx[bi + 1] - gx[bi], ey = gy[bi + 1] - gy[bi], l = Math.sqrt(ex * ex + ey * ey) || 1;
      nx = -ey / l; ny = ex / l;              // left normal = outward for a left-to-right polyline
    }
    const tx = qx + nx * r, ty = qy + ny * r;
    const dep = (tx - px) * nx + (ty - py) * ny;
    if (dep <= 0) return;
    let lam;
    if (p.tc > 0) {                           // compliant tyre (see wheelBeamContact)
      lam = dep / (p.w + p.tc);
      const rest = dep - p.w * lam - TUNING.TYRE_MAXPEN * r;
      if (rest > 0) lam += rest / p.w;
      p.x += p.w * lam * nx; p.y += p.w * lam * ny;
    } else {
      p.x = tx; p.y = ty;
      lam = dep / p.w;
    }
    p.clam += lam;
    if (lam > p.cbest) { p.cbest = lam; p.cnx = nx; p.cny = ny; p.cbeam = null; p.ct = 0; }
  }

  // Roof of a vehicle (top chassis edge TR–TF, plus the top corner circles) against solid obstacles.
  function vehicleHitsObstacle(S, v) {
    const TF = v.body[2], TR = v.body[3], r = TUNING.OBSTACLE_R;
    const out = S.obstacles;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (Math.max(o.x1, o.x2) < Math.min(TR.x, TF.x) - r || Math.min(o.x1, o.x2) > Math.max(TR.x, TF.x) + r) continue;
      if (segCross(TR.x, TR.y, TF.x, TF.y, o.x1, o.y1, o.x2, o.y2)) return true;
      if (segClosest(o.x1, o.y1, o.x2, o.y2, TR.x, TR.y, _tmp) < r * r) return true;
      if (segClosest(o.x1, o.y1, o.x2, o.y2, TF.x, TF.y, _tmp) < r * r) return true;
      if (segClosest(TR.x, TR.y, TF.x, TF.y, o.x1, o.y1, _tmp) < r * r) return true;
      if (segClosest(TR.x, TR.y, TF.x, TF.y, o.x2, o.y2, _tmp) < r * r) return true;
    }
    return false;
  }

  function splash(sim, S, x) {
    if (sim.t - S.lastSplashT < 0.3 && Math.abs(x - S.lastSplashX) < 3) return;
    S.lastSplashT = sim.t; S.lastSplashX = x;
    sim.events.push({ type: 'splash', x: x, y: S.water });
  }

  // ================================================================ breaking
  function breakBeam(sim, S, bm) {
    bm.broken = true;
    const a = bm.a, b = bm.b;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const mvx = (a.vx + b.vx) / 2, mvy = (a.vy + b.vy) / 2;
    const beamMass = bm.mat.mass * bm.rest;
    // each half: its own new end point at the break, carrying a quarter of the beam mass
    const q = beamMass / 4;
    const p1 = newParticle(mx, my, q + TUNING.NODE_MIN_MASS, TUNING.NODE_RADIUS, K_NODE);
    const p2 = newParticle(mx, my, q + TUNING.NODE_MIN_MASS, TUNING.NODE_RADIUS, K_NODE);
    p1.vx = p2.vx = mvx; p1.vy = p2.vy = mvy;
    p1.on = p2.on = true;
    for (const n of [a, b]) {
      if (n.w === 0) continue;
      n.mass = Math.max(TUNING.NODE_MIN_MASS, n.mass - q);
      n.w = 1 / n.mass;
    }
    const d1 = makeBeam(a, p1, bm.mat, bm.rest / 2, true);
    const d2 = makeBeam(p2, b, bm.mat, bm.rest / 2, true);
    d1.src = d2.src = bm.src;
    p1.deg = 1; p2.deg = 1;   // a and b keep their degree (intact beam replaced by a debris beam)
    bm.force = 0; bm.stress = 0;
    sim.particles.push(p1, p2); sim.joints.push(p1, p2);
    sim.beams.push(d1, d2);
    S.brokenCount++;
    S.dirty = true;
    sim.events.push({ type: 'break', x: mx, y: my, m: bm.m });
  }

  // ================================================================== step
  function step(sim) {
    const S = sim._s;
    if (S.dirty) rebuildLists(sim, S);
    prepareFrame(sim, S);
    const t0 = sim.t;
    for (let k = 0; k < SUBSTEPS; k++) {
      const g = G * smooth01((t0 + (k + 1) * H) / TUNING.GRAVITY_RAMP);
      substep(sim, S, g);
    }
    S.frame++;
    sim.t = S.frame * FRAME_DT;
    postFrame(sim, S);
  }

  function postFrame(sim, S) {
    const running = sim.status === 'running';
    // ---- stresses, max stress, breaking
    const intact = S.intact;
    let toBreak = null;
    for (let i = 0; i < intact.length; i++) {
      const b = intact[i];
      const st = b.force >= 0 ? b.force / b.strength : -b.force / b.strengthC;   // + = tension; stone / cast iron: weak in tension, strong in compression
      b.stress = st;
      if (running && S.frame > 1 && st > S.maxStress) { S.maxStress = st; S.maxStressBeam = b; }
      if (st > 1) (toBreak || (toBreak = [])).push(b);
    }
    if (toBreak) {
      for (let i = 0; i < toBreak.length; i++) breakBeam(sim, S, toBreak[i]);
      if (sim.status === 'running') { sim.status = 'failed'; sim.reason = 'break'; }
    }

    // ---- vehicles
    let crashed = false, stuck = false, routeMiss = false;
    const dt = FRAME_DT;
    for (let i = 0; i < sim.vehicles.length; i++) {
      const v = sim.vehicles[i];
      if (v.state === 'waiting' || v.removed) continue;
      updatePose(v);
      // wheel rotation for drawing
      let ex = Math.cos(v.pose.angle), ey = Math.sin(v.pose.angle);
      for (let j = 0; j < v.wheels.length; j++) {
        const wh = v.wheels[j], p = wh.p;
        if (p.cbest > 0) {
          let tx = p.cny, ty = -p.cnx;
          if (tx * ex + ty * ey < 0) { tx = -tx; ty = -ty; }
          let svx = 0, svy = 0;
          if (p.cbeam) { const a = p.cbeam.a, b = p.cbeam.b, tb = p.ct; svx = (1 - tb) * a.vx + tb * b.vx; svy = (1 - tb) * a.vy + tb * b.vy; }
          wh.omega = -((p.vx - svx) * tx + (p.vy - svy) * ty) / wh.r;
        } else {
          wh.omega *= Math.exp(-0.4 * dt);   // free spinning in the air, slowly decaying
        }
        wh.angle += wh.omega * dt;
        if (wh.angle > 1e4 || wh.angle < -1e4) wh.angle %= (2 * Math.PI);
      }
      const L = v.def.length;
      const rearX = Math.min(v.body[0].x, v.body[3].x);
      const frontX = Math.max(v.body[1].x, v.body[2].x);
      if (v.state === 'driving') {
        // crash: centre below fallY, body under water, flipped
        let cy = 0;
        for (let k = 0; k < 4; k++) cy += v.body[k].y;
        cy /= 4;
        let wet = false;
        if (S.water !== null) for (let k = 0; k < 4; k++) if (v.body[k].y < S.water) wet = true;
        const flipped = Math.abs(v.pose.angle) > TUNING.FLIP_ANGLE * Math.PI / 180;
        let hitObs = false;
        if (S.obstacles.length) hitObs = vehicleHitsObstacle(S, v);
        if (hitObs) S.hitReason = 'obstacle';
        if (cy < S.fallY || wet || flipped || hitObs) {
          v.state = 'crashed';
          sim.events.push({ type: 'crash', index: i });
          if (wet || (S.water !== null && cy < S.fallY)) splash(sim, S, v.pose.x);
          crashed = true;
        } else if (S.routes[v.route].strict && v.stIdx < S.routes[v.route].stations.length && frontX >= S.routes[v.route].stations[v.stIdx].x && !stationReached(sim, S, v)) {
          // v3.4: the front passed a flag of a strict route at the wrong height
          v.missed = true; routeMiss = true;
        } else if (rearX > S.routes[v.route].flagX && (!S.routes[v.route].strict || v.stIdx >= S.routes[v.route].stations.length)) {
          v.state = 'finished'; v.finT = sim.t; v.stillT = 0; v.stIdx = S.routes[v.route].stations.length;
          S.finished++;
          sim.events.push({ type: 'finish', index: i });
        } else if (sim.t > TUNING.DRIVE_START) {
          if (frontX > v.bestX + TUNING.STUCK_DIST || S.holdActive) { if (frontX > v.bestX) v.bestX = frontX; v.progT = sim.t; }
          else if (sim.t - v.progT > TUNING.STUCK_TIME) stuck = true;
        }
      }
      // a finished vehicle that came to rest (e.g. at a wall behind the flag) leaves the scene
      if (v.state === 'finished') {
        if (Math.abs(v.speed) < 0.4) v.stillT += dt; else v.stillT = 0;
      }
      if (v.state === 'finished' && (rearX > S.routes[v.route].flagX + TUNING.REMOVE_DIST || (v.stillT > 0.8 && sim.t - v.finT > 1.5))) {
        v.removed = true; v.visible = false;
        for (let k = 0; k < 4; k++) v.body[k].on = false;
        for (let k = 0; k < v.wheels.length; k++) v.wheels[k].p.on = false;
        S.dirty = true;
      }
      void L;
    }
    // spawn the next vehicle of each route when there is room
    if (sim.status === 'running') trySpawn(sim, S);

    // ---- freeze particles that fell far below everything
    for (let i = 0; i < S.active.length; i++) {
      const p = S.active[i];
      if (p.y < S.killY) { p.on = false; p.vx = p.vy = 0; S.dirty = true; }
    }

    // ---- cargo lost (crates that fell off the bed into the deep or the water); bonus-objective
    // bookkeeping only, never a level failure.
    for (let i = 0; i < S.cargo.length; i++) {
      const c = S.cargo[i];
      if (c.lost || !c.p.on) continue;
      if (c.p.y < S.fallY || (S.water !== null && c.p.y < S.water)) c.lost = true;
    }

    // ---- checkpoints: the first vehicle to cross one jumps the hydraulics to its phase
    let shipCrash = false;
    if (running) {
      const checkpoints = (sim.level && Array.isArray(sim.level.checkpoints)) ? sim.level.checkpoints : [];
      if (checkpoints.length) {
        for (let i = 0; i < checkpoints.length; i++) {
          if (S.checkpointHit.has(i)) continue;
          const cp = checkpoints[i];
          for (let k = 0; k < S.liveVehicles.length; k++) {
            const v = S.liveVehicles[k];
            if (typeof cp.v === 'number' && v.index !== cp.v) continue;          // checkpoint reserved for one vehicle
            if (Math.max(v.body[1].x, v.body[2].x) >= cp.x) { S.checkpointHit.add(i); setPhase(sim, cp.phase); break; }
          }
        }
      }
      shipCrash = updateGates(sim, S);
    }

    // ---- status
    if (sim.status === 'running') {
      if (crashed) { sim.status = 'failed'; sim.reason = S.hitReason || 'fall'; }
      else if (shipCrash) { sim.status = 'failed'; sim.reason = S.gates.some((g) => g.state === 'blocked' && g.kind === 'truck') ? 'truck' : S.gates.some((g) => g.state === 'blocked' && g.kind === 'train') ? 'train' : 'ship'; }
      else if (routeMiss) { sim.status = 'failed'; sim.reason = 'route'; }
      else if (stuck) { sim.status = 'failed'; sim.reason = 'stuck'; }
      else if (sim.vehicles.length > 0 && S.finished === sim.vehicles.length) { sim.status = 'won'; }
      else if (sim.vehicles.length === 0 && sim.t >= TUNING.EMPTY_WIN_TIME) { sim.status = 'won'; }
      else if (sim.t >= S.timeout) { sim.status = 'failed'; sim.reason = 'timeout'; }
    }
  }

  // ==================================================================== run
  function summary(sim) {
    const S = sim._s;
    let cargoOk = true, cargoTotal = 0;
    for (let i = 0; i < S.cargo.length; i++) { cargoTotal++; if (S.cargo[i].lost) cargoOk = false; }
    return {
      status: sim.status, reason: sim.reason, time: sim.t,
      maxStress: S.maxStress, brokenCount: S.brokenCount, finished: S.finished,
      maxStressBeam: S.maxStressBeam && S.maxStressBeam.src >= 0 ? S.maxStressBeam.src : -1,
      cargoTotal: cargoTotal, cargoIntact: cargoTotal > 0 ? cargoOk : null,
      phase: S.phase, numPhases: S.numPhases,
    };
  }

  function run(level, bridge, opts) {
    const sim = createSim(level, bridge, opts);
    const S = sim._s;
    const maxFrames = Math.ceil((S.timeout + 2) / FRAME_DT);
    while (sim.status === 'running' && S.frame < maxFrames) {
      step(sim);
      sim.events.length = 0;
    }
    return summary(sim);
  }

  /**
   * Quick stress test for the build mode ("Schnelltest", key T): the bridge alone (no vehicles, hydraulics in phase 1)
   * settles under its own weight for a moment. Returns the load (0…1+) of every beam of `bridge.beams` (same order),
   * the maximum and which beams broke. Cheap enough to run after every edit.
   */
  function quickStress(level, bridge, seconds) {
    const n = (bridge && bridge.beams) ? bridge.beams.length : 0;
    const out = { stress: new Array(n).fill(0), max: 0, broken: [], ok: true, t: 0 };
    if (!n) return out;
    let sim;
    try { sim = createSim(level, bridge, { vehicles: [] }); } catch (e) { out.ok = false; return out; }
    const S = sim._s, frames = Math.ceil((seconds || 1.6) / FRAME_DT), avg = new Array(n).fill(0);
    let cnt = 0;
    for (let f = 0; f < frames && sim.status === 'running'; f++) {
      step(sim); sim.events.length = 0;
      if (f >= frames * 0.6) {                       // average over the last 40 % (the start is a settling transient)
        cnt++;
        for (let i = 0; i < sim.beams.length; i++) { const b = sim.beams[i]; if (b.src >= 0 && b.src < n && !b.broken && !b.debris && isFinite(b.stress)) avg[b.src] += b.stress; }
      }
    }
    for (let i = 0; i < n; i++) { out.stress[i] = cnt ? avg[i] / cnt : 0; if (out.stress[i] > out.max) out.max = out.stress[i]; }
    for (let i = 0; i < sim.beams.length; i++) { const b = sim.beams[i]; if (b.src >= 0 && b.src < n && b.broken) out.broken.push(b.src); }
    out.t = sim.t;
    if (S.brokenCount > 0) out.ok = false;
    return out;
  }

  /**
   * Quick test (build mode, "Schnelltest"): the real test drive, but headless and in small time slices so the
   * screen stays responsive. q.advance(ms) runs for about ms milliseconds and returns true when finished;
   * q.result = { status, reason, maxStress, stress[] (peak load of every beam of bridge.beams), broken[] (indices), t }.
   */
  function quickTest(level, bridge) {
    const n = (bridge && bridge.beams) ? bridge.beams.length : 0;
    const peak = new Array(n).fill(0), broken = {};
    let sim = null, failed = false;
    try { sim = createSim(level, bridge); } catch (e) { failed = true; }
    const q = { done: failed, result: null, frames: 0, cancelled: false };
    function finish() {
      const sm = failed ? null : summary(sim);
      const list = Object.keys(broken).map(Number);
      q.result = failed ? { status: 'error', reason: null, maxStress: 0, stress: peak, broken: list, t: 0 }
        : { status: sim.status, reason: sim.reason, maxStress: sm.maxStress, stress: peak, broken: list, t: sim.t, cargoIntact: sm.cargoIntact };
      q.done = true;
    }
    if (failed) finish();
    q.advance = function (ms) {
      if (q.done) return true;
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now(), S = sim._s;
      const maxFrames = Math.ceil((S.timeout + 2) / FRAME_DT);
      while (sim.status === 'running' && S.frame < maxFrames) {
        step(sim); sim.events.length = 0; q.frames++;
        for (let i = 0; i < sim.beams.length; i++) {
          const b = sim.beams[i];
          if (b.src < 0 || b.src >= n) continue;
          if (b.broken) broken[b.src] = 1;
          else if (!b.debris && b.stress > peak[b.src] && isFinite(b.stress)) peak[b.src] = b.stress;
        }
        if ((q.frames & 7) === 0 && (typeof performance !== 'undefined' ? performance : Date).now() - t0 > ms) return false;
      }
      finish();
      return true;
    };
    return q;
  }

  const RESULT_TEXT = {
    break: 'Die Brücke ist eingestürzt!',
    fall: 'Ein Fahrzeug ist abgestürzt!',
    stuck: 'Ein Fahrzeug steckt fest.',
    timeout: 'Die Zeit ist abgelaufen.',
    ship: 'Das Schiff kommt nicht unter der Brücke durch – es steckt vor der Brücke fest!',
    truck: 'Der LKW auf der Straße darunter kommt nicht unter der Brücke durch!',
    train: 'Der Zug darunter kommt nicht unter der Brücke durch!',
    obstacle: 'Ein Fahrzeug ist gegen ein Hindernis gefahren!',
    route: 'Ein Fahrzeug hat eine Fahne ausgelassen – es ist auf der falschen Höhe an ihr vorbeigefahren!',
  };

  BB.MATERIALS = MATERIALS;
  BB.MATERIAL_ORDER = MATERIAL_ORDER;
  BB.FOUNDATION = FOUNDATION;
  BB.HYD_PHASES = HYD_PHASES;
  BB.ROUTE_COLORS = ROUTE_COLORS;
  BB.vehicleEntries = vehicleEntries;
  BB.routesOf = routesOf;
  BB.VEHICLES = VEHICLES;
  BB.VEHICLE_ORDER = VEHICLE_ORDER;
  BB.Terrain = Terrain;
  BB.Bridge = Bridge;
  BB.Gates = { of: gatesOf, zAt: gateZ, KINDS: GATE_KINDS, PLANE_HALF: GATE_HALF };
  BB.Physics = {
    FRAME_DT: FRAME_DT,
    SUBSTEPS: SUBSTEPS,
    TUNING: TUNING,
    createSim: createSim,
    step: step,
    run: run,
    summary: summary,
    quickStress: quickStress,
    quickTest: quickTest,
    nextPhase: nextPhase,
    setPhase: setPhase,
    resultText(reason) {
      if (reason === null || reason === undefined) return 'Geschafft!';
      return RESULT_TEXT[reason] || 'Die Testfahrt ist fehlgeschlagen.';
    },
  };
})(globalThis.BB = globalThis.BB || {});
