/*
 * Brückenbauer – weekly.js
 * ----------------------------------------------------------------------------
 * The weekly challenge: one level per calendar week, made offline from the date. Everybody gets the
 * same level in the same week. The level comes from a pool of parameter sets that were checked
 * automatically with the real physics (see tools): each one has a sample solution that wins with
 * 3 stars, keeps every beam below 85 % load and fails without a bridge.
 *
 *   BB.Weekly.weekKey(date)   -> '2026-W42' (ISO week)
 *   BB.Weekly.build(key)      -> level object { id: 'weekly-…', …, solution, budget }
 *
 * No DOM access, loadable in Node (after physics.js / levels.js).
 */
(function (BB) {
  'use strict';

  var VEH = { b: 'bike', m: 'motorcycle', c: 'car', B: 'bus', T: 'truck', K: 'tanker' };
  var THEMES = ['gruene-huegel', 'wuesten-canyon', 'herbstwald', 'hafenstadt', 'winterberge', 'federpark', 'werkshof', 'vulkaninsel', 'schienenland', 'himmelsstadt', 'tropeninsel', 'industrie-nacht'];
  var VARIANTS = [
    { road: 'road', strut: 'wood' },
    { road: 'road', strut: 'steel' },
    { road: 'steelroad', strut: 'steel' },
  ];

  function key(x, y) { return x + ',' + y; }
  function dedupe(beams) {
    var seen = {}, out = [];
    beams.forEach(function (b) {
      if (b.x1 === b.x2 && b.y1 === b.y2) return;
      var k1 = key(b.x1, b.y1), k2 = key(b.x2, b.y2);
      var pk = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
      if (!seen[pk]) { seen[pk] = 1; out.push(b); }
    });
    return out;
  }
  function within(len, mat) { var m = BB.MATERIALS && BB.MATERIALS[mat]; return len <= ((m && m.maxLength) || 4) + 1e-6; }

  /**
   * Truss between the two bank anchors of a generated canyon level (optionally through rock pillars):
   * a straight deck, a lower chord 2 m below it, verticals and both diagonals in every panel.
   */
  function trussSolution(level, variant) {
    var v = VARIANTS[variant] || VARIANTS[0];
    var roadMat = v.road, strutMat = v.strut;
    var anchors = level.anchors;
    var xs = anchors.map(function (p) { return p[0]; });
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var bankL = anchors.filter(function (p) { return p[0] === xMin; }).sort(function (a, b) { return b[1] - a[1]; })[0];
    var bankR = anchors.filter(function (p) { return p[0] === xMax; }).sort(function (a, b) { return b[1] - a[1]; })[0];
    var xl = bankL[0], yl = bankL[1], xr = bankR[0], yr = bankR[1];
    var maxLen = BB.MATERIALS[roadMat].maxLength;
    var span = xr - xl, rise = yr - yl;
    var N = Math.max(1, Math.ceil(Math.hypot(span, rise) / maxLen)), px, py, i;
    for (;;) {
      px = []; py = [];
      for (i = 0; i <= N; i++) { px.push(Math.round(xl + span * i / N)); py.push(Math.round(yl + rise * i / N)); }
      px[0] = xl; py[0] = yl; px[N] = xr; py[N] = yr;
      var ok = true;
      for (i = 0; i < N && ok; i++) ok = within(Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]), roadMat);
      if (ok) break;
      N++;
    }
    var beams = [];
    for (i = 0; i < N; i++) beams.push({ x1: px[i], y1: py[i], x2: px[i + 1], y2: py[i + 1], m: roadMat });
    var lowL = anchors.filter(function (p) { return p[0] === xl && p[1] < yl - 0.01; })[0];
    var lowR = anchors.filter(function (p) { return p[0] === xr && p[1] < yr - 0.01; })[0];
    var pillars = anchors.filter(function (p) { return p[0] > xl + 0.01 && p[0] < xr - 0.01 && p[1] < Math.min(yl, yr) - 0.01; });
    var lower = [];
    if (lowL) lower.push([xl, lowL[1]]);
    for (i = 1; i < N; i++) lower.push([px[i], py[i] - 2]);
    if (lowR) lower.push([xr, lowR[1]]);
    if (lowL || lowR || pillars.length) {
      for (i = 0; i + 1 < lower.length; i++) {
        var a = lower[i], b = lower[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > 1e-6 && within(len, strutMat)) beams.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], m: strutMat });
      }
      for (i = 0; i <= N; i++) {
        for (var q = 0; q < lower.length; q++) {
          var l2 = Math.hypot(px[i] - lower[q][0], py[i] - lower[q][1]);
          if (l2 > 1e-6 && within(l2, strutMat)) beams.push({ x1: px[i], y1: py[i], x2: lower[q][0], y2: lower[q][1], m: strutMat });
        }
      }
      pillars.forEach(function (pp) {
        for (i = 0; i <= N; i++) {
          var l3 = Math.hypot(px[i] - pp[0], py[i] - pp[1]);
          if (l3 > 1e-6 && within(l3, strutMat)) beams.push({ x1: pp[0], y1: pp[1], x2: px[i], y2: py[i], m: strutMat });
        }
      });
    }
    return { beams: dedupe(beams) };
  }

  // [span, heightDiff, rocks, water, vehicles, wind, ice, variant, seed]
  var POOL = [
    /*POOL-BEGIN*/
    [18,3,0,1,"Tm",0,0,2,76202],
    [18,-1,1,1,"cT",0,0,1,13172],
    [29,-1,1,1,"BBmm",3,0,1,79741],
    [16,-1,1,1,"cmcb",0,0,2,86850],
    [13,-1,1,1,"ccB",0,0,1,40973],
    [27,-4,2,1,"mc",0,0,0,17514],
    [17,3,0,1,"BTTc",0,1,1,72518],
    [14,1,1,1,"KB",0,1,1,10432],
    [25,-1,1,1,"Kc",2,0,1,62745],
    [27,0,1,1,"bB",0,1,1,58005],
    [14,-4,1,1,"TmmK",0,0,1,4085],
    [18,-2,0,1,"Tb",0,0,2,36822],
    [19,-4,1,1,"Tc",0,0,1,9723],
    [35,0,2,1,"cKc",0,0,1,65780],
    [12,-1,0,0,"cKcc",0,1,1,40348],
    [34,-1,1,1,"bKcb",0,0,2,28308],
    [13,-3,1,0,"mcK",0,0,1,18581],
    [16,1,1,1,"cmm",0,0,0,15567],
    [18,-1,1,0,"BmBm",0,0,1,99516],
    [25,-3,1,1,"KB",0,0,1,98750],
    [30,-2,2,0,"BBcB",0,0,1,11934],
    [27,-2,1,1,"Bbc",0,0,2,63672],
    [13,-1,0,1,"mcK",0,0,1,62024],
    [20,0,1,1,"cc",0,0,1,79358],
    [35,-3,2,1,"mB",0,0,1,10557],
    [14,2,1,1,"mcmT",0,0,1,45587],
    [16,3,0,0,"Kcb",0,0,2,89241],
    [28,-3,1,1,"BB",0,0,1,59202],
    [14,0,0,1,"bbc",0,0,1,26519],
    [18,-1,0,1,"BK",0,0,2,67763],
    [26,1,1,0,"KB",0,1,1,15327],
    [28,-2,1,1,"cBKm",0,0,1,62769],
    [14,4,0,1,"bT",0,0,1,46262],
    [24,3,0,1,"cb",0,0,1,97774],
    [28,3,2,1,"ccm",0,1,1,99326],
    [14,4,1,1,"bTB",0,0,1,91364],
    [34,-1,2,1,"bmcm",0,0,2,26032],
    [26,3,2,1,"ccK",0,0,2,28453],
    [27,-1,2,1,"bmm",2,0,2,17146],
    [35,-3,2,1,"mKB",0,0,1,88752],
    [26,0,2,1,"cKb",2,0,1,20468],
    [33,0,2,1,"KBb",0,0,1,84711],
    [16,4,1,1,"KbKT",0,0,1,52867],
    [21,4,1,1,"Bcmm",0,0,1,73064],
    [16,-3,0,1,"KmB",3,0,2,96625],
    [12,0,1,1,"Bbc",0,0,1,64335],
    [19,-1,1,1,"Tc",0,0,1,56479],
    [19,-1,1,1,"cc",0,0,1,65163],
    [26,1,2,1,"bmc",3,0,2,53850],
    [33,-2,1,0,"BcB",0,0,1,92392],
    [29,-2,1,1,"Bbb",0,0,2,79086],
    [18,3,0,1,"BK",0,0,2,25420],
    [13,4,0,1,"mm",0,0,2,53437],
    [25,0,2,1,"Bcb",0,0,1,34434],
    [20,3,1,1,"bTTT",0,0,1,14788],
    [28,-4,1,1,"cBmc",0,0,1,59897],
    [12,2,0,1,"BcTT",0,0,1,34406],
    [19,-2,0,1,"KmK",0,0,2,23455],
    [35,0,1,0,"mK",2,0,2,73387],
    [31,4,1,1,"bB",0,0,1,65833],
    [27,-4,2,1,"Bcmc",0,0,1,50126],
    [21,3,1,0,"bK",0,0,1,81445],
    [34,-3,1,1,"cBK",0,0,2,53416],
    [22,-1,1,0,"ccB",0,0,1,43510]
    /*POOL-END*/
  ];

  function hashString(s) {
    var h = 2166136261 | 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 16;
    return h >>> 0;
  }

  /** ISO-8601 week key of a date, e.g. '2026-W42' (weeks start on Monday). */
  function weekKey(date) {
    var d = new Date(Date.UTC((date || new Date()).getFullYear(), (date || new Date()).getMonth(), (date || new Date()).getDate()));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
  }

  function entryFor(wk) { return POOL[hashString('brueckenbauer-' + wk) % Math.max(1, POOL.length)]; }

  function levelFrom(e, id, name, theme) {
    var vehicles = e[4].split('').map(function (c) { return VEH[c]; });
    var L = BB.Levels.generate({
      id: id, name: name, span: e[0], heightDiff: e[1], rocks: e[2], water: !!e[3], vehicles: vehicles,
      wind: e[5] || 0, ice: !!e[6], seed: e[8] | 0, lowAnchors: true, highAnchors: false, budget: 1,
    });
    L.world = theme;
    L.solution = trussSolution(L, e[7]);
    var cost = BB.Bridge.cost(L.solution);
    L.budget = Math.max(1000, Math.round(cost * 1.6 / 50) * 50);
    return L;
  }

  /** The level of a given week (deterministic). */
  function build(wk) {
    var e = entryFor(wk);
    var theme = THEMES[hashString('theme-' + wk) % THEMES.length];
    var L = levelFrom(e, 'weekly-' + wk, 'Wöchentliche Herausforderung', theme);
    L.seed = hashString(wk) | 0;
    L.description = 'Die Aufgabe der Woche (' + wk.replace('-W', ' · Woche ') + ') – diese Woche baut jeder dieselbe Brücke. Spannweite ' + e[0] + ' m' + (e[5] ? ', mit Wind' : '') + (e[6] ? ', auf glatter Fahrbahn' : '') + '.';
    return L;
  }

  BB.Weekly = { weekKey: weekKey, build: build, entryFor: entryFor, levelFrom: levelFrom, trussSolution: trussSolution, POOL: POOL, VEH: VEH, THEMES: THEMES, hashString: hashString };
})(globalThis.BB = globalThis.BB || {});
