// World anchors on a Graph (UVA Phase 4B-3). A mark is normally anchored to
// the canvas (OD-02: it stays where it is on the page). A mark anchored to an
// axes object (`anchor: {space: "world", frame: "<axes id>"}`) follows the
// data instead: its place in axis units is the source of truth, and its
// canvas geometry (0..1, what every other part of Estampes draws and edits)
// is derived from it with the axes' current range.
//
// The anchor record on a mark:
//   { space: "world", frame, world: {x,y,x2?,y2?} | {points}, at, basis }
//   world  the geometry in axis units
//   at     the canvas geometry the world geometry was last turned into
//   basis  the axes range and region that was done with
// Kept up to date by syncWorldAnchors before every save:
//   - the canvas geometry differs from `at`: the mark was moved, resized or
//     reshaped (by the person or the model), so `world` is recomputed from it;
//   - else the axes changed (`basis` differs): the canvas geometry is
//     recomputed from `world`. A mark whose world place is now outside the
//     axes range keeps its last canvas geometry and gets
//     anchorStatus "outside" (not drawn; it comes back when the range does);
//   - the axes object is gone: anchorStatus "invalid", the mark stays where
//     it was.
//
// Function anchors (UVA Phase 4B-4): a mark fixed to a function plot at an x
// value follows the curve (`anchor: {space: "function-x", frame: "<plot id>"}`):
//   { space: "function-x", frame, x, offset: {dx, dy}, target, at, basis }
//   x       the axis x on the curve the mark's first point follows
//   offset  canvas units from the curve point (x, f(x)) to the first point
//   target  the plot's expression, domain and axes: a change makes the
//           mark's confirmed claim stale (it was about the old curve)
// The whole mark is translated, its shape kept. Status:
//   - the plot is gone, or x is outside its domain or f(x) is undefined:
//     "invalid", the mark stays where it was (drawn, with a badge) until it
//     is pinned again or pinned to the page;
//   - (x, f(x)) is outside the axes range: "outside", not drawn.
import { frameOf } from "../scene/objects.js";
import { compileExpression } from "../scene/expression.js";

