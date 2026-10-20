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
  var clipboard = null;   // shared by all editors of the page: { w, h, beams:[{x1,y1,x2,y2,m,…}] relative to the lower-left corner }

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
      var c = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, m: b.m };
      if (b.s1) c.s1 = 1;
      if (b.s2) c.s2 = 1;
      if (Array.isArray(b.ph)) c.ph = b.ph.slice();
      out.push(c);
    }
    var res = { beams: out };
    if (bridge && Array.isArray(bridge.found) && bridge.found.length) {
      res.found = bridge.found.map(function (f) { return [f[0], f[1]]; });
    }
    return res;
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
    var out = order.filter(function (k) { return !!M[k] && (!list || list.indexOf(k) >= 0); });
    // materials that are not in the classic order (campaign "Zeitreise") only count when the level lists them
    if (list) list.forEach(function (k) { if (M[k] && out.indexOf(k) < 0 && k !== 'foundation') out.push(k); });
    return out;
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

  /** null if (x,y) may hold a bridge node, otherwise a German reason. Anchors are always fine.
   *  touchOk: allow the point to rest directly on the ground (concrete pillar foot). */
  function checkNode(level, x, y, touchOk) {
    if (isAnchor(level, x, y)) return null;
    if (BB.Bridge && typeof BB.Bridge.checkNode === 'function') return BB.Bridge.checkNode(level, x, y, touchOk) || null;
    var b = level && level.build;
    if (b && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) return 'Außerhalb des Baubereichs';
    if (level && level.ground) {
      if (terrainInside(level.ground, x, y)) return 'Der Punkt liegt im Gelände';
      if (!touchOk && terrainDistance(level.ground, x, y) < 0.5 - EPS) return 'Zu nah am Boden';
    }
    return null;
  }

  function groundSurfaceY(ground, x) {
    if (BB.Terrain && typeof BB.Terrain.surfaceY === 'function') return BB.Terrain.surfaceY(ground, x);
    return fbSurfaceY(ground, x);
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
    var r;
    if (mat.vertical) {
      if (x1 !== x2) return mat.name + ' müssen senkrecht stehen';
      var footY = Math.min(y1, y2), headY = Math.max(y1, y2);
      var footTouch = isAnchor(level, x1, footY);
      if (!footTouch && level && level.ground) {
        var surf = groundSurfaceY(level.ground, x1);
        footTouch = isFinite(surf) && Math.abs(footY - surf) <= 0.25;
      }
      // stacking onto an existing pillar segment (the new foot continues it downward) is fine
      if (!footTouch) {
        for (var si = 0; si < beams.length; si++) {
          var sb = beams[si], smat = getMaterial(sb.m);
          if (smat && smat.vertical && sb.x1 === x1 &&
              (Math.max(sb.y1, sb.y2) === footY || Math.min(sb.y1, sb.y2) === footY)) { footTouch = true; break; }
        }
      }
      if (!footTouch) return mat.name + ' braucht festen Boden am unteren Ende';
      r = checkNode(level, x1, footY, true) || checkNode(level, x1, headY);
      if (r) return r;
    } else {
      r = checkNode(level, x1, y1) || checkNode(level, x2, y2);
      if (r) return r;
    }
    if (BB.Bridge && BB.Bridge.crossesObstacle && BB.Bridge.crossesObstacle(level, x1, y1, x2, y2)) return 'Das kreuzt ein festes Hindernis';
    for (var i = 0; i < beams.length; i++) {
      if (sameEnds(beams[i], x1, y1, x2, y2) && beams[i].m === m) return 'Diesen Balken gibt es schon';
    }
    return null;
  }

  /** Removes beams / foundations that violate the building rules (e.g. a saved bridge of a level that changed). */
  function sanitize(level, bridge) {
    var cl = cloneBridge(bridge), src = cl.beams, out = [], removed = 0, found = [];
    var fsrc = cl.found || [];
    for (var f = 0; f < fsrc.length; f++) {
      var fx = fsrc[f][0];
      var okF = BB.Bridge && BB.Bridge.checkFoundation && isInt(fx) && BB.Bridge.foundationY(level, fx) === fsrc[f][1] &&
        !BB.Bridge.checkFoundation(level, { found: found }, fx);
      if (okF) found.push(fsrc[f]); else removed++;
    }
    var eff = BB.Bridge && BB.Bridge.effLevel ? BB.Bridge.effLevel(level, { found: found }) : level;
    for (var i = 0; i < src.length; i++) {
      var b = src[i];
      var okCoords = isInt(b.x1) && isInt(b.y1) && isInt(b.x2) && isInt(b.y2);
      var dup = false;
      for (var j = 0; okCoords && j < out.length; j++) if (sameEnds(out[j], b.x1, b.y1, b.x2, b.y2)) { dup = true; break; }
      if (!okCoords || dup || checkBeam(eff, [], b.x1, b.y1, b.x2, b.y2, b.m)) { removed++; continue; }
      out.push(b);
    }
    var res = { beams: out };
    if (found.length) res.found = found;
    return { bridge: res, removed: removed };
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
      snapGrid: true,     // true: ends snap to every grid point; false: only to existing joints and exactly hit grid points
    };

    var allowed = allowedMaterials(level);
    if (allowed.length && allowed.indexOf(ed.material) < 0) ed.material = allowed[0];
    // the level as seen by the building rules: its anchors plus the bridge's foundations
    function eff() { return (BB.Bridge && BB.Bridge.effLevel) ? BB.Bridge.effLevel(level, ed.bridge) : level; }

    function changed() {
      if (typeof opts.onChange === 'function') opts.onChange(ed.bridge);
    }
    function pushUndo() {
      undoStack.push(cloneBridge(ed.bridge));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }
    function applyState(st) {
      ed.bridge.beams = st.beams;
      if (st.found && st.found.length) ed.bridge.found = st.found; else delete ed.bridge.found;
    }
    function findBeam(x1, y1, x2, y2) {
      var beams = ed.bridge.beams;
      for (var i = 0; i < beams.length; i++) if (sameEnds(beams[i], x1, y1, x2, y2)) return i;
      return -1;
    }

    /** All nodes: anchors first, then beam endpoints (unique). */
    ed.nodes = function () {
      if (BB.Bridge && BB.Bridge.nodes) return BB.Bridge.nodes(ed.bridge, level);
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

    /**
     * The point a pointer at (wx, wy) snaps to: an existing joint within tolNode, else the nearest grid point
     * (grid snap on) or – with the grid snap off – only a grid point that is hit almost exactly. null = nothing to snap to.
     */
    ed.snapPoint = function (wx, wy, tolNode) {
      var n = ed.nodeAt(wx, wy, tolNode == null ? 0.9 : tolNode);
      if (n) return [n.x, n.y];
      var gx = Math.round(wx), gy = Math.round(wy);
      if (ed.snapGrid) return [gx, gy];
      return (Math.abs(wx - gx) < 0.28 && Math.abs(wy - gy) < 0.28) ? [gx, gy] : null;
    };

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
      if (!ed.snapGrid) { var sp = ed.snapPoint(wx, wy, 1.0); if (!sp) { ed.preview = null; return; } wx = sp[0]; wy = sp[1]; }
      var mat = getMaterial(ed.material);
      var maxL = mat ? mat.maxLength : 1;
      var s = ed.drag;
      var e = ed.snapEnd(s.x, s.y, wx, wy, maxL);
      if (e[0] === s.x && e[1] === s.y) { ed.preview = null; return; }
      var reason = checkBeam(eff(), ed.bridge.beams, s.x, s.y, e[0], e[1], ed.material);
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
      var nb = { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, m: p.m };
      if (getMaterial(p.m) && getMaterial(p.m).hyd) nb.ph = ['hold', 'out'];
      if (idx >= 0) { var old = ed.bridge.beams[idx]; ed.bridge.beams[idx] = nb; if (old.s1) nb.s1 = 1; if (old.s2) nb.s2 = 1; ed.lastAction = 'replace'; }
      else { ed.bridge.beams.push(nb); ed.lastAction = 'add'; }
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
      ed.clearSelection();
      changed();
      return true;
    };

    // --- History ---
    ed.canUndo = function () { return undoStack.length > 0; };
    ed.canRedo = function () { return redoStack.length > 0; };
    ed.undo = function () {
      if (!undoStack.length) return false;
      ed.cancelDrag(); ed.clearSelection();
      redoStack.push(cloneBridge(ed.bridge));
      applyState(undoStack.pop());
      eraseDirty = false;
      changed();
      return true;
    };
    ed.redo = function () {
      if (!redoStack.length) return false;
      ed.cancelDrag(); ed.clearSelection();
      undoStack.push(cloneBridge(ed.bridge));
      applyState(redoStack.pop());
      eraseDirty = false;
      changed();
      return true;
    };

    /** Removes all beams (one undo step). */
    ed.clear = function () {
      ed.cancelDrag();
      if (!ed.bridge.beams.length && !(ed.bridge.found && ed.bridge.found.length)) return false;
      pushUndo(); ed.clearSelection();
      ed.bridge.beams = [];
      delete ed.bridge.found;
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
      ed.cancelDrag(); ed.clearSelection();
      applyState(cloneBridge(b));
      undoStack.length = 0; redoStack.length = 0;
      erasing = false; eraseDirty = false;
    };

    ed.allowedMaterials = function () { return allowed.slice(); };

    // =================================================================================================
    // Selection, transforms, clipboard, trace tools (v3.2)
    // =================================================================================================
    ed.sel = [];            // indices into ed.bridge.beams (ascending)
    function fireSel() { if (typeof opts.onSelect === 'function') opts.onSelect(ed.sel); }
    function uniqSorted(list) {
      var seen = Object.create(null), out = [];
      for (var i = 0; i < list.length; i++) { var v = list[i]; if (v >= 0 && v < ed.bridge.beams.length && !seen[v]) { seen[v] = 1; out.push(v); } }
      out.sort(function (a, b) { return a - b; });
      return out;
    }
    ed.clearSelection = function () { if (ed.sel.length) { ed.sel = []; fireSel(); } };
    ed.setSelection = function (list) { ed.sel = uniqSorted(list || []); fireSel(); };
    ed.selectionCount = function () { return ed.sel.length; };
    ed.isSelected = function (i) { return ed.sel.indexOf(i) >= 0; };
    ed.selectAll = function () { var l = []; for (var i = 0; i < ed.bridge.beams.length; i++) l.push(i); ed.setSelection(l); return l.length; };
    function applySelMode(hit, mode) {
      var cur = ed.sel.slice();
      if (mode === 'add') ed.setSelection(cur.concat(hit));
      else if (mode === 'toggle') {
        hit.forEach(function (h) { var k = cur.indexOf(h); if (k >= 0) cur.splice(k, 1); else cur.push(h); });
        ed.setSelection(cur);
      } else ed.setSelection(hit);
    }
    /** mode: 'replace' (default) | 'add' | 'toggle'. Beams whose two ends are both inside the box. Returns how many were hit. */
    ed.selectBox = function (x0, y0, x1, y1, mode) {
      var ax = Math.min(x0, x1) - EPS, bx = Math.max(x0, x1) + EPS, ay = Math.min(y0, y1) - EPS, by = Math.max(y0, y1) + EPS, hit = [];
      var beams = ed.bridge.beams;
      for (var i = 0; i < beams.length; i++) {
        var b = beams[i];
        if (b.x1 >= ax && b.x1 <= bx && b.x2 >= ax && b.x2 <= bx && b.y1 >= ay && b.y1 <= by && b.y2 >= ay && b.y2 <= by) hit.push(i);
      }
      applySelMode(hit, mode);
      return hit.length;
    };
    /** Single beam under the pointer (nearest, top-most). Returns its index or -1. */
    ed.selectAt = function (wx, wy, tol, mode) {
      var i = ed.beamAt(wx, wy, tol == null ? 0.5 : tol);
      if (i < 0) { if (!mode || mode === 'replace') ed.clearSelection(); return -1; }
      applySelMode([i], mode);
      return i;
    };
    ed.selectionBounds = function () {
      if (!ed.sel.length) return null;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ed.sel.forEach(function (i) {
        var b = ed.bridge.beams[i];
        x0 = Math.min(x0, b.x1, b.x2); x1 = Math.max(x1, b.x1, b.x2); y0 = Math.min(y0, b.y1, b.y2); y1 = Math.max(y1, b.y1, b.y2);
      });
      return { x0: x0, y0: y0, x1: x1, y1: y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    };
    ed.selectionCost = function () {
      var sum = 0;
      ed.sel.forEach(function (i) { var b = ed.bridge.beams[i], m = getMaterial(b.m); if (m) sum += m.price * beamLength(b); });
      return Math.round(sum);
    };

    // --- validation of a set of beams (new positions of a selection, pasted beams, a traced curve) -----
    function sameEndsAny(list, b) {
      for (var i = 0; i < list.length; i++) if (sameEnds(list[i], b.x1, b.y1, b.x2, b.y2)) return true;
      return false;
    }
    /** items: [{x1,y1,x2,y2,m,s1?,s2?,ph?}]; rest: beams that stay. Returns { items:[… valid, reason, skip], ok, reason }. */
    function validateSet(items, rest, allowSkip) {
      var placed = rest.slice(), e = eff(), out = [], ok = items.length > 0, first = null;
      items.forEach(function (it) {
        var o = { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, m: it.m, valid: true, reason: null, skip: false };
        if (it.s1) o.s1 = 1;
        if (it.s2) o.s2 = 1;
        if (it.ph) o.ph = it.ph.slice();
        if (!isInt(o.x1) || !isInt(o.y1) || !isInt(o.x2) || !isInt(o.y2)) { o.valid = false; o.reason = 'Punkt liegt nicht auf dem Raster'; }
        else if (sameEndsAny(placed, o)) {
          if (allowSkip) o.skip = true; else { o.valid = false; o.reason = 'Hier liegt schon ein Balken'; }
        } else {
          var r = checkBeam(e, [], o.x1, o.y1, o.x2, o.y2, o.m);
          if (r) { o.valid = false; o.reason = r; }
        }
        if (o.valid && !o.skip) placed.push(o);
        if (!o.valid) { ok = false; if (!first) first = o.reason; }
        out.push(o);
      });
      return { items: out, ok: ok, reason: first };
    }
    function restOf(excl) { return ed.bridge.beams.filter(function (b, i) { return excl.indexOf(i) < 0; }); }
    function mapSelection(fn) {
      var items = [], nodeMap = Object.create(null), collapse = false, back = Object.create(null);
      function mp(x, y) {
        var k = nodeKey(x, y);
        if (nodeMap[k]) return nodeMap[k];
        var r = fn(x, y), nk = nodeKey(r[0], r[1]);
        if (back[nk] && back[nk] !== k) collapse = true;
        back[nk] = k; nodeMap[k] = r;
        return r;
      }
      ed.sel.forEach(function (i) {
        var b = ed.bridge.beams[i], a = mp(b.x1, b.y1), c = mp(b.x2, b.y2);
        var it = { x1: a[0], y1: a[1], x2: c[0], y2: c[1], m: b.m };
        if (b.s1) it.s1 = 1;
        if (b.s2) it.s2 = 1;
        if (b.ph) it.ph = b.ph;
        items.push(it);
      });
      return { items: items, collapse: collapse };
    }
    /** Result of moving / rotating / mirroring the selection without changing anything: { items, ok, reason }. */
    function previewMap(fn) {
      if (!ed.sel.length) return { items: [], ok: false, reason: 'Nichts ausgewählt' };
      var mp = mapSelection(fn);
      if (mp.collapse) return { items: mp.items.map(function (o) { o.valid = false; return o; }), ok: false, reason: 'Zu klein für das Raster – Gelenke würden zusammenfallen' };
      return validateSet(mp.items, restOf(ed.sel), false);
    }
    function commitMap(fn) {
      var pv = previewMap(fn);
      if (!pv.ok) return { ok: false, reason: pv.reason };
      pushUndo();
      ed.sel.forEach(function (idx, k) {
        var o = pv.items[k], nb = { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, m: o.m };
        if (o.s1) nb.s1 = 1;
        if (o.s2) nb.s2 = 1;
        if (o.ph) nb.ph = o.ph.slice();
        ed.bridge.beams[idx] = nb;
      });
      changed();
      return { ok: true };
    }
    ed.previewMove = function (dx, dy) { return previewMap(function (x, y) { return [x + dx, y + dy]; }); };
    ed.moveSelection = function (dx, dy) { if (!dx && !dy) return { ok: false, reason: null }; return commitMap(function (x, y) { return [x + dx, y + dy]; }); };
    function rotFn(deg) {
      var bb = ed.selectionBounds(), r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      return function (x, y) { var px = x - bb.cx, py = y - bb.cy; return [Math.round(bb.cx + px * c - py * s), Math.round(bb.cy + px * s + py * c)]; };
    }
    ed.previewRotate = function (deg) { return ed.sel.length ? previewMap(rotFn(deg)) : previewMap(null); };
    /** Rotates the selection around the middle of its bounding box (positive = counter-clockwise). Joints snap to the grid. */
    ed.rotateSelection = function (deg) { if (!ed.sel.length) return { ok: false, reason: 'Nichts ausgewählt' }; return commitMap(rotFn(deg)); };
    function mirFn(axis) {
      var bb = ed.selectionBounds();
      return axis === 'v' ? function (x, y) { return [x, bb.y0 + bb.y1 - y]; } : function (x, y) { return [bb.x0 + bb.x1 - x, y]; };
    }
    ed.previewMirror = function (axis) { return ed.sel.length ? previewMap(mirFn(axis)) : previewMap(null); };
    /** axis 'h' = left ↔ right, 'v' = up ↔ down (about the middle of the selection's bounding box). */
    ed.mirrorSelection = function (axis) { if (!ed.sel.length) return { ok: false, reason: 'Nichts ausgewählt' }; return commitMap(mirFn(axis)); };
    ed.deleteSelection = function () {
      if (!ed.sel.length) return false;
      pushUndo();
      var drop = ed.sel.slice(), keep = [];
      ed.bridge.beams.forEach(function (b, i) { if (drop.indexOf(i) < 0) keep.push(b); });
      ed.bridge.beams = keep;
      ed.sel = []; fireSel();
      changed();
      return true;
    };

    // --- clipboard -----------------------------------------------------------------------------------
    ed.copy = function () {
      var bb = ed.selectionBounds();
      if (!bb) return 0;
      clipboard = { w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, beams: ed.sel.map(function (i) {
        var b = ed.bridge.beams[i], o = { x1: b.x1 - bb.x0, y1: b.y1 - bb.y0, x2: b.x2 - bb.x0, y2: b.y2 - bb.y0, m: b.m };
        if (b.s1) o.s1 = 1;
        if (b.s2) o.s2 = 1;
        if (b.ph) o.ph = b.ph.slice();
        return o;
      }) };
      return clipboard.beams.length;
    };
    ed.cut = function () { var n = ed.copy(); if (n) ed.deleteSelection(); return n; };
    ed.canPaste = function () { return !!(clipboard && clipboard.beams.length); };
    ed.clipboardInfo = function () { return clipboard ? { count: clipboard.beams.length, w: clipboard.w, h: clipboard.h } : null; };
    function pasteItems(ox, oy) {
      return clipboard.beams.map(function (b) {
        var o = { x1: b.x1 + ox, y1: b.y1 + oy, x2: b.x2 + ox, y2: b.y2 + oy, m: b.m };
        if (b.s1) o.s1 = 1;
        if (b.s2) o.s2 = 1;
        if (b.ph) o.ph = b.ph;
        return o;
      });
    }
    /** Where the clipboard lands with its lower-left corner at the grid point (ox, oy). */
    ed.previewPaste = function (ox, oy) {
      if (!ed.canPaste()) return { items: [], ok: false, reason: 'Die Zwischenablage ist leer' };
      return validateSet(pasteItems(Math.round(ox), Math.round(oy)), ed.bridge.beams, false);
    };
    ed.paste = function (ox, oy) {
      var pv = ed.previewPaste(ox, oy);
      if (!pv.ok) return { ok: false, reason: pv.reason };
      pushUndo();
      var start = ed.bridge.beams.length;
      pv.items.forEach(function (o) {
        var nb = { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, m: o.m };
        if (o.s1) nb.s1 = 1;
        if (o.s2) nb.s2 = 1;
        if (o.ph) nb.ph = o.ph.slice();
        ed.bridge.beams.push(nb);
      });
      var l = []; for (var i = start; i < ed.bridge.beams.length; i++) l.push(i);
      changed();
      ed.setSelection(l);
      return { ok: true, count: l.length };
    };

    // --- trace tools: line and arc --------------------------------------------------------------------
    function matMax() { var m = getMaterial(ed.material); return m ? m.maxLength : 4; }
    function targetLen() { var m = matMax(); return Math.max(2, Math.min(5, m * 0.8)); }
    function dedupePts(pts) { var out = []; pts.forEach(function (p) { var q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); }); return out; }
    function okSegments(pts, maxL) { for (var i = 1; i < pts.length; i++) if (dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) > maxL + EPS) return false; return true; }
    function lineSamples(x1, y1, x2, y2, n) {
      var pts = [];
      for (var i = 0; i <= n; i++) pts.push([Math.round(x1 + (x2 - x1) * i / n), Math.round(y1 + (y2 - y1) * i / n)]);
      pts[0] = [x1, y1]; pts[n] = [x2, y2];
      return dedupePts(pts);
    }
    function planFromPoints(pts, other, kind) {
      var items = [], i, n2 = other ? Math.min(pts.length, other.length) : 0;
      for (i = 1; i < pts.length; i++) items.push({ x1: pts[i - 1][0], y1: pts[i - 1][1], x2: pts[i][0], y2: pts[i][1], m: ed.material });
      if (other) {
        for (i = 1; i < other.length; i++) items.push({ x1: other[i - 1][0], y1: other[i - 1][1], x2: other[i][0], y2: other[i][1], m: ed.material });
        for (i = 0; i < n2; i++) {
          if (pts[i][0] !== other[i][0] || pts[i][1] !== other[i][1]) items.push({ x1: pts[i][0], y1: pts[i][1], x2: other[i][0], y2: other[i][1], m: ed.material });
          if (i + 1 < n2 && (pts[i][0] !== other[i + 1][0] || pts[i][1] !== other[i + 1][1])) items.push({ x1: pts[i][0], y1: pts[i][1], x2: other[i + 1][0], y2: other[i + 1][1], m: ed.material });
        }
      }
      var pv = validateSet(items, ed.bridge.beams, true);
      pv.points = pts; pv.other = other || null; pv.kind = kind;
      pv.count = pv.items.filter(function (x) { return x.valid && !x.skip; }).length;
      if (pv.ok && !pv.count) { pv.ok = false; pv.reason = 'Diese Balken gibt es schon'; }
      return pv;
    }
    /** Straight line of beams from (x1,y1) to (x2,y2) with joints spread evenly; fill → a second, parallel line with rungs and diagonals. */
    ed.planLine = function (x1, y1, x2, y2, o) {
      o = o || {};
      x1 = Math.round(x1); y1 = Math.round(y1); x2 = Math.round(x2); y2 = Math.round(y2);
      var len = dist(x1, y1, x2, y2);
      if (len < 1) return { items: [], ok: false, reason: 'Zu kurz', points: [], kind: 'line', count: 0 };
      var mL = matMax(), n = Math.max(1, Math.ceil(len / targetLen())), pts = lineSamples(x1, y1, x2, y2, n), guard = 0;
      while (!okSegments(pts, mL) && guard++ < 60) pts = lineSamples(x1, y1, x2, y2, ++n);
      var other = null;
      if (o.fill) {
        var h = Math.min(2, Math.max(1, Math.floor(mL * 0.7))), nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
        if (ny < 0 || (Math.abs(ny) < 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
        other = pts.map(function (p) { return [Math.round(p[0] + nx * h), Math.round(p[1] + ny * h)]; });
      }
      return planFromPoints(pts, other, 'line');
    };
    /** Arc of beams from p1 to p2 through the bulge point b; fill → the chord with rungs and diagonals. */
    ed.planArc = function (x1, y1, x2, y2, bx, by, o) {
      o = o || {};
      x1 = Math.round(x1); y1 = Math.round(y1); x2 = Math.round(x2); y2 = Math.round(y2);
      bx = Math.round(bx); by = Math.round(by);
      var cross = (x2 - x1) * (by - y1) - (y2 - y1) * (bx - x1);
      if (Math.abs(cross) < 0.5) return ed.planLine(x1, y1, x2, y2, o);
      var d = 2 * (x1 * (y2 - by) + x2 * (by - y1) + bx * (y1 - y2));
      var ux = ((x1 * x1 + y1 * y1) * (y2 - by) + (x2 * x2 + y2 * y2) * (by - y1) + (bx * bx + by * by) * (y1 - y2)) / d;
      var uy = ((x1 * x1 + y1 * y1) * (bx - x2) + (x2 * x2 + y2 * y2) * (x1 - bx) + (bx * bx + by * by) * (x2 - x1)) / d;
      var r = dist(ux, uy, x1, y1);
      if (!(r > 0) || r > 400) return ed.planLine(x1, y1, x2, y2, o);
      var TAU = Math.PI * 2, a1 = Math.atan2(y1 - uy, x1 - ux), a2 = Math.atan2(y2 - uy, x2 - ux), ab = Math.atan2(by - uy, bx - ux);
      function norm(a) { a = a % TAU; return a < 0 ? a + TAU : a; }
      var ccw = norm(a2 - a1), sweep = norm(ab - a1) <= ccw ? ccw : ccw - TAU;
      var arcLen = r * Math.abs(sweep), mL = matMax(), n = Math.max(2, Math.ceil(arcLen / targetLen())), guard = 0;
      function samples(nn) {
        var pts = [];
        for (var i = 0; i <= nn; i++) { var a = a1 + sweep * i / nn; pts.push([Math.round(ux + r * Math.cos(a)), Math.round(uy + r * Math.sin(a))]); }
        pts[0] = [x1, y1]; pts[nn] = [x2, y2];
        return pts;
      }
      var raw = samples(n);
      while (!okSegments(dedupePts(raw), mL) && guard++ < 60) raw = samples(++n);
      var pts = dedupePts(raw), other = null;
      if (o.fill) {
        // chord points with the same parameters as the arc points → rungs and diagonals between them
        var chord = [], arcP = [];
        for (var i = 0; i < raw.length; i++) {
          var q = i === 0 ? [x1, y1] : i === n ? [x2, y2] : [Math.round(x1 + (x2 - x1) * i / n), Math.round(y1 + (y2 - y1) * i / n)];
          var prev = arcP[arcP.length - 1];
          if (prev && prev[0] === raw[i][0] && prev[1] === raw[i][1]) continue;
          arcP.push(raw[i]); chord.push(q);
        }
        pts = arcP; other = chord;
      }
      var pv = planFromPoints(pts, other, 'arc');
      pv.center = [ux, uy]; pv.radius = r;
      return pv;
    };
    ed.commitPlan = function (plan) {
      if (!plan || !plan.ok) return { ok: false, reason: plan && plan.reason ? plan.reason : 'Hier geht das nicht' };
      pushUndo();
      var start = ed.bridge.beams.length, hyd = getMaterial(ed.material) && getMaterial(ed.material).hyd;
      plan.items.forEach(function (it) {
        if (!it.valid || it.skip) return;
        var nb = { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, m: it.m };
        if (hyd) nb.ph = ['hold', 'out'];
        ed.bridge.beams.push(nb);
      });
      var l = []; for (var i = start; i < ed.bridge.beams.length; i++) l.push(i);
      changed();
      ed.setSelection(l);
      return { ok: true, count: l.length };
    };


    // --- Foundations (fixed anchors planted on the ground) -------------------------------------------
    ed.foundationAllowed = function () { return !!(BB.Bridge && BB.Bridge.allows && BB.Bridge.allows(level, 'foundation')); };
    ed.foundationAt = function (wx, wy, tol) {
      var f = ed.bridge.found || [];
      for (var i = 0; i < f.length; i++) if (dist(wx, wy, f[i][0], f[i][1]) <= tol) return i;
      return -1;
    };
    ed.foundationSpot = function (wx) { return BB.Bridge.foundationSpot(level, ed.bridge, wx); };
    /** Plants a foundation at the ground below the pointer. Returns { ok, reason }. */
    ed.placeFoundation = function (wx) {
      var x = Math.round(wx);
      var reason = BB.Bridge.checkFoundation(level, ed.bridge, x);
      if (reason) return { ok: false, reason: reason };
      pushUndo();
      if (!ed.bridge.found) ed.bridge.found = [];
      ed.bridge.found.push([x, BB.Bridge.foundationY(level, x)]);
      changed();
      return { ok: true };
    };
    /** Removes the foundation i together with the beams attached to it. */
    ed.removeFoundation = function (i) {
      var f = ed.bridge.found;
      if (!f || i < 0 || i >= f.length) return false;
      pushUndo();
      var fx = f[i][0], fy = f[i][1];
      ed.bridge.beams = ed.bridge.beams.filter(function (b) { return !((b.x1 === fx && b.y1 === fy) || (b.x2 === fx && b.y2 === fy)); });
      ed.clearSelection();
      f.splice(i, 1);
      if (!f.length) delete ed.bridge.found;
      changed();
      return true;
    };
    ed.foundationCount = function () { return (ed.bridge.found || []).length; };

    // --- Split joints --------------------------------------------------------------------------------
    /**
     * Tap on a joint: with 2+ beams there, the tapped beam end (the beam closest to the tap) moves
     * into / out of the split group; a tap on the exact joint centre cycles the next beam into the
     * group (all of them are back in the common joint after the last one). Returns { ok, reason }.
     */
    ed.toggleSplit = function (wx, wy, tol) {
      var n = ed.nodeAt(wx, wy, tol);
      if (!n) return { ok: false, reason: 'Tippe auf ein Gelenk' };
      if (n.anchor) return { ok: false, reason: 'Ankerpunkte lassen sich nicht teilen' };
      var ends = [];
      var beams = ed.bridge.beams;
      for (var i = 0; i < beams.length; i++) {
        var b = beams[i];
        if (b.x1 === n.x && b.y1 === n.y) ends.push({ i: i, e: 1, ox: b.x2, oy: b.y2 });
        else if (b.x2 === n.x && b.y2 === n.y) ends.push({ i: i, e: 2, ox: b.x1, oy: b.y1 });
      }
      if (ends.length < 2) return { ok: false, reason: 'Hier treffen sich zu wenige Balken' };
      var d0 = dist(wx, wy, n.x, n.y), pick = null;
      if (d0 > 0.3) {          // nearest beam by direction
        var best = Infinity;
        for (var k = 0; k < ends.length; k++) {
          var ang = Math.abs(Math.atan2((ends[k].oy - n.y) * (wx - n.x) - (ends[k].ox - n.x) * (wy - n.y), (ends[k].ox - n.x) * (wx - n.x) + (ends[k].oy - n.y) * (wy - n.y)));
          if (ang < best) { best = ang; pick = ends[k]; }
        }
      } else {
        for (var q = 0; q < ends.length && !pick; q++) if (!beams[ends[q].i]['s' + ends[q].e]) pick = ends[q];
      }
      pushUndo();
      if (pick) {
        var key = 's' + pick.e;
        if (beams[pick.i][key]) delete beams[pick.i][key]; else beams[pick.i][key] = 1;
      } else {
        ends.forEach(function (en) { delete beams[en.i]['s' + en.e]; });
      }
      changed();
      return { ok: true };
    };

    // --- Hydraulic phases ----------------------------------------------------------------------------
    ed.setBeamPhases = function (i, ph) {
      var b = ed.bridge.beams[i];
      if (!b) return false;
      pushUndo();
      b.ph = ph.slice();
      changed();
      return true;
    };

    /** Sets the phases of several hydraulic beams at once ([{ i, ph }]) – one undo step, nothing when nothing changed. */
    ed.setPhases = function (list) {
      var changedAny = false;
      list.forEach(function (e) { var b = ed.bridge.beams[e.i]; if (b && JSON.stringify(b.ph || ['hold', 'out']) !== JSON.stringify(e.ph)) changedAny = true; });
      if (!changedAny) return false;
      pushUndo();
      list.forEach(function (e) { var b = ed.bridge.beams[e.i]; if (b) b.ph = e.ph.slice(); });
      changed();
      return true;
    };

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
