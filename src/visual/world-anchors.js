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
//     it was (Phase 4B-4 adds reanchor and detach).
import { frameOf } from "../scene/objects.js";

const GEO = ["x", "y", "x2", "y2"];
const round = (v) => Math.round(v * 1e9) / 1e9;
const canvasGeometry = (m) => Array.isArray(m.points) ? { points: m.points.map((p) => ({ x: p.x, y: p.y })) } : Object.fromEntries(GEO.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const basisOf = (axes) => JSON.stringify([axes.props.xRange, axes.props.yRange, axes.props.region ?? null]);

export const isWorldAnchored = (m) => m?.anchor?.space === "world";
export function axesFor(entry, frame) {
  const o = entry.objects?.get?.(frame);
  return o?.type === "axes-2d" ? o : null;
}
// The axes a new world anchor uses when none is named: the canvas's only axes object.
export function defaultAxes(entry) {
  const all = [...(entry.objects?.values() ?? [])].filter((o) => o.type === "axes-2d");
  return all.length === 1 ? all[0] : null;
}

function mapGeometry(g, f) {
  if (Array.isArray(g.points)) return { points: g.points.map((p) => { const [x, y] = f(p.x, p.y); return { x: round(x), y: round(y) }; }) };
  const out = {};
  if (g.x !== undefined) [out.x, out.y] = f(g.x, g.y).map(round);
  if (g.x2 !== undefined) [out.x2, out.y2] = f(g.x2, g.y2).map(round);
  return out;
}
// Canvas geometry with a polyline's bounding box, as stored marks carry it.
function withBounds(g) {
  if (!Array.isArray(g.points)) return g;
  const xs = g.points.map((p) => p.x), ys = g.points.map((p) => p.y);
  return { points: g.points, x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
const coords = (g) => Array.isArray(g.points) ? g.points : [{ x: g.x, y: g.y }, ...(g.x2 !== undefined ? [{ x: g.x2, y: g.y2 }] : [])];
const insideRange = (world, axes) => {
  const [x0, x1] = axes.props.xRange, [y0, y1] = axes.props.yRange, lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b), eps = 1e-9;
  return coords(world).every((p) => p.x >= lo(x0, x1) - eps && p.x <= hi(x0, x1) + eps && p.y >= lo(y0, y1) - eps && p.y <= hi(y0, y1) + eps);
};
const inCanvas = (g) => coords(g).every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

// Canvas geometry (0..1) of a mark given in axis units on `axes`. Throws when
// it falls outside the axes range (a model mark must be visible when drawn).
export function worldToCanvas(world, axes) {
  if (!insideRange(world, axes)) throw new Error("the point(s) lie outside the axes range x " + JSON.stringify(axes.props.xRange) + ", y " + JSON.stringify(axes.props.yRange));
  const g = mapGeometry(world, frameOf(axes).toCanvas);
  if (!inCanvas(g)) throw new Error("the point(s) fall outside the canvas");
  return g;
}
export const canvasToWorld = (g, axes) => mapGeometry(g, frameOf(axes).toFrame);

// A world anchor record for a mark whose canvas geometry is `g`.
export function anchorRecord(frame, g, axes, world = canvasToWorld(g, axes)) {
  return { space: "world", frame, world, at: canvasGeometry(g), basis: basisOf(axes) };
}

// Brings every world-anchored mark of `entry` up to date (see above).
// Marks are replaced, never mutated. Returns the ids that changed.
export function syncWorldAnchors(entry) {
  const marks = entry.marks;
  if (!(marks instanceof Map)) return [];
  const changed = [];
  for (const [id, m] of marks) {
    if (!isWorldAnchored(m)) continue;
    const axes = axesFor(entry, m.anchor.frame), now = canvasGeometry(m);
    let next = null;
    if (!axes) {
      if (m.anchorStatus !== "invalid") next = { ...m, anchorStatus: "invalid" };
    } else if (!m.anchor.world || !same(m.anchor.at, now)) {
      // Moved or reshaped on the canvas (or a new anchor): the world place follows.
      next = { ...m, anchor: anchorRecord(m.anchor.frame, now, axes) };
      delete next.anchorStatus;
    } else if (m.anchor.basis !== basisOf(axes) || m.anchorStatus) {
      if (!insideRange(m.anchor.world, axes)) {
        next = m.anchorStatus === "outside" && m.anchor.basis === basisOf(axes) ? null : { ...m, anchor: { ...m.anchor, basis: basisOf(axes) }, anchorStatus: "outside" };
      } else {
        const g = withBounds(mapGeometry(m.anchor.world, frameOf(axes).toCanvas));
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
  if (!isWorldAnchored(m)) return undefined;
  return { space: "world", frame: m.anchor.frame, ...(m.anchor.world ? { world: m.anchor.world } : {}), status: m.anchorStatus ?? "ok" };
}