const GEO = ["x", "y", "x2", "y2"];
const round = (v) => Math.round(v * 1e9) / 1e9;
const canvasGeometry = (m) => Array.isArray(m.points) ? { points: m.points.map((p) => ({ x: p.x, y: p.y })) } : Object.fromEntries(GEO.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const basisOf = (axes) => JSON.stringify([axes.props.xRange, axes.props.yRange, axes.props.region ?? null]);

export const isWorldAnchored = (m) => m?.anchor?.space === "world";
export const isFunctionAnchored = (m) => m?.anchor?.space === "function-x";
export const isAnchored = (m) => isWorldAnchored(m) || isFunctionAnchored(m);
export function plotFor(entry, id) {
  const o = entry.objects?.get?.(id);
  return o?.type === "function-plot" ? o : null;
}
export function axesFor(entry, frame) {
  const o = entry.objects?.get?.(frame);
  return o?.type === "axes-2d" ? o : null;
}
// The axes a new world anchor uses when none is named: the canvas's only axes object.
export function defaultAxes(entry) {
  const all = [...(entry.objects?.values() ?? [])].filter((o) => o.type === "axes-2d");
  return all.length === 1 ? all[0] : null;
}

// Canvas coordinates (0..1) are rounded like every stored mark; axis units
// keep full precision (an axes range can be far smaller than 1e-9).
function mapGeometry(g, f, r = round) {
  if (Array.isArray(g.points)) return { points: g.points.map((p) => { const [x, y] = f(p.x, p.y); return { x: r(x), y: r(y) }; }) };
  const out = {};
  if (g.x !== undefined) [out.x, out.y] = f(g.x, g.y).map(r);
  if (g.x2 !== undefined) [out.x2, out.y2] = f(g.x2, g.y2).map(r);
  return out;
}
// Canvas geometry with a polyline's bounding box, as stored marks carry it.
function withBounds(g) {
  if (!Array.isArray(g.points)) return g;
  const xs = g.points.map((p) => p.x), ys = g.points.map((p) => p.y);
  return { points: g.points, x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
const coords = (g) => Array.isArray(g.points) ? g.points : [{ x: g.x, y: g.y }, ...(g.x2 !== undefined ? [{ x: g.x2, y: g.y2 }] : [])];
// Inside the axes range, with a tolerance relative to the range (axes can span far less than 1e-9).
const within = (v, a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b), eps = (hi - lo) * 1e-9; return v >= lo - eps && v <= hi + eps; };
const insideRange = (world, axes) => {
  const [x0, x1] = axes.props.xRange, [y0, y1] = axes.props.yRange;
  return coords(world).every((p) => within(p.x, x0, x1) && within(p.y, y0, y1));
};
const inCanvas = (g) => coords(g).every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
// The canvas geometry for `world` on `axes` now, or null when it is not drawable (outside the range or the canvas).
function placed(world, axes) {
  if (!insideRange(world, axes)) return null;
  const g = mapGeometry(world, frameOf(axes).toCanvas);
  return inCanvas(g) ? g : null;
}
// Whether a mark's canvas geometry `g` lies inside the axes range (a person pinning or dragging a mark).
export const canvasInsideRange = (g, axes) => insideRange(canvasToWorld(g, axes), axes);

// Canvas geometry (0..1) of a mark given in axis units on `axes`. Throws when
// it falls outside the axes range (a model mark must be visible when drawn).
export function worldToCanvas(world, axes) {
  if (!insideRange(world, axes)) throw new Error("the point(s) lie outside the axes range x " + JSON.stringify(axes.props.xRange) + ", y " + JSON.stringify(axes.props.yRange));
  const g = mapGeometry(world, frameOf(axes).toCanvas);
  if (!inCanvas(g)) throw new Error("the point(s) fall outside the canvas");
  return g;
}
export const canvasToWorld = (g, axes) => mapGeometry(g, frameOf(axes).toFrame, (v) => v);

// A world anchor record for a mark whose canvas geometry is `g`.
export function anchorRecord(frame, g, axes, world = canvasToWorld(g, axes)) {
  return { space: "world", frame, world, at: canvasGeometry(g), basis: basisOf(axes) };
}

// ---- Function anchors ----
const firstPoint = (g) => Array.isArray(g.points) ? g.points[0] : { x: g.x, y: g.y };
const targetOf = (plot) => JSON.stringify([plot.props.expression, plot.props.domain ?? null, plot.props.frame]);
const curveBasis = (plot, axes) => JSON.stringify([targetOf(plot), axes ? basisOf(axes) : null]);
// The curve point of `plot` at axis x: {point: [cx, cy], axes} on the canvas, or {status: "invalid" | "outside"}.
export function curveAt(entry, plot, x) {
  const axes = axesFor(entry, plot.props.frame);
  if (!axes || !Number.isFinite(x)) return { status: "invalid" };
  // Only an explicit domain makes the curve undefined at x; without one, an x
  // outside the axes range is only out of view ("outside" below).
  if (plot.props.domain && !within(x, ...plot.props.domain)) return { status: "invalid" };
  let y;
  try { y = compileExpression(plot.props.expression)(x); } catch { return { status: "invalid" }; }
  if (!Number.isFinite(y)) return { status: "invalid" };
  if (!within(x, ...axes.props.xRange) || !within(y, ...axes.props.yRange)) return { status: "outside", axes };
  const [cx, cy] = frameOf(axes).toCanvas(x, y);
  return { point: [cx, cy], axes, y };
}
// A function anchor record for a mark at canvas geometry `g`, following `plot`
// at the axis x of its first point; null when the curve is not there.
export function functionRecord(entry, plot, g, x) {
  const axes = axesFor(entry, plot.props.frame);
  if (!axes) return null;
  const p = firstPoint(g), ax = x ?? frameOf(axes).toFrame(p.x, p.y)[0], c = curveAt(entry, plot, ax);
  if (!c.point) return null;
  return { space: "function-x", frame: plot.id, x: ax, offset: { dx: round(p.x - c.point[0]), dy: round(p.y - c.point[1]) },
    target: targetOf(plot), at: canvasGeometry(g), basis: curveBasis(plot, axes) };
}
// The function plot nearest to a mark's first point, measured along the vertical at its x.
export function nearestPlot(entry, g) {
  const p = firstPoint(g);
  let best = null;
  for (const o of entry.objects?.values() ?? []) {
    if (o.type !== "function-plot") continue;
    const axes = axesFor(entry, o.props.frame);
    if (!axes) continue;
    const c = curveAt(entry, o, frameOf(axes).toFrame(p.x, p.y)[0]);
    if (c.point && (!best || Math.abs(c.point[1] - p.y) < best.d)) best = { plot: o, d: Math.abs(c.point[1] - p.y) };
  }
  return best?.plot ?? null;
}
const translated = (g, dx, dy) => Array.isArray(g.points) ? { points: g.points.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) })) }
  : { x: round(g.x + dx), y: round(g.y + dy), ...(g.x2 !== undefined ? { x2: round(g.x2 + dx), y2: round(g.y2 + dy) } : {}) };
