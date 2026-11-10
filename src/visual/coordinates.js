// Coordinates for annotations (UVA Phase 2, PR-2B). Marks live in
// "normalized" space: 0..1 of the oriented source image, origin top-left.
// The transform engine itself is src/image/transform.js; this module is the
// annotation-side entry point so a second canvas kind (Graph, Phase 4) uses
// the same maths instead of a copy.
import { apply, invert, mapMark, multiply, chain, identity, scale, translate, rotate } from "../image/transform.js";
export { apply, invert, mapMark, multiply, chain, identity, scale, translate, rotate };

// The matrix that does what canvas-state's fromFrame() does for a region
// frame: coordinates of a processed output ({ region, width, height }, or
// 0..1 of the region when width/height are absent) → normalized source.
export function frameMatrix({ region, width, height }) {
  const sx = (width ? 1 / width : 1) * (region.x2 - region.x), sy = (height ? 1 / height : 1) * (region.y2 - region.y);
  return multiply(translate(region.x, region.y), scale(sx, sy));
}

// Every x/y a mark carries, as points (point/arrow/rect corners, polyline vertices).
export function markPoints(mark) {
  if (mark.type === "polyline" && Array.isArray(mark.points)) return mark.points.map((p) => ({ x: p.x, y: p.y }));
  const pts = [{ x: mark.x, y: mark.y }];
  if (mark.x2 !== undefined && mark.y2 !== undefined) pts.push({ x: mark.x2, y: mark.y2 });
  return pts;
}

// Axis-aligned bounds of a mark in the space it is in.
export function markBounds(mark) {
  const pts = markPoints(mark), xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

// Largest distance between a point and its image after going through the
// matrix and back. Zero for an exact inverse; large for an ill-conditioned one.
export function roundTripError(matrix, points) {
  const inv = invert(matrix);
  if (!inv) return Infinity;
  return Math.max(0, ...points.map((p) => {
    const q = apply(matrix, p.x, p.y), r = apply(inv, q.x, q.y);
    return Math.hypot(r.x - p.x, r.y - p.y);
  }));
}

// Map a mark through a matrix, or fail rather than invent coordinates: the
// matrix must be invertible and the mark must survive the round trip within
// `tolerance` (normalized units), and land inside 0..1 unless `allowOutside`.
export function mapMarkChecked(mark, matrix, { tolerance = 1e-6, allowOutside = false } = {}) {
  if (!invert(matrix)) throw new Error("This coordinate transform cannot be inverted; the mark cannot be placed exactly");
  const error = roundTripError(matrix, markPoints(mark));
  if (error > tolerance) throw new Error("Mapping this mark loses " + error.toExponential(2) + " in a round trip (limit " + tolerance + ")");
  const mapped = mapMark(mark, matrix);
  if (!allowOutside) {
    const b = markBounds(mapped), eps = 1e-9;
    if (![b.x, b.y, b.x2, b.y2].every((v) => Number.isFinite(v) && v >= -eps && v <= 1 + eps)) {
      throw new Error("The mapped mark falls outside the image");
    }
  }
  return mapped;
}

// Anchors. Phase 2 anchors a mark to the image only ("normalized"). Anchors
// to a document frame, world space or a function's x are Phase 4 and refused
// by name, so a stored anchor never means something this code cannot resolve.
export const ANCHOR_SPACES = Object.freeze(["normalized"]);
export const FUTURE_ANCHOR_SPACES = Object.freeze(["document", "world", "function-x"]);

export function anchorOf(mark) {
  if (mark.type === "point") return { space: "normalized", kind: "point", x: mark.x, y: mark.y };
  if (mark.type === "polyline") return { space: "normalized", kind: "path", points: markPoints(mark), bounds: markBounds(mark) };
  return { space: "normalized", kind: "box", ...markBounds(mark) };
}

export function resolveAnchor(anchor) {
  if (FUTURE_ANCHOR_SPACES.includes(anchor?.space)) throw new Error("Anchor space " + JSON.stringify(anchor.space) + " is not supported yet");
  if (anchor?.space !== "normalized") throw new Error("Unknown anchor space " + JSON.stringify(anchor?.space));
  if (anchor.kind === "point") return { x: anchor.x, y: anchor.y, x2: anchor.x, y2: anchor.y };
  if (anchor.kind === "box") return { x: anchor.x, y: anchor.y, x2: anchor.x2, y2: anchor.y2 };
  if (anchor.kind === "path") return { ...anchor.bounds };
  throw new Error("Unknown anchor kind " + JSON.stringify(anchor.kind));
}
