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
  });

  const FILLET_COS_MAX = Math.cos(TUNING.FILLET_MAX_ANGLE * Math.PI / 180);
  const FILLET_FADE = 0.05;   // rad, below this slope change the fillet shrinks linearly to nothing
  const FILLET_GAP = 0.45;    // m, upper bound of the fillet's distance from the joint (broad phase)
  const KINK_DS = 0.5;        // m, sample spacing of the driver's road look-ahead

  // ---------------------------------------------------------------- materials
  const MATERIALS = {
    road: { key: 'road', name: 'Straße', price: 200, mass: 60, strength: 50000, maxLength: 4,
      drivable: true, tensionOnly: false, stiffness: 1.0e7, color: '#4a4a52' },
    steelroad: { key: 'steelroad', name: 'Stahlstraße', price: 400, mass: 90, strength: 160000, maxLength: 5,
      drivable: true, tensionOnly: false, stiffness: 5.0e7, color: '#5d7286' },
    wood: { key: 'wood', name: 'Holz', price: 100, mass: 25, strength: 55000, maxLength: 4,
      drivable: false, tensionOnly: false, stiffness: 1.0e8, color: '#b5793a' },
    steel: { key: 'steel', name: 'Stahl', price: 300, mass: 45, strength: 300000, maxLength: 6,
      drivable: false, tensionOnly: false, stiffness: 4.0e8, color: '#d4532a' },
    rope: { key: 'rope', name: 'Seil', price: 150, mass: 8, strength: 160000, maxLength: 20,
      drivable: false, tensionOnly: true, stiffness: 2.0e8, color: '#3a2e26' },
  };
  const MATERIAL_ORDER = ['road', 'steelroad', 'wood', 'steel', 'rope'];

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
  };
  const VEHICLE_ORDER = ['bike', 'car', 'bus', 'truck'];

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
  function key(x, y) { return x + ',' + y; }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  const Bridge = {
    key,
    length(b) { return Math.hypot(b.x2 - b.x1, b.y2 - b.y1); },
    cost(bridge) {
      let s = 0;
      const beams = (bridge && bridge.beams) || [];
      for (let i = 0; i < beams.length; i++) {
        const m = MATERIALS[beams[i].m];
        if (m) s += m.price * Bridge.length(beams[i]);
      }
      return Math.round(s);
    },
    nodes(bridge, level) {
      const out = [], seen = new Set();
      const anchors = (level && level.anchors) || [];
      for (let i = 0; i < anchors.length; i++) {
        const k = key(anchors[i][0], anchors[i][1]);
        if (seen.has(k)) continue;
        seen.add(k); out.push({ x: anchors[i][0], y: anchors[i][1], anchor: true });
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
    /** null if a (non-anchor) node may be placed at (x, y), else a German reason. */
    checkNode(level, x, y) {
      if (Bridge.isAnchor(level, x, y)) return null;
      if (!isInt(x) || !isInt(y)) return 'Punkt liegt nicht auf dem Raster';
      const bd = level && level.build;
      if (bd && (x < bd.minX || x > bd.maxX || y < bd.minY || y > bd.maxY)) return 'Außerhalb des Baubereichs';
      const ground = (level && level.ground) || [];
      if (Terrain.inside(ground, x, y)) return 'Punkt liegt im Gelände';
      if (Terrain.distance(ground, x, y) < 0.5 - 1e-9) return 'Zu nah am Gelände';
      return null;
    },
    /** Checks all building rules of SPEC §4. errors: unique German messages;
     *  details: [{msg, beam:index}] or [{msg, node:[x,y]}] for highlighting. */
    validate(level, bridge) {
      const errors = [], details = [];
      const add = (msg, d) => { if (errors.indexOf(msg) < 0) errors.push(msg); d.msg = msg; details.push(d); };
      if (!bridge || !Array.isArray(bridge.beams)) {
        add('Ungültige Brücke', {});
        return { ok: false, errors, details };
      }
      const allowed = (level && Array.isArray(level.materials) && level.materials.length) ? level.materials : MATERIAL_ORDER;
      const seen = new Set();
      const nodeKeys = new Set(), nodeList = [];
      for (let i = 0; i < bridge.beams.length; i++) {
        const b = bridge.beams[i];
        if (!b || !isInt(b.x1) || !isInt(b.y1) || !isInt(b.x2) || !isInt(b.y2)) { add('Ungültige Koordinaten', { beam: i }); continue; }
        const mat = MATERIALS[b.m];
        if (!mat) { add('Unbekanntes Material', { beam: i }); continue; }
        if (allowed.indexOf(b.m) < 0) add('Material in diesem Level nicht erlaubt', { beam: i });
        const len = Bridge.length(b);
        if (!(len > 0)) { add('Balken hat keine Länge', { beam: i }); continue; }
        if (len > mat.maxLength + 1e-9) add('Zu lang für dieses Material', { beam: i });
        const k1 = key(b.x1, b.y1), k2 = key(b.x2, b.y2);
        const pk = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (seen.has(pk)) add('Doppelter Balken', { beam: i });
        seen.add(pk);
        if (!nodeKeys.has(k1)) { nodeKeys.add(k1); nodeList.push([b.x1, b.y1]); }
        if (!nodeKeys.has(k2)) { nodeKeys.add(k2); nodeList.push([b.x2, b.y2]); }
      }
      for (let i = 0; i < nodeList.length; i++) {
        const msg = Bridge.checkNode(level, nodeList[i][0], nodeList[i][1]);
        if (msg) add(msg, { node: nodeList[i] });
      }
      return { ok: errors.length === 0, errors, details };
    },
    clone(bridge) {
      const beams = (bridge && bridge.beams) || [];
      return { beams: beams.map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m })) };
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

  function makeBeam(a, b, mat, rest, debris) {
    return {
      a: a, b: b, m: mat.key, rest: rest, force: 0, stress: 0, broken: false, debris: debris,
      // ---- internal ----
      mat: mat, strength: mat.strength, tensionOnly: mat.tensionOnly,
      at: (rest / mat.stiffness) / H2,   // XPBD compliance α̃ = α / h², α = rest / EA
      lam: 0, nx: 0, ny: 0, om: 0, src: -1,
      pa: null, pb: null,            // drivable beams: fillet partner at end a / b (see rebuildLists)
    };
  }

  function smooth01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  function createSim(level, bridge, opts) {
    opts = opts || {};
    level = level || {};
    const T = prepTerrain(level.ground || []);
    const water = (typeof level.water === 'number' && isFinite(level.water)) ? level.water : null;
    const anchors = Array.isArray(level.anchors) ? level.anchors : [];
    let minAnchorY = Infinity;
    for (let i = 0; i < anchors.length; i++) if (anchors[i][1] < minAnchorY) minAnchorY = anchors[i][1];
    if (minAnchorY === Infinity) minAnchorY = 0;
    const fallY = (typeof level.fallY === 'number' && isFinite(level.fallY)) ? level.fallY
      : (water !== null ? water : minAnchorY - 6);

    const sim = {
      level: level, t: 0, status: 'running', reason: null,
      particles: [], joints: [], beams: [], vehicles: [], events: [],
      _s: null,
    };
    const vehicleKeys = (Array.isArray(opts.vehicles) ? opts.vehicles : (Array.isArray(level.vehicles) ? level.vehicles : []))
      .filter((k) => !!VEHICLES[k]);
    const S = {
      T: T, water: water, fallY: fallY,
      killY: Math.min(T.minY, water !== null ? water : T.minY) - 30,
      frame: 0,
      active: [],          // simulated particles (w > 0, on)
      nodes: [],           // bridge node + debris particles (kind 0)
      live: [],            // beams that are solved (intact + debris)
      intact: [],          // intact, non-debris beams (break test)
      drivable: [],        // intact drivable beams (wheel/body contact)
      liveVehicles: [],    // spawned, not removed vehicles
      dirty: true,
      maxStress: 0, maxStressBeam: null, brokenCount: 0, finished: 0,
      nextVehicle: 0,
      startX: typeof level.startX === 'number' ? level.startX : 0,
      flagX: typeof level.flagX === 'number' ? level.flagX : 0,
      timeout: TUNING.TIMEOUT_BASE + TUNING.TIMEOUT_PER_VEHICLE * vehicleKeys.length,
      lastSplashT: -1e9, lastSplashX: 0,
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
    const getNode = (x, y) => {
      const k = key(x, y);
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
    const beamsIn = (bridge && Array.isArray(bridge.beams)) ? bridge.beams : [];
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
      const a = getNode(x1, y1), b = getNode(x2, y2);
      const beam = makeBeam(a, b, mat, len, false);
      beam.src = i;
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
    for (let i = 0; i < vehicleKeys.length; i++) sim.vehicles.push(buildVehicle(S, VEHICLES[vehicleKeys[i]], i));
    spawnNext(sim, S);     // first vehicle stands at the start from t = 0
    rebuildLists(sim, S);
    return sim;
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

  function spawnNext(sim, S) {
    if (S.nextVehicle >= sim.vehicles.length) return;
    const v = sim.vehicles[S.nextVehicle++];
    placeVehicle(S, v, S.startX);
    v.state = 'driving'; v.visible = true;
    v.bestX = S.startX; v.progT = Math.max(sim.t, TUNING.DRIVE_START);
    for (let i = 0; i < 4; i++) { v.body[i].on = true; sim.particles.push(v.body[i]); }
    for (let i = 0; i < v.wheels.length; i++) { v.wheels[i].p.on = true; sim.particles.push(v.wheels[i].p); }
    S.dirty = true;
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
    S.live.length = 0; S.intact.length = 0; S.drivable.length = 0;
    for (let i = 0; i < sim.beams.length; i++) {
      const b = sim.beams[i];
      if (b.broken) continue;
      S.live.push(b);
      if (!b.debris) {
        S.intact.push(b);
        if (b.mat.drivable) S.drivable.push(b);
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
      if (o.removed || o.state === 'waiting') continue;
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

    // 1) predict
    for (let i = 0; i < n; i++) {
      const p = act[i];
      p.ox = p.x; p.oy = p.y;
      let g = p.kind === K_NODE ? gBridge : G;
      if (hasWater && p.y < water) g *= buoy;
      p.vy -= g * H;
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
      const P = vr * fb / ws;
      const dev = bm.om - 0.5 * (a.om / a.omc + b.om / b.omc);
      const Q = dev * bm.rest * fr / ws;      // perpendicular impulse, perp = (-ny, nx)
      const jx = P * nx - Q * ny, jy = P * ny + Q * nx;
      a.vx += a.w * jx; a.vy += a.w * jy;
      b.vx -= b.w * jx; b.vy -= b.w * jy;
    }
    // 6b) suspension damping, drive / brake, friction
    for (let vi = 0; vi < lv.length; vi++) vehicleVelocityPass(lv[vi]);
    for (let i = 0; i < nodes.length; i++) { const p = nodes[i]; if (p.cbest > 0) frictionPass(p); }
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

  function vehicleVelocityPass(v) {
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
          const lim = TUNING.TRACTION * p.clam / H2;
          if (f > lim) f = lim; else if (f < -lim) f = -lim;
          let tx = p.cny, ty = -p.cnx;
          if (tx * ex + ty * ey < 0) { tx = -tx; ty = -ty; }
          applyTangential(p, f * H, tx, ty);
        }
      }
    }
    for (let i = 0; i < 4; i++) if (v.body[i].cbest > 0) frictionPass(v.body[i]);
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
  function frictionPass(p) {
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
    const maxJ = TUNING.FRICTION * p.clam / H;
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
      const st = Math.abs(b.force) / b.strength;
      b.stress = st;
      if (running && S.frame > 1 && st > S.maxStress) { S.maxStress = st; S.maxStressBeam = b; }
      if (st > 1) (toBreak || (toBreak = [])).push(b);
    }
    if (toBreak) {
      for (let i = 0; i < toBreak.length; i++) breakBeam(sim, S, toBreak[i]);
      if (sim.status === 'running') { sim.status = 'failed'; sim.reason = 'break'; }
    }

    // ---- vehicles
    let crashed = false, stuck = false;
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
        if (cy < S.fallY || wet || flipped) {
          v.state = 'crashed';
          sim.events.push({ type: 'crash', index: i });
          if (wet || (S.water !== null && cy < S.fallY)) splash(sim, S, v.pose.x);
          crashed = true;
        } else if (rearX > S.flagX) {
          v.state = 'finished';
          S.finished++;
          sim.events.push({ type: 'finish', index: i });
        } else if (sim.t > TUNING.DRIVE_START) {
          if (frontX > v.bestX + TUNING.STUCK_DIST) { v.bestX = frontX; v.progT = sim.t; }
          else if (sim.t - v.progT > TUNING.STUCK_TIME) stuck = true;
        }
      }
      if (v.state === 'finished' && rearX > S.flagX + TUNING.REMOVE_DIST) {
        v.removed = true; v.visible = false;
        for (let k = 0; k < 4; k++) v.body[k].on = false;
        for (let k = 0; k < v.wheels.length; k++) v.wheels[k].p.on = false;
        S.dirty = true;
      }
      void L;
    }
    // spawn the next vehicle when there is room
    if (sim.status === 'running' && S.nextVehicle < sim.vehicles.length) {
      const prev = sim.vehicles[S.nextVehicle - 1];
      const rear = prev ? Math.min(prev.body[0].x, prev.body[3].x) : Infinity;
      if (!prev || prev.removed || rear >= S.startX + TUNING.SPAWN_GAP) spawnNext(sim, S);
    }

    // ---- freeze particles that fell far below everything
    for (let i = 0; i < S.active.length; i++) {
      const p = S.active[i];
      if (p.y < S.killY) { p.on = false; p.vx = p.vy = 0; S.dirty = true; }
    }

    // ---- status
    if (sim.status === 'running') {
      if (crashed) { sim.status = 'failed'; sim.reason = 'fall'; }
      else if (stuck) { sim.status = 'failed'; sim.reason = 'stuck'; }
      else if (sim.vehicles.length > 0 && S.finished === sim.vehicles.length) { sim.status = 'won'; }
      else if (sim.vehicles.length === 0 && sim.t >= TUNING.EMPTY_WIN_TIME) { sim.status = 'won'; }
      else if (sim.t >= S.timeout) { sim.status = 'failed'; sim.reason = 'timeout'; }
    }
  }

  // ==================================================================== run
  function summary(sim) {
    const S = sim._s;
    return {
      status: sim.status, reason: sim.reason, time: sim.t,
      maxStress: S.maxStress, brokenCount: S.brokenCount, finished: S.finished,
      maxStressBeam: S.maxStressBeam ? S.maxStressBeam.src : -1,
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

  const RESULT_TEXT = {
    break: 'Die Brücke ist eingestürzt!',
    fall: 'Ein Fahrzeug ist abgestürzt!',
    stuck: 'Ein Fahrzeug steckt fest.',
    timeout: 'Die Zeit ist abgelaufen.',
  };

  BB.MATERIALS = MATERIALS;
  BB.MATERIAL_ORDER = MATERIAL_ORDER;
  BB.VEHICLES = VEHICLES;
  BB.VEHICLE_ORDER = VEHICLE_ORDER;
  BB.Terrain = Terrain;
  BB.Bridge = Bridge;
  BB.Physics = {
    FRAME_DT: FRAME_DT,
    SUBSTEPS: SUBSTEPS,
    TUNING: TUNING,
    createSim: createSim,
    step: step,
    run: run,
    summary: summary,
    resultText(reason) {
      if (reason === null || reason === undefined) return 'Geschafft!';
      return RESULT_TEXT[reason] || 'Die Testfahrt ist fehlgeschlagen.';
    },
  };
})(globalThis.BB = globalThis.BB || {});