const hasClaimToCheck = (m) => m.review === "confirmed" || (m.evidence ?? []).some((e) => e.observer === "tool");

function syncFunctionAnchor(entry, m) {
  const plot = plotFor(entry, m.anchor.frame), now = canvasGeometry(m);
  if (!plot) return m.anchorStatus === "invalid" ? null : { ...m, anchorStatus: "invalid" };
  const axes = axesFor(entry, plot.props.frame), basis = curveBasis(plot, axes);
  if (!same(m.anchor.at, now)) {
    // Moved on the canvas: it follows the curve from its new place.
    const rec = functionRecord(entry, plot, now);
    if (rec) { const next = { ...m, anchor: rec }; delete next.anchorStatus; return next; }
    return { ...m, anchor: { ...m.anchor, at: now, basis }, anchorStatus: "invalid" };
  }
  if (m.anchor.basis === basis && !m.anchorStatus) return null;
  // The curve or its axes changed (or the mark was not resolved): follow the curve again.
  const stale = m.anchor.target !== targetOf(plot) && hasClaimToCheck(m) ? { stale: true } : {};
  const c = curveAt(entry, plot, m.anchor.x), anchor = { ...m.anchor, target: targetOf(plot), basis };
  if (!c.point) return m.anchorStatus === c.status && m.anchor.basis === basis ? null : { ...m, ...stale, anchor, anchorStatus: c.status };
  const p = firstPoint(now), g = translated(now, c.point[0] + m.anchor.offset.dx - p.x, c.point[1] + m.anchor.offset.dy - p.y);
  if (!inCanvas(g)) return { ...m, ...stale, anchor, anchorStatus: "outside" };
  const next = { ...m, ...withBounds(g), ...stale, anchor: { ...anchor, at: canvasGeometry(g) } };
  delete next.anchorStatus;
  return next;
}

