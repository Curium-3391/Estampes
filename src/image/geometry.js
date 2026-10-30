// Geometry steps for derived views (RFC PRE-05, D01-D03, D13-D14): rotate,
// flip, pad, deskew, four-point perspective rectification and polygon
// masks. They run on the analysis crop before pixel ops, and each returns
// the exact matrix it applied, so marks read off the result map back to the
// image (src/image/transform.js) and the share of output pixels that came
// from the image (validity) is reported instead of hidden.
import { config } from "../config.js";
import { rawImage, fromRaw, toGray } from "../image-ops.js";
import {
  apply, invert, chain, translate, rotate as rotateM, fitTransform, step, composeSteps,
} from "./transform.js";

export const GEOMETRY_OPS = Object.freeze(["rotate", "flip", "pad", "deskew", "perspective", "mask"]);

// Bilinear resampling through `inv` (output pixel -> input pixel). Pixels
// whose centre falls outside the input get `fill` and count as invalid.
export function warp(img, inv, outW, outH, { fill = 255, mask = null } = {}) {
  const { data, width, height, channels } = img;
  const out = Buffer.alloc(outW * outH * channels);
  let valid = 0;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const o = (y * outW + x) * channels;
      const cx = x + 0.5, cy = y + 0.5;
      const w = inv[6] * cx + inv[7] * cy + inv[8];
      const sx = (inv[0] * cx + inv[1] * cy + inv[2]) / w - 0.5;
      const sy = (inv[3] * cx + inv[4] * cy + inv[5]) / w - 0.5;
      if (!(sx >= -0.5 && sy >= -0.5 && sx <= width - 0.5 && sy <= height - 0.5) || (mask && !mask(x, y))) {
        for (let k = 0; k < channels; k++) out[o + k] = fill;
        continue;
      }
      valid++;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(height - 1, Math.floor(sy)));
      const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const a = (y0 * width + x0) * channels, b = (y0 * width + x1) * channels;
      const c = (y1 * width + x0) * channels, d = (y1 * width + x1) * channels;
      for (let k = 0; k < channels; k++) {
        out[o + k] = Math.round((data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[c + k] * (1 - fx) + data[d + k] * fx) * fy);
      }
    }
  }
  return { img: { data: out, width: outW, height: outH, channels }, validFraction: valid / (outW * outH) };
}

// Dominant text/line direction by projection profiles: the angle at which
// dark pixels pile up into the sharpest rows. Returns the clockwise skew in
// degrees (rotate by -skew to straighten) and a 0..1 confidence.
export async function estimateSkew(img, { maxAngle = 15 } = {}) {
  let gray = await toGray(img);
  const long = Math.max(gray.width, gray.height);
  if (long > 800) {
    const k = 800 / long;
    gray = await rawImage(fromRaw(gray).resize({ width: Math.max(1, Math.round(gray.width * k)), height: Math.max(1, Math.round(gray.height * k)) }).extractChannel(0));
  }
  const { data, width, height } = gray;
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length;
  // Foreground = the minority side of the mean (dark ink on light, or the reverse).
  let dark = 0;
  for (const v of data) if (v < mean - 20) dark++;
  const darkIsInk = dark <= data.length / 2;
  const pts = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = data[y * width + x];
    if (darkIsInk ? v < mean - 20 : v > mean + 20) pts.push(x - width / 2, y - height / 2);
  }
  const n = pts.length / 2;
  if (n < 50) return { angle: 0, confidence: 0, reason: "too few line or text pixels to estimate a skew" };
  const stride = Math.max(1, Math.floor(n / 40000));
  const bins = new Float64Array(Math.ceil(Math.hypot(width, height)) + 4);
  const score = (deg) => {
    const r = (deg * Math.PI) / 180, s = Math.sin(r), c = Math.cos(r);
    bins.fill(0);
    const off = bins.length / 2;
    for (let i = 0; i < n; i += stride) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      bins[Math.floor(-x * s + y * c + off)]++;
    }
    let e = 0;
    for (const b of bins) e += b * b;
    return e;
  };
  const scores = [];
  let best = 0, bestScore = -1;
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += 0.5) {
    const sc = score(a); scores.push(sc);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  for (let a = best - 0.5; a <= best + 0.5 + 1e-9; a += 0.05) {
    const sc = score(a);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  scores.sort((x, y) => x - y);
  const median = scores[Math.floor(scores.length / 2)];
  const confidence = Math.max(0, Math.min(1, (bestScore - median) / bestScore));
  return { angle: Math.round(best * 100) / 100, confidence: Math.round(confidence * 1000) / 1000 };
}

const insidePolygon = (poly) => (x, y) => {
  const px = x + 0.5, py = y + 0.5;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

async function rotateBy(img, deg, fill) {
  const q = ((deg % 360) + 360) % 360;
  const { width: w, height: h } = img;
  if (Number.isInteger(deg) && q % 90 === 0) {
    if (q === 0) return { img, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], validFraction: 1, exact: true };
    const matrix = { 90: [0, -1, h, 1, 0, 0, 0, 0, 1], 180: [-1, 0, w, 0, -1, h, 0, 0, 1], 270: [0, 1, 0, -1, 0, w, 0, 0, 1] }[q];
    return { img: await rawImage(fromRaw(img).rotate(q)), matrix, validFraction: 1, exact: true };
  }
  const r = (deg * Math.PI) / 180;
  const W = Math.ceil(Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r)));
  const H = Math.ceil(Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r)));
  const matrix = chain(translate(-w / 2, -h / 2), rotateM(deg), translate(W / 2, H / 2));
  const out = warp(img, invert(matrix), W, H, { fill });
  return { ...out, matrix, exact: false };
}

