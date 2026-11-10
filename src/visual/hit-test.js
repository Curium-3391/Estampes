// Which mark is under a point (UVA Phase 2, PR-2B). Pure geometry in
// normalized space; `width`/`height` (image pixels) make distances isotropic
// so a tolerance in pixels means the same left-right and up-down.
import { markPoints, markBounds } from "./coordinates.js";

function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Distance in pixels from the point to the mark (0 when on or inside it).
export function distanceToMark(mark, x, y, { width = 1, height = 1 } = {}) {
  const px = (p) => ({ x: p.x * width, y: p.y * height });
  const p = px({ x, y }), pts = markPoints(mark).map(px);
  if (mark.type === "point") return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  if (mark.type === "arrow") return segmentDistance(p, pts[0], pts[1]);
  if (mark.type === "rect") {
    const b = markBounds(mark), x1 = b.x * width, x2 = b.x2 * width, y1 = b.y * height, y2 = b.y2 * height;
    const dx = Math.max(x1 - p.x, 0, p.x - x2), dy = Math.max(y1 - p.y, 0, p.y - y2);
    return Math.hypot(dx, dy);
  }
  if (mark.closed && (mark.pen === "highlighter") && insidePolygon(p, pts)) return 0;
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segmentDistance(p, pts[i], pts[i + 1]));
  if (mark.closed && pts.length > 2) best = Math.min(best, segmentDistance(p, pts[pts.length - 1], pts[0]));
  return best;
}

// Marks within `tolerance` pixels of the point, nearest first; among equals
// the one drawn later (higher in the list) comes first.
export function hitTest(marks, x, y, { tolerance = 6, width = 1, height = 1 } = {}) {
  return marks
    .map((mark, order) => ({ mark, order, distance: distanceToMark(mark, x, y, { width, height }) }))
    .filter((h) => h.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance || b.order - a.order)
    .map((h) => h.mark);
}