// Brings every world-anchored mark of `entry` up to date (see above).
// Marks are replaced, never mutated. Returns the ids that changed.
export function syncWorldAnchors(entry) {
  const marks = entry.marks;
  if (!(marks instanceof Map)) return [];
  const changed = [];
  for (const [id, m] of marks) {
    if (isFunctionAnchored(m)) {
      const next = syncFunctionAnchor(entry, m);
      if (next) { marks.set(id, next); changed.push(id); }
      continue;
    }
    if (!isWorldAnchored(m)) continue;
    const axes = axesFor(entry, m.anchor.frame), now = canvasGeometry(m);
    let next = null;
    if (!axes) {
      if (m.anchorStatus !== "invalid") next = { ...m, anchorStatus: "invalid" };
    } else if (!m.anchor.world || !same(m.anchor.at, now)) {
      // Moved or reshaped on the canvas (or a new anchor): the world place follows, and is checked against the range.
      next = { ...m, anchor: anchorRecord(m.anchor.frame, now, axes) };
      delete next.anchorStatus;
      if (!insideRange(next.anchor.world, axes)) next.anchorStatus = "outside";
    } else if (m.anchor.basis !== basisOf(axes) || m.anchorStatus) {
      const at = placed(m.anchor.world, axes);
      if (!at) {
        next = m.anchorStatus === "outside" && m.anchor.basis === basisOf(axes) ? null : { ...m, anchor: { ...m.anchor, basis: basisOf(axes) }, anchorStatus: "outside" };
      } else {
        const g = withBounds(at);
        next = { ...m, ...g, anchor: { ...m.anchor, at: canvasGeometry(g), basis: basisOf(axes) } };
        delete next.anchorStatus;
      }
    }
    if (next) { marks.set(id, next); changed.push(id); }
  }
  return changed;
}

// What a reader is told about a mark's anchor (get_visual_state and the
// model's results): the space, the axes, the place in axis units and whether
// it resolves now. A canvas-anchored mark says nothing extra.
export function anchorInfo(m) {
  if (isFunctionAnchored(m)) return { space: "function-x", plot: m.anchor.frame, x: m.anchor.x, offset: m.anchor.offset, status: m.anchorStatus ?? "ok" };
  if (!isWorldAnchored(m)) return undefined;
  return { space: "world", frame: m.anchor.frame, ...(m.anchor.world ? { world: m.anchor.world } : {}), status: m.anchorStatus ?? "ok" };
}

// An anchor record from an untrusted file (bundle, marks file), checked field
// by field: {anchor, anchorStatus?}, or {} when there is none or it is malformed.
const finite = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function cleanGeometry(g, ok) {
  if (!g || typeof g !== "object") return null;
  if (Array.isArray(g.points)) return g.points.length >= 1 && g.points.length <= 2000 && g.points.every((p) => p && ok(p.x) && ok(p.y)) ? { points: g.points.map((p) => ({ x: p.x, y: p.y })) } : null;
  if (!ok(g.x) || !ok(g.y)) return null;
  if (g.x2 === undefined) return { x: g.x, y: g.y };
  return ok(g.x2) && ok(g.y2) ? { x: g.x, y: g.y, x2: g.x2, y2: g.y2 } : null;
}
const status = (m) => ["outside", "invalid"].includes(m.anchorStatus) ? { anchorStatus: m.anchorStatus } : {};
export function cleanAnchorFields(m) {
  const a = m?.anchor;
  if (!a || typeof a.frame !== "string" || !/^o\d{1,6}$/.test(a.frame)) return {};
  if (a.space === "function-x") {
    const at = cleanGeometry(a.at, unit);
    if (!at || !finite(a.x) || !a.offset || !finite(a.offset.dx) || !finite(a.offset.dy) || Math.abs(a.offset.dx) > 2 || Math.abs(a.offset.dy) > 2) return {};
    if (typeof a.basis !== "string" || a.basis.length > 1200 || typeof a.target !== "string" || a.target.length > 800) return {};
    return { anchor: { space: "function-x", frame: a.frame, x: a.x, offset: { dx: a.offset.dx, dy: a.offset.dy }, target: a.target, at, basis: a.basis }, ...status(m) };
  }
  if (a.space !== "world") return {};
  const world = cleanGeometry(a.world, finite), at = cleanGeometry(a.at, unit);
  if (!world || !at || typeof a.basis !== "string" || a.basis.length > 400) return {};
  return { anchor: { space: "world", frame: a.frame, world, at, basis: a.basis }, ...status(m) };
}