// Runs the geometry list. ctx.steps are the transform steps so far
// (normalized -> analysis), used to place corners and polygons given in
// normalized image coordinates.
export async function geometryStage(img, geometry, { steps: before }) {
  const steps = [], warnings = [];
  let validFraction = 1;
  const toAnalysis = () => composeSteps([...before, ...steps]);
  const space = () => (steps.length ? steps[steps.length - 1].to : before[before.length - 1].to);
  for (const [i, g] of geometry.entries()) {
    const fill = g.fill === "black" ? 0 : 255;
    const from = space(), to = "geometry-" + (i + 1);
    if (g.op === "rotate" || g.op === "deskew") {
      let deg = g.op === "rotate" ? g.degrees : 0, estimate = null;
      if (g.op === "deskew") {
        estimate = await estimateSkew(img, { maxAngle: g.maxAngle ?? 15 });
        if (estimate.confidence < (g.minConfidence ?? 0.05)) {
          warnings.push("deskew: " + (estimate.reason ?? "no clear dominant line direction (confidence " + estimate.confidence + ")") + "; left unrotated");
          deg = 0;
        } else deg = -estimate.angle;
      }
      const r = await rotateBy(img, deg, fill);
      img = r.img; validFraction *= r.validFraction;
      steps.push(step(g.op, from, to, r.matrix, { degrees: deg, interpolation: r.exact ? "exact" : "bilinear", ...(estimate ? { estimatedSkewDeg: estimate.angle, confidence: estimate.confidence } : {}) }));
      if (!r.exact && deg !== 0) warnings.push("rotated " + deg + "°: resampled bilinearly; corners outside the image are filled");
    } else if (g.op === "flip") {
      const m = g.axis === "vertical" ? [1, 0, 0, 0, -1, img.height, 0, 0, 1] : [-1, 0, img.width, 0, 1, 0, 0, 0, 1];
      img = await rawImage(g.axis === "vertical" ? fromRaw(img).flip() : fromRaw(img).flop());
      steps.push(step("flip", from, to, m, { axis: g.axis ?? "horizontal", interpolation: "exact" }));
    } else if (g.op === "pad") {
      const p = g.px;
      const c = fill;
      img = await rawImage(fromRaw(img).extend({ top: p, bottom: p, left: p, right: p, background: { r: c, g: c, b: c, alpha: 1 } }));
      validFraction *= (img.width - 2 * p) * (img.height - 2 * p) / (img.width * img.height);
      steps.push(step("pad", from, to, translate(p, p), { px: p }));
    } else if (g.op === "perspective") {
      const M = toAnalysis();
      const src = g.corners.map((p) => apply(M, p.x, p.y));
      const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      let W = g.width ?? Math.round(Math.max(len(src[0], src[1]), len(src[3], src[2])));
      let H = g.height ?? Math.round(Math.max(len(src[0], src[3]), len(src[1], src[2])));
      if (g.aspect) H = Math.round(W / g.aspect);
      if (W * H > config.maxAnalysisPixels) {
        const k = Math.sqrt(config.maxAnalysisPixels / (W * H));
        W = Math.floor(W * k); H = Math.floor(H * k);
        warnings.push("perspective output reduced to " + W + "x" + H + " to fit the analysis budget");
      }
      if (W < 2 || H < 2) throw new Error("perspective corners enclose too small an area");
      const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
      const Hm = fitTransform(src, dst, "homography");
      const inv = Hm && invert(Hm);
      if (!inv) throw new Error("perspective corners are degenerate (three in a line or crossing); give the four corners in order top-left, top-right, bottom-right, bottom-left");
      const out = warp(img, inv, W, H, { fill });
      img = out.img; validFraction *= out.validFraction;
      steps.push(step("perspective", from, to, Hm, { corners: g.corners, interpolation: "bilinear" }));
      warnings.push("perspective-corrected: valid only for a flat surface; " + (out.validFraction < 0.999 ? Math.round((1 - out.validFraction) * 100) + "% of the output lies outside the image" : "all output pixels come from the image"));
    } else if (g.op === "mask") {
      const M = toAnalysis();
      const poly = g.polygon.map((p) => apply(M, p.x, p.y));
      const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const out = warp(img, identity, img.width, img.height, { fill, mask: insidePolygon(poly) });
      img = out.img; validFraction *= out.validFraction;
      steps.push(step("mask", from, to, identity, { polygon: g.polygon }));
    } else {
      throw new Error("Unknown geometry step " + g.op);
    }
  }
  return { img, steps, warnings, validity: { validFraction: Math.round(validFraction * 10000) / 10000, fill: "outside pixels are white unless fill: black" } };
}
