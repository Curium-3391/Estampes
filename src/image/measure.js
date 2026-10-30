// Scale calibration and measurement (RFC D11, D12). A measurement space is
// either the image itself (oriented source pixels) or one derived view, for
// example a perspective-rectified view of a tilted board, where distances
// are uniform. Without a calibration in that space results are in pixels
// only; Estampes never guesses absolute sizes. Every value carries an
// uncertainty from the point precision and the calibration.
import { apply } from "./transform.js";

export const MEASURE_VERSION = "1";
export const UNITS = Object.freeze(["mm", "cm", "m", "in", "um", "px"]);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r = (v, d = 4) => Number(v.toPrecision(d + 2));

// Points in the space's pixels. space = { kind: "image" } or { kind: "view", record }.
export function toSpacePixels(entry, space, points, units = "normalized") {
  if (space.kind === "view") {
    const { width, height } = space.record.pixelDimensions;
    return points.map((p) => (units === "normalized" ? { x: p.x * width, y: p.y * height } : { x: p.x, y: p.y }));
  }
  const W = entry.sourceInfo?.width ?? entry.width, H = entry.sourceInfo?.height ?? entry.height;
  return points.map((p) => (units === "normalized" ? { x: p.x * W, y: p.y * H } : { x: p.x, y: p.y }));
}

// Normalized image coordinates of points given in a derived view, so the
// measurement can be drawn on the canvas.
export function spaceToNormalized(entry, space, pts) {
  if (space.kind === "view") return pts.map((p) => apply(space.record.coordinateMapping.derivedToNormalized, p.x, p.y)).map(({ x, y }) => ({ x, y }));
  const W = entry.sourceInfo?.width ?? entry.width, H = entry.sourceInfo?.height ?? entry.height;
  return pts.map((p) => ({ x: p.x / W, y: p.y / H }));
}

// Default precision of a point: one working-copy pixel, in the space's
// pixels (GPT reads points off the working copy unless it used native).
export function defaultSigma(entry, space) {
  if (space.kind === "view") return Math.max(0.5, space.record.evidence?.sourcePixelsPerOutputPixel ? 1 : 1);
  const W = entry.sourceInfo?.width ?? entry.width;
  return Math.max(0.5, W / entry.width);
}

export function calibrate({ points, length, unit, sigmaPx, lengthUncertainty = 0 }) {
  const px = dist(points[0], points[1]);
  if (!(px > 0)) throw new Error("calibration points must be two different points");
  const perPx = length / px;
  // Relative error of the scale: endpoint error over the reference length,
  // plus the stated uncertainty of the known length.
  const rel = Math.hypot((Math.SQRT2 * sigmaPx) / px, lengthUncertainty / length);
  return { unit, unitsPerPixel: perPx, relativeUncertainty: rel, referencePx: px, referenceLength: length, sigmaPx };
}

export function measure(kind, pts, { calibration, sigmaPx }) {
  const cal = calibration ?? null;
  const k = cal ? cal.unitsPerPixel : 1, unit = cal ? cal.unit : "px", calRel = cal ? cal.relativeUncertainty : 0;
  const withUnc = (valuePx, sigmaValuePx, power = 1) => {
    const value = valuePx * k ** power;
    const rel = Math.hypot(valuePx ? sigmaValuePx / valuePx : 0, power * calRel);
    return { value: r(value), uncertainty: r(Math.abs(value) * rel), unit: power === 2 ? unit + "²" : unit, pixels: r(valuePx), pixelUncertainty: r(sigmaValuePx) };
  };
  if (kind === "distance") {
    if (pts.length !== 2) throw new Error("distance needs exactly 2 points");
    return { kind, ...withUnc(dist(pts[0], pts[1]), Math.SQRT2 * sigmaPx) };
  }
  if (kind === "path") {
    if (pts.length < 2) throw new Error("path needs at least 2 points");
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return { kind, segments: pts.length - 1, ...withUnc(L, Math.sqrt(2 * (pts.length - 1)) * sigmaPx) };
  }
  if (kind === "area") {
    if (pts.length < 3) throw new Error("area needs at least 3 points");
    let a = 0, per = 0;
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; per += dist(pts[i], pts[j]); }
    // Moving each vertex by sigma changes the area by about perimeter*sigma.
    return { kind, ...withUnc(Math.abs(a) / 2, per * sigmaPx / Math.sqrt(2), 2) };
  }
  if (kind === "angle") {
    if (pts.length !== 3) throw new Error("angle needs 3 points: end, vertex, end");
    const [p, v, q] = pts;
    const a = dist(p, v), b = dist(q, v);
    if (!a || !b) throw new Error("angle points must differ from the vertex");
    const ang = Math.abs(Math.atan2(p.y - v.y, p.x - v.x) - Math.atan2(q.y - v.y, q.x - v.x));
    const deg = ((ang > Math.PI ? 2 * Math.PI - ang : ang) * 180) / Math.PI;
    const sigma = (Math.sqrt(1 / a ** 2 + 1 / b ** 2 + 1 / a ** 2 + 1 / b ** 2) * sigmaPx * 180) / Math.PI;
    return { kind, value: r(deg), uncertainty: r(sigma), unit: "deg" };
  }
  throw new Error("Unknown measurement " + kind);
}
