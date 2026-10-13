/*
 * Brückenbauer – editor.js
 * Pure editing logic for bridges (SPEC §8) and a few level-editor helpers.
 * No DOM access: this file is loadable in Node (vm.runInThisContext) after physics.js / levels.js.
 *
 *   const ed = BB.Editor.create(level, bridge, { onChange(bridge) })
 *   ed.bridge, ed.material, ed.tool ('build' | 'delete'), ed.preview, ed.drag, ed.lastError
 *   ed.nodeAt / beamAt / startDrag / moveDrag / endDrag / cancelDrag
 *   ed.beginErase / eraseAt / endErase      (one erase drag = one undo step)
 *   ed.undo / redo / canUndo / canRedo / clear / cost / setBridge
 *
 *   BB.Editor.allowedMaterials(level)       -> material keys usable in the level (MATERIAL_ORDER order)
 *   BB.Editor.sanitize(level, bridge)       -> { bridge, removed } (drops beams that break the building rules)
 *   BB.Editor.levelTools                    -> helpers used by the level editor (anchors / ground vertices)
 */
(function (BB) {
  'use strict';

  var UNDO_LIMIT = 200;   // max. remembered undo steps
  var EPS = 1e-6;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function nodeKey(x, y) { return x + ',' + y; }

  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  /** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
  function distToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return dist(px, py, ax + vx * t, ay + vy * t);
  }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  function cloneBridge(bridge) {
    var beams = (bridge && Array.isArray(bridge.beams)) ? bridge.beams : [];
    var out = [];
    for (var i = 0; i < beams.length; i++) {
      var b = beams[i];
      if (!b) continue;
      out.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m });
    }
    return { beams: out };
  }

  function getMaterial(key) {
    var M = BB.MATERIALS;
    return (M && Object.prototype.hasOwnProperty.call(M, key)) ? M[key] : null;
  }

  function beamLength(b) { return dist(b.x1, b.y1, b.x2, b.y2); }

  function sameEnds(b, x1, y1, x2, y2) {
    return (b.x1 === x1 && b.y1 === y1 && b.x2 === x2 && b.y2 === y2) ||
           (b.x1 === x2 && b.y1 === y2 && b.x2 === x1 && b.y2 === y1);
  }

  /** Material keys allowed in the level, in BB.MATERIAL_ORDER order. */
  function allowedMaterials(level) {
    var M = BB.MATERIALS || {};
    var order = (Array.isArray(BB.MATERIAL_ORDER) && BB.MATERIAL_ORDER.length) ? BB.MATERIAL_ORDER : Object.keys(M);
    var list = (level && Array.isArray(level.materials) && level.materials.length) ? level.materials : null;
    return order.filter(function (k) { return !!M[k] && (!list || list.indexOf(k) >= 0); });
  }

  function isAnchor(level, x, y) {
    var a = (level && level.anchors) || [];
    for (var i = 0; i < a.length; i++) if (a[i][0] === x && a[i][1] === y) return true;
    return false;
  }

  // --- Terrain fallbacks (only used when physics.js / BB.Terrain is not loaded) ---
  function fbSurfaceY(ground, x) {
    var best = -Infinity;
    for (var i = 0; i + 1 < ground.length; i++) {
      var a = ground[i], b = ground[i + 1];
      if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
      var y = (b[0] === a[0]) ? Math.max(a[1], b[1]) : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      if (y > best) best = y;
    }
    return best;
  }
  function fbDistance(ground, x, y) {
    var best = Infinity;
    for (var i = 0; i + 1 < ground.length; i++) {
      var d = distToSegment(x, y, ground[i][0], ground[i][1], ground[i + 1][0], ground[i + 1][1]);
      if (d < best) best = d;
    }
    return best;
  }
  function terrainInside(ground, x, y) {
    if (!ground || ground.length < 2) return false;
    if (BB.Terrain && typeof BB.Terrain.inside === 'function') return !!BB.Terrain.inside(ground, x, y);
    return y < fbSurfaceY(ground, x) - EPS && fbDistance(ground, x, y) > EPS;
  }
  function terrainDistance(ground, x, y) {
    if (!ground || ground.length < 2) return Infinity;
    if (BB.Terrain && typeof BB.Terrain.distance === 'function') return BB.Terrain.distance(ground, x, y);
    return fbDistance(ground, x, y);
  }

  /** null if (x,y) may hold a bridge node, otherwise a German reason. Anchors are always fine. */
  function checkNode(level, x, y) {
    if (isAnchor(level, x, y)) return null;
    if (BB.Bridge && typeof BB.Bridge.checkNode === 'function') return BB.Bridge.checkNode(level, x, y) || null;
    var b = level && level.build;
    if (b && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) return 'Außerhalb des Baubereichs';
    if (level && level.ground) {
      if (terrainInside(level.ground, x, y)) return 'Der Punkt liegt im Gelände';
      if (terrainDistance(level.ground, x, y) < 0.5 - EPS) return 'Zu nah am Boden';
    }
    return null;
  }

  function fmtLen(v) { return String(Math.round(v * 10) / 10).replace('.', ','); }

  /**
   * Checks a candidate beam against the building rules. The beam list is used to detect an
   * identical existing beam (same endpoints and same material → nothing to do).
   */
  function checkBeam(level, beams, x1, y1, x2, y2, m) {
    var allowed = allowedMaterials(level);
    var mat = getMaterial(m);
    if (!mat || allowed.indexOf(m) < 0) return 'Dieses Material ist hier nicht erlaubt';
    var len = dist(x1, y1, x2, y2);
    if (!(len > EPS)) return 'Der Balken ist zu kurz';
    if (len > mat.maxLength + EPS) return 'Zu lang – ' + mat.name + ' ist höchstens ' + fmtLen(mat.maxLength) + ' m lang';
    var r = checkNode(level, x1, y1) || checkNode(level, x2, y2);
    if (r) return r;
    for (var i = 0; i < beams.length; i++) {
      if (sameEnds(beams[i], x1, y1, x2, y2) && beams[i].m === m) return 'Diesen Balken gibt es schon';
    }
    return null;
  }

  /** Removes beams that violate the building rules (e.g. a saved bridge of a level that changed). */
  function sanitize(level, bridge) {
    var src = cloneBridge(bridge).beams, out = [], removed = 0;
    for (var i = 0; i < src.length; i++) {
      var b = src[i];
      var okCoords = isInt(b.x1) && isInt(b.y1) && isInt(b.x2) && isInt(b.y2);
      var dup = false;
      for (var j = 0; okCoords && j < out.length; j++) if (sameEnds(out[j], b.x1, b.y1, b.x2, b.y2)) { dup = true; break; }
      if (!okCoords || dup || checkBeam(level, [], b.x1, b.y1, b.x2, b.y2, b.m)) { removed++; continue; }
      out.push(b);
    }
    return { bridge: { beams: out }, removed: removed };
  }

  // ---------------------------------------------------------------------------
  // Bridge editor
  // ---------------------------------------------------------------------------
  function create(level, bridge, opts) {
    opts = opts || {};
    var undoStack = [], redoStack = [];
    var erasing = false, eraseDirty = false;

    var ed = {
      level: level,
      bridge: cloneBridge(bridge),
      material: 'road',
      tool: 'build',
      preview: null,      // { x1,y1,x2,y2, m, valid, length, reason }
      drag: null,         // { x, y } start node of the current build drag
      lastError: null,    // German reason of the last rejected endDrag()
      lastAction: null,   // 'add' | 'replace' after a successful endDrag()
    };

    var allowed = allowedMaterials(level);
    if (allowed.length && allowed.indexOf(ed.material) < 0) ed.material = allowed[0];

    function changed() {
      if (typeof opts.onChange === 'function') opts.onChange(ed.bridge);
    }
    function pushUndo() {
      undoStack.push(cloneBridge(ed.bridge));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }
    function findBeam(x1, y1, x2, y2) {
      var beams = ed.bridge.beams;
      for (var i = 0; i < beams.length; i++) if (sameEnds(beams[i], x1, y1, x2, y2)) return i;
      return -1;
    }

    /** All nodes: anchors first, then beam endpoints (unique). */
    ed.nodes = function () {
      var seen = Object.create(null), out = [];
      function add(x, y) {
        var k = nodeKey(x, y);
        if (seen[k]) return;
        seen[k] = true;
        out.push({ x: x, y: y, anchor: isAnchor(level, x, y) });
      }
      var a = level.anchors || [];
      for (var i = 0; i < a.length; i++) add(a[i][0], a[i][1]);
      var beams = ed.bridge.beams;
      for (var j = 0; j < beams.length; j++) { add(beams[j].x1, beams[j].y1); add(beams[j].x2, beams[j].y2); }
      return out;
    };

    /** Nearest node within tol (world meters) or null. */
    ed.nodeAt = function (wx, wy, tol) {
      if (tol == null) tol = 0.5;
      var nodes = ed.nodes(), best = null, bestD = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var d = dist(wx, wy, nodes[i].x, nodes[i].y);
        if (d <= tol && d < bestD) { bestD = d; best = nodes[i]; }
      }
      return best ? { x: best.x, y: best.y, anchor: best.anchor } : null;
    };

    /** Index of the beam nearest to the point within tol, or -1. Later (top-most) beams win ties. */
    ed.beamAt = function (wx, wy, tol) {
      if (tol == null) tol = 0.5;
      var beams = ed.bridge.beams, best = -1, bestD = Infinity;
      for (var i = beams.length - 1; i >= 0; i--) {
        var b = beams[i];
        var d = distToSegment(wx, wy, b.x1, b.y1, b.x2, b.y2);
        if (d <= tol && d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    ed.canBuild = function () { return allowed.indexOf(ed.material) >= 0; };

    ed.startDrag = function (wx, wy, tol) {
      ed.lastError = null;
      if (ed.tool !== 'build') return false;
      var n = ed.nodeAt(wx, wy, tol);
      if (!n) return false;
      ed.drag = { x: n.x, y: n.y };
      ed.preview = null;
      return true;
    };

    /**
     * Snapped end point for a drag from (sx,sy) towards the pointer (wx,wy): the nearest grid point,
     * or – if that is farther than maxLength – the grid point within maxLength closest to the pointer.
     */
    ed.snapEnd = function (sx, sy, wx, wy, maxLength) {
      var gx = Math.round(wx), gy = Math.round(wy);
      if (dist(gx, gy, sx, sy) <= maxLength + EPS) return [gx, gy];
      var R = Math.floor(maxLength + EPS), r2 = maxLength * maxLength + EPS;
      var best = [sx, sy], bestD = Infinity, bestL = -1;
      for (var dx = -R; dx <= R; dx++) {
        for (var dy = -R; dy <= R; dy++) {
          var l2 = dx * dx + dy * dy;
          if (l2 > r2 || l2 === 0) continue;
          var px = sx + dx, py = sy + dy;
          var d = (px - wx) * (px - wx) + (py - wy) * (py - wy);
          // closest to the pointer; on (near) ties prefer the longer beam for a stable result
          if (d < bestD - EPS || (Math.abs(d - bestD) <= EPS && l2 > bestL)) { bestD = d; bestL = l2; best = [px, py]; }
        }
      }
      return best;
    };

    ed.moveDrag = function (wx, wy) {
      if (!ed.drag) return;
      var mat = getMaterial(ed.material);
      var maxL = mat ? mat.maxLength : 1;
      var s = ed.drag;
      var e = ed.snapEnd(s.x, s.y, wx, wy, maxL);
      if (e[0] === s.x && e[1] === s.y) { ed.preview = null; return; }
      var reason = checkBeam(level, ed.bridge.beams, s.x, s.y, e[0], e[1], ed.material);
      ed.preview = {
        x1: s.x, y1: s.y, x2: e[0], y2: e[1], m: ed.material,
        valid: !reason, length: dist(s.x, s.y, e[0], e[1]), reason: reason,
      };
    };

    ed.endDrag = function () {
      var p = ed.preview, d = ed.drag;
      ed.drag = null; ed.preview = null; ed.lastError = null; ed.lastAction = null;
      if (!d || !p) return false;
      if (!p.valid) { ed.lastError = p.reason || 'Hier kann kein Balken gebaut werden'; return false; }
      var idx = findBeam(p.x1, p.y1, p.x2, p.y2);
      pushUndo();
      if (idx >= 0) { ed.bridge.beams[idx].m = p.m; ed.lastAction = 'replace'; }
      else { ed.bridge.beams.push({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, m: p.m }); ed.lastAction = 'add'; }
      changed();
      return true;
    };

    ed.cancelDrag = function () { ed.drag = null; ed.preview = null; };

    // --- Erasing: beginErase() … eraseAt()* … endErase() is one undo step ---
    ed.beginErase = function () { erasing = true; eraseDirty = false; ed.cancelDrag(); };
    ed.endErase = function () { erasing = false; eraseDirty = false; };
    ed.eraseAt = function (wx, wy, tol) {
      var i = ed.beamAt(wx, wy, tol);
      if (i < 0) return false;
      if (!erasing || !eraseDirty) pushUndo();   // the first erase of a group creates the undo step
      if (erasing) eraseDirty = true;
      ed.bridge.beams.splice(i, 1);
      changed();
      return true;
    };

    // --- History ---
    ed.canUndo = function () { return undoStack.length > 0; };
    ed.canRedo = function () { return redoStack.length > 0; };
    ed.undo = function () {
      if (!undoStack.length) return false;
      ed.cancelDrag();
      redoStack.push(cloneBridge(ed.bridge));
      ed.bridge.beams = undoStack.pop().beams;
      eraseDirty = false;
      changed();
      return true;
    };
    ed.redo = function () {
      if (!redoStack.length) return false;
      ed.cancelDrag();
      undoStack.push(cloneBridge(ed.bridge));
      ed.bridge.beams = redoStack.pop().beams;
      eraseDirty = false;
      changed();
      return true;
    };

    /** Removes all beams (one undo step). */
    ed.clear = function () {
      ed.cancelDrag();
      if (!ed.bridge.beams.length) return false;
      pushUndo();
      ed.bridge.beams = [];
      changed();
      return true;
    };

    ed.cost = function () {
      if (BB.Bridge && typeof BB.Bridge.cost === 'function') return BB.Bridge.cost(ed.bridge);
      var sum = 0, beams = ed.bridge.beams;
      for (var i = 0; i < beams.length; i++) {
        var m = getMaterial(beams[i].m);
        if (m) sum += m.price * beamLength(beams[i]);
      }
      return Math.round(sum);
    };

    /** Replaces the bridge (e.g. when loading). Clears undo/redo and does NOT call onChange. */
    ed.setBridge = function (b) {
      ed.cancelDrag();
      ed.bridge.beams = cloneBridge(b).beams;
      undoStack.length = 0; redoStack.length = 0;
      erasing = false; eraseDirty = false;
    };

    ed.allowedMaterials = function () { return allowed.slice(); };

    return ed;
  }

  // ---------------------------------------------------------------------------
  // Level editor helpers (operate directly on a level object; integer grid)
  // ---------------------------------------------------------------------------
  var levelTools = {
    /** Index of the anchor nearest to (wx,wy) within tol, or -1. */
    anchorAt: function (level, wx, wy, tol) {
      var a = level.anchors || [], best = -1, bestD = Infinity;
      for (var i = 0; i < a.length; i++) {
        var d = dist(wx, wy, a[i][0], a[i][1]);
        if (d <= tol && d < bestD) { bestD = d; best = i; }
      }
      return best;
    },

    /** Adds an anchor at the grid point (x,y) or removes the one that is there. */
    toggleAnchor: function (level, x, y) {
      x = Math.round(x); y = Math.round(y);
      level.anchors = level.anchors || [];
      for (var i = 0; i < level.anchors.length; i++) {
        if (level.anchors[i][0] === x && level.anchors[i][1] === y) {
          level.anchors.splice(i, 1);
          return { ok: true, added: false };
        }
      }
      var b = level.build;
      if (b && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) return { ok: false, reason: 'Anker gehen nur im Baubereich' };
      if (terrainInside(level.ground, x, y)) return { ok: false, reason: 'Anker dürfen nicht im Gelände liegen' };
      level.anchors.push([x, y]);
      return { ok: true, added: true };
    },

    deleteAnchor: function (level, i) {
      if (!level.anchors || i < 0 || i >= level.anchors.length) return false;
      level.anchors.splice(i, 1);
      return true;
    },

    /** Index of the ground vertex nearest to (wx,wy) within tol, or -1. */
    vertexAt: function (level, wx, wy, tol) {
      var g = level.ground || [], best = -1, bestD = Infinity;
      for (var i = 0; i < g.length; i++) {
        var d = dist(wx, wy, g[i][0], g[i][1]);
        if (d <= tol && d < bestD) { bestD = d; best = i; }
      }
      return best;
    },

    /** Index i of the ground segment (i, i+1) nearest to the point within tol, or -1. */
    edgeAt: function (level, wx, wy, tol) {
      var g = level.ground || [], best = -1, bestD = Infinity;
      for (var i = 0; i + 1 < g.length; i++) {
        var d = distToSegment(wx, wy, g[i][0], g[i][1], g[i + 1][0], g[i + 1][1]);
        if (d <= tol && d < bestD) { bestD = d; best = i; }
      }
      return best;
    },

    /**
     * Inserts a ground vertex on the edge under the pointer (snapped to the grid, x order kept).
     * Returns { index, inserted } or null. If the snapped point is an existing vertex, its index is returned.
     */
    insertVertex: function (level, wx, wy, tol) {
      var g = level.ground || [];
      var i = levelTools.edgeAt(level, wx, wy, tol);
      if (i < 0) return null;
      var a = g[i], b = g[i + 1];
      var vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
      var t = len2 > 0 ? ((wx - a[0]) * vx + (wy - a[1]) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var x = Math.round(a[0] + vx * t), y = Math.round(a[1] + vy * t);
      if (x < a[0]) x = a[0];
      if (x > b[0]) x = b[0];
      if (x === a[0] && y === a[1]) return { index: i, inserted: false };
      if (x === b[0] && y === b[1]) return { index: i + 1, inserted: false };
      g.splice(i + 1, 0, [x, y]);
      return { index: i + 1, inserted: true };
    },

    /**
     * Moves ground vertex i to the grid point (x,y). x stays between the neighbours (x order), the
     * outermost vertices keep their x. Anchors sitting exactly on the vertex move with it.
     * Returns true if the vertex moved.
     */
    moveVertex: function (level, i, x, y, carryAnchors) {
      var g = level.ground || [];
      if (i < 0 || i >= g.length) return false;
      x = Math.round(x); y = Math.round(y);
      if (i === 0 || i === g.length - 1) x = g[i][0];
      else x = Math.max(g[i - 1][0], Math.min(g[i + 1][0], x));
      y = Math.max(-500, Math.min(500, y));
      var ox = g[i][0], oy = g[i][1];
      if (x === ox && y === oy) return false;
      // never let two neighbouring vertices coincide (zero-length ground segments)
      if ((i > 0 && g[i - 1][0] === x && g[i - 1][1] === y) || (i + 1 < g.length && g[i + 1][0] === x && g[i + 1][1] === y)) return false;
      g[i] = [x, y];
      if (carryAnchors !== false && level.anchors) {
        for (var k = 0; k < level.anchors.length; k++) {
          if (level.anchors[k][0] === ox && level.anchors[k][1] === oy) level.anchors[k] = [x, y];
        }
      }
      return true;
    },

    /** Deletes ground vertex i (not the outermost ones; at least 4 vertices stay). */
    deleteVertex: function (level, i) {
      var g = level.ground || [];
      if (i <= 0 || i >= g.length - 1 || g.length <= 4) return false;
      g.splice(i, 1);
      return true;
    },
  };

  BB.Editor = {
    create: create,
    allowedMaterials: allowedMaterials,
    sanitize: sanitize,
    checkBeam: checkBeam,
    checkNode: checkNode,
    cloneBridge: cloneBridge,
    levelTools: levelTools,
  };
})(globalThis.BB = globalThis.BB || {});
