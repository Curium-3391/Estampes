// Two-image registration (RFC PRE-05, D05-D08, D15): a transform from image
// A to image B from landmarks the model or user names, or from automatic
// feature matching. Automatic matching: Harris corners at five scales,
// oriented BRIEF descriptors, putative matches (ratio and mutual tests,
// plus a looser set kept around the most voted rotation), RANSAC for a
// rough transform, then guided matching: every feature looks for its
// partner near where the transform puts it, the transform is refitted, and
// the search tightens. The supporters that remain are compared with what
// the same search finds for shifted copies of the transform, the level
// chance reaches on that pair. Every result reports its quality (inliers,
// ratio, median and P95 reprojection error, held-out error, conditioning,
// coverage, residuals per area), says "failed" with reasons instead of
// forcing an alignment, and rates separately how far a fit that passed can
// be trusted across the whole image.
// A homography is only right for flat subjects; the result says so.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { entrySharp } from "../image-store.js";
import { rawImage, fromRaw, sameBands } from "../image-ops.js";
import {
  apply, invert, chain, scale, fitTransform, reprojectionErrors, percentile, condition, roundMatrix,
} from "./transform.js";
import { warp } from "./geometry.js";

export const REGISTER_VERSION = "2";
export const MODELS = Object.freeze(["similarity", "affine", "homography"]);
const MIN_POINTS = { similarity: 2, affine: 3, homography: 4 };
const MATCH_SIDE = 1024;

// Deterministic pseudo-random numbers (BRIEF pattern, RANSAC samples), so
// the same pair gives the same answer every time.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PATTERN = (() => {
  const r = rng(12345), out = [];
  const g = () => Math.max(-13, Math.min(13, Math.round((r() + r() + r() + r() - 2) * 7)));
  for (let i = 0; i < 256; i++) out.push([g(), g(), g(), g()]);
  return out;
})();

async function grayAt(entry, side) {
  const k = Math.min(1, side / Math.max(entry.width, entry.height));
  const width = Math.max(1, Math.round(entry.width * k)), height = Math.max(1, Math.round(entry.height * k));
  const img = await rawImage(entrySharp(entry).resize({ width, height }).greyscale().extractChannel(0));
  return { ...img, k: width / entry.width };
}

function harris(gray, { max = 600 } = {}) {
  const { data, width, height } = gray;
  const n = width * height;
  const ixx = new Float32Array(n), iyy = new Float32Array(n), ixy = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = (data[i + 1] - data[i - 1]) / 2, gy = (data[i + width] - data[i - width]) / 2;
    ixx[i] = gx * gx; iyy[i] = gy * gy; ixy[i] = gx * gy;
  }
  const box = (a, r = 2) => {
    const t = new Float32Array(n), o = new Float32Array(n);
    for (let y = 0; y < height; y++) { let s = 0; for (let x = -r; x < width; x++) { if (x + r < width) s += a[y * width + x + r]; if (x - r - 1 >= 0) s -= a[y * width + x - r - 1]; if (x >= 0) t[y * width + x] = s; } }
    for (let x = 0; x < width; x++) { let s = 0; for (let y = -r; y < height; y++) { if (y + r < height) s += t[(y + r) * width + x]; if (y - r - 1 >= 0) s -= t[(y - r - 1) * width + x]; if (y >= 0) o[y * width + x] = s; } }
    return o;
  };
  const sxx = box(ixx), syy = box(iyy), sxy = box(ixy);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) R[i] = sxx[i] * syy[i] - sxy[i] * sxy[i] - 0.04 * (sxx[i] + syy[i]) ** 2;
  // Local maxima away from the border, then the strongest per grid cell so
  // corners spread over the whole image instead of one textured patch.
  const margin = 18, cands = [];
  for (let y = margin; y < height - margin; y++) for (let x = margin; x < width - margin; x++) {
    const i = y * width + x, v = R[i];
    if (v <= 0) continue;
    let peak = true;
    for (let dy = -3; dy <= 3 && peak; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && R[i + dy * width + dx] > v) { peak = false; break; }
    if (peak) cands.push({ x, y, r: v });
  }
  cands.sort((a, b) => b.r - a.r);
  const cells = 8, per = Math.ceil(max / (cells * cells)) * 2, counts = new Map(), out = [];
  for (const c of cands) {
    const key = Math.floor((c.x / width) * cells) + "," + Math.floor((c.y / height) * cells);
    const k = counts.get(key) ?? 0;
    if (k >= per) continue;
    counts.set(key, k + 1); out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function describe(smooth, pts) {
  const { data, width } = smooth;
  return pts.map((p) => {
    let m01 = 0, m10 = 0;
    for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) {
      if (dx * dx + dy * dy > 225) continue;
      const v = data[(p.y + dy) * width + p.x + dx];
      m10 += dx * v; m01 += dy * v;
    }
    const a = Math.atan2(m01, m10), c = Math.cos(a), s = Math.sin(a);
    const bits = new Uint32Array(8);
    PATTERN.forEach(([x1, y1, x2, y2], i) => {
      const ax = Math.round(c * x1 - s * y1), ay = Math.round(s * x1 + c * y1);
      const bx = Math.round(c * x2 - s * y2), by = Math.round(s * x2 + c * y2);
      if (data[(p.y + ay) * width + p.x + ax] < data[(p.y + by) * width + p.x + bx]) bits[i >> 5] |= 1 << (i & 31);
    });
    return { ...p, angle: a, bits };
  });
}
const popcount = (v) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };
const hamming = (a, b) => { let d = 0; for (let i = 0; i < 8; i++) d += popcount(a[i] ^ b[i]); return d; };

// Features at five scales, in level-0 (matching image) pixel coordinates.
const LEVELS = [1, 0.7071, 0.5, 0.3536, 0.25];
const PER_LEVEL = 1200;
async function features(gray) {
  const out = [];
  for (const f of LEVELS) {
    const w = Math.round(gray.width * f), h = Math.round(gray.height * f);
    if (Math.min(w, h) < 64) break;
    const level = f === 1 ? gray : await rawImage(sameBands(gray, fromRaw(gray).resize({ width: w, height: h })));
    const smooth = await rawImage(sameBands(level, fromRaw(level).blur(DESCRIPTOR_BLUR)));
    for (const d of describe(smooth, harris(level, { max: Math.round(PER_LEVEL * f) }))) out.push({ ...d, x: (d.x + 0.5) / (w / gray.width), y: (d.y + 0.5) / (h / gray.height), level: f });
  }
  return out;
}
const DESCRIPTOR_BLUR = 2;

// Nearest and second-nearest descriptor for every feature of A in B (and
// nearest in A for every feature of B), in one pass over all pairs.
function nearest(fa, fb) {
  const na = fa.length, nb = fb.length;
  const A = new Uint32Array(na * 8), B = new Uint32Array(nb * 8);
  fa.forEach((f, i) => A.set(f.bits, i * 8)); fb.forEach((f, j) => B.set(f.bits, j * 8));
  const a1 = new Uint16Array(na).fill(999), a2 = new Uint16Array(na).fill(999), aj = new Int32Array(na).fill(-1);
  const b1 = new Uint16Array(nb).fill(999), bi = new Int32Array(nb).fill(-1);
  for (let i = 0; i < na; i++) {
    const o = i * 8;
    for (let j = 0; j < nb; j++) {
      const q = j * 8;
      const d = popcount(A[o] ^ B[q]) + popcount(A[o + 1] ^ B[q + 1]) + popcount(A[o + 2] ^ B[q + 2]) + popcount(A[o + 3] ^ B[q + 3]) +
        popcount(A[o + 4] ^ B[q + 4]) + popcount(A[o + 5] ^ B[q + 5]) + popcount(A[o + 6] ^ B[q + 6]) + popcount(A[o + 7] ^ B[q + 7]);
      if (d < a1[i]) { a2[i] = a1[i]; a1[i] = d; aj[i] = j; } else if (d < a2[i]) a2[i] = d;
      if (d < b1[j]) { b1[j] = d; bi[j] = i; }
    }
  }
  return { a1, a2, aj, bi };
}

// Putative matches: mutual nearest neighbours that pass the ratio test.
function match(fa, fb, { ratio = 0.8, maxDistance = 70, table = null } = {}) {
  const { a1, a2, aj, bi } = table ?? nearest(fa, fb);
  const out = [];
  for (let i = 0; i < fa.length; i++) {
    const j = aj[i];
    if (j < 0 || a1[i] > maxDistance || a1[i] >= ratio * a2[i] || bi[j] !== i) continue;
    out.push({ i, j, a: { x: fa[i].x, y: fa[i].y }, b: { x: fb[j].x, y: fb[j].y }, distance: a1[i] });
  }
  return out;
}

const wrapPi = (v) => { while (v > Math.PI) v -= 2 * Math.PI; while (v <= -Math.PI) v += 2 * Math.PI; return v; };

// Matches of one flat subject turn by about the same angle. Keep the
// matches around the most voted rotation (15 degree bins, +-30 degrees), so
// a looser ratio test can be afforded without drowning RANSAC in outliers.
function rotationConsensus(pairs, fa, fb) {
  const bins = 24, hist = new Float32Array(bins);
  const turn = pairs.map((p) => wrapPi(fb[p.j].angle - fa[p.i].angle));
  for (const t of turn) hist[Math.floor(((t + Math.PI) / (2 * Math.PI)) * bins) % bins]++;
  let best = 0, bestV = -1;
  for (let k = 0; k < bins; k++) { const v = hist[(k + bins - 1) % bins] + hist[k] + hist[(k + 1) % bins]; if (v > bestV) { bestV = v; best = k; } }
  const centre = ((best + 0.5) / bins) * 2 * Math.PI - Math.PI;
  return pairs.filter((_, k) => Math.abs(wrapPi(turn[k] - centre)) <= Math.PI / 6);
}

// B features in a coarse grid, for searching around a predicted position.
function gridIndex(fb, width, height, cell = 32) {
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell), cells = Array.from({ length: cols * rows }, () => []);
  fb.forEach((f, j) => { const c = Math.min(cols - 1, Math.max(0, Math.floor(f.x / cell))), r = Math.min(rows - 1, Math.max(0, Math.floor(f.y / cell))); cells[r * cols + c].push(j); });
  return { cells, cols, rows, cell, width, height };
}

// Guided matching: with a transform in hand, every feature of A looks for
// its partner only near where the transform puts it, among B features whose
// orientation agrees with the transform's local rotation. No ratio test is
// needed there, so repeated structures (pins, pads) can match. Each B
// feature is used once. Returns the pairs and how many A features fell
// inside B at all.
function guided(H, fa, fb, index, { radius, maxDistance = GUIDED_DISTANCE, maxTurn = Math.PI / 6 }) {
  const taken = new Map();
  let inside = 0;
  for (let i = 0; i < fa.length; i++) {
    const f = fa[i], p = apply(H, f.x, f.y);
    if (!(p.w > 0) || p.x < 0 || p.y < 0 || p.x >= index.width || p.y >= index.height) continue;
    inside++;
    const q = apply(H, f.x + 6 * Math.cos(f.angle), f.y + 6 * Math.sin(f.angle));
    const expected = Math.atan2(q.y - p.y, q.x - p.x);
    const c0 = Math.max(0, Math.floor((p.x - radius) / index.cell)), c1 = Math.min(index.cols - 1, Math.floor((p.x + radius) / index.cell));
    const r0 = Math.max(0, Math.floor((p.y - radius) / index.cell)), r1 = Math.min(index.rows - 1, Math.floor((p.y + radius) / index.cell));
    let best = -1, bestD = maxDistance + 1, bestE = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) for (const j of index.cells[r * index.cols + c]) {
      const g = fb[j], e = Math.hypot(g.x - p.x, g.y - p.y);
      if (e > radius || Math.abs(wrapPi(g.angle - expected)) > maxTurn) continue;
      const d = hamming(f.bits, g.bits);
      if (d < bestD || (d === bestD && e < bestE)) { bestD = d; best = j; bestE = e; }
    }
    if (best < 0) continue;
    const prev = taken.get(best);
    if (!prev || bestD < prev.distance || (bestD === prev.distance && bestE < prev.error)) taken.set(best, { i, j: best, a: { x: f.x, y: f.y }, b: { x: fb[best].x, y: fb[best].y }, distance: bestD, error: bestE });
  }
  return { pairs: [...taken.values()].sort((u, v) => u.i - v.i), inside };
}
const GUIDED_DISTANCE = 72;
// Support must exceed CHANCE_FACTOR x the chance level + CHANCE_MARGIN.
const CHANCE_FACTOR = 5, CHANCE_MARGIN = 10;
// ... and at least this share of A's features inside B must find a partner.
// Unrelated boards reach about 0.02 through the search for the best fit.
const MIN_REPEATABILITY = 0.04;

// Sign of the Jacobian of a projective map at (x, y): negative when the map
// reverses orientation there.
function orientationReversing(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8], u = H[0] * x + H[1] * y + H[2], v = H[3] * x + H[4] * y + H[5];
  const a = (H[0] * w - u * H[6]), b = (H[1] * w - u * H[7]), c = (H[3] * w - v * H[6]), d = (H[4] * w - v * H[7]);
  return a * d - b * c < 0;
}

// From a rough transform to a refined one: search around it, refit, search
// again closer. Returns null when the support melts away.
function refine(H0, fa, fb, index, model, thr) {
  let H = H0;
  for (const [radius, tol] of [[28, 14], [16, 8], [10, thr], [8, thr]]) {
    const { pairs } = guided(H, fa, fb, index, { radius });
    if (pairs.length < MIN_POINTS[model] + 2) return null;
    const fit = ransac(pairs, model, { threshold: tol, iterations: 400, seed: 11 });
    if (!fit) return null;
    H = fit.H;
  }
  return H;
}

// How many A features find a partner within `thr` of where H puts them.
const supportOf = (H, fa, fb, index, thr) => { const g = guided(H, fa, fb, index, { radius: thr }); return { pairs: g.pairs, inside: g.inside }; };

// Automatic matching in match-image pixels. Several rough transforms are
// proposed (from strict and from loose putative matches, as affine and as
// the requested model), each is refined by guided matching, and the one
// that ends with the most support wins. Its support is then compared with
// what the same search finds for shifted copies of the transform, which is
// the level chance alone reaches on this pair of images.
function autoMatch(fa, fb, sizeA, sizeB, model, thr) {
  const table = nearest(fa, fb);
  const strict = match(fa, fb, { table });
  const loose = rotationConsensus(match(fa, fb, { ratio: 0.92, maxDistance: 80, table }), fa, fb);
  const index = gridIndex(fb, sizeB.width, sizeB.height);
  const rough = [];
  for (const [set, seed] of [[strict, 7], [loose, 8]]) {
    if (set.length >= MIN_POINTS[model]) { const f = ransac(set, model, { threshold: thr, seed }); if (f) rough.push(f.H); }
    // An affine guess needs one point fewer and tolerates a low inlier
    // share better; perspective is then recovered by the refinement.
    if (model === "homography" && set.length >= 3) { const f = ransac(set, "affine", { threshold: 4 * thr, seed: seed + 10 }); if (f) rough.push(f.H); }
  }
  let best = null;
  for (const H0 of rough) {
    const H = refine(H0, fa, fb, index, model, thr);
    if (!H) continue;
    const s = supportOf(H, fa, fb, index, thr);
    if (!best || s.pairs.length > best.pairs.length) best = { H, ...s };
  }
  const putative = { strict: strict.length, loose: loose.length };
  if (!best) return { putative, pairs: strict, H: null };
  // Chance level: the same count for the transform shifted off target.
  let chance = 0;
  for (const [dx, dy] of [[0.17, 0.11], [-0.17, 0.11], [0.17, -0.11], [-0.17, -0.11], [0.31, 0], [0, 0.31]]) {
    const decoy = chain([1, 0, dx * sizeA.width, 0, 1, dy * sizeA.height, 0, 0, 1], best.H);
    chance = Math.max(chance, supportOf(decoy, fa, fb, index, thr).pairs.length);
  }
  return { putative, H: best.H, pairs: best.pairs, inside: best.inside, chance };
}

// RANSAC over correspondences in pixel space; threshold in A pixels after
// mapping B back (symmetric enough for the sizes used here).
export function ransac(pairs, model, { threshold = 3, iterations = 2000, seed = 7 } = {}) {
  const need = MIN_POINTS[model];
  if (pairs.length < need) return null;
  const from = pairs.map((p) => p.a), to = pairs.map((p) => p.b);
  if (pairs.length === need) {
    const H = fitTransform(from, to, model);
    return H && { H, inliers: pairs.map((_, i) => i) };
  }
  const r = rng(seed);
  let bestInliers = [], bestH = null;
  for (let it = 0; it < iterations; it++) {
    const pick = new Set();
    while (pick.size < need) pick.add(Math.floor(r() * pairs.length));
    const idx = [...pick];
    const H = fitTransform(idx.map((i) => from[i]), idx.map((i) => to[i]), model);
    if (!H) continue;
    const errs = reprojectionErrors(H, from, to);
    const inl = [];
    errs.forEach((e, i) => { if (e < threshold) inl.push(i); });
    if (inl.length > bestInliers.length) { bestInliers = inl; bestH = H; }
    if (bestInliers.length > 0.9 * pairs.length) break;
  }
  if (!bestH) return null;
  const refit = fitTransform(bestInliers.map((i) => from[i]), bestInliers.map((i) => to[i]), model) ?? bestH;
  const errs = reprojectionErrors(refit, from, to);
  return { H: refit, inliers: errs.map((e, i) => (e < threshold ? i : -1)).filter((i) => i >= 0) };
}

function hullArea(pts) {
  if (pts.length < 3) return 0;
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  const h = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let a = 0;
  for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i].x * h[j].y - h[j].x * h[i].y; }
  return Math.abs(a) / 2;
}

// Residuals per cell of a 4x4 grid over A: where the alignment is known to
// fit, where it does not, and where nothing was measured.
function residualGrid(points, errors, width, height, cells = 4) {
  const grid = [];
  for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) {
    const inCell = errors.filter((_, i) => Math.min(cells - 1, Math.floor((points[i].x / width) * cells)) === c && Math.min(cells - 1, Math.floor((points[i].y / height) * cells)) === r);
    grid.push({ cell: String.fromCharCode(65 + r) + (c + 1), points: inCell.length, medianErrorPx: inCell.length ? Number(percentile(inCell, 50).toFixed(2)) : null });
  }
  return grid;
}

const flipX = (w) => [-1, 0, w, 0, 1, 0, 0, 0, 1];

// Accuracy on points the fit did not see. Landmarks: each one is predicted
// from all the others (leave-one-out). Auto: the supporters are split in
// two halves and each half is predicted from the other. Null when there are
// too few points to hold any out.
function heldOutErrors(pts, model, method) {
  const need = MIN_POINTS[model], errs = [];
  if (method === "landmarks") {
    if (pts.length <= need) return null;
    for (let i = 0; i < pts.length; i++) {
      const rest = pts.filter((_, k) => k !== i);
      const H = fitTransform(rest.map((p) => p.a), rest.map((p) => p.b), model);
      if (!H) return null;
      errs.push(reprojectionErrors(H, [pts[i].a], [pts[i].b])[0]);
    }
    return { scheme: "leave-one-out", errs };
  }
  if (pts.length < 2 * (need + 2)) return null;
  for (const parity of [0, 1]) {
    const fitSet = pts.filter((_, k) => k % 2 === parity), test = pts.filter((_, k) => k % 2 !== parity);
    const H = fitTransform(fitSet.map((p) => p.a), fitSet.map((p) => p.b), model);
    if (!H) return null;
    errs.push(...reprojectionErrors(H, test.map((p) => p.a), test.map((p) => p.b)));
  }
  return { scheme: "split-half", errs };
}

// How far a fitted transform can be trusted as an alignment of the whole
// image. A fit that passed its checks ("ok") is not yet that: four
// landmarks always fit a homography exactly, and points in one corner say
// nothing about the opposite one.
function alignmentConfidence({ method, model, inliers, rejected, worstRejectedPx, coverage, held, thr }) {
  const order = ["high", "medium", "low", "unverified"], why = [];
  let level = 0;
  const lower = (to, text) => { level = Math.max(level, order.indexOf(to)); why.push(text); };
  if (method === "landmarks") {
    if (inliers <= MIN_POINTS[model]) lower("unverified", "a " + model + " passes exactly through " + MIN_POINTS[model] + " points, so zero residuals here are by construction and say nothing about accuracy; add landmarks to check it");
    else if (inliers < 8) lower("medium", "only " + inliers + " landmarks support the fit");
    if (rejected) lower(rejected * 4 >= inliers ? "low" : "medium", rejected + " landmark" + (rejected === 1 ? " does" : "s do") + " not fit (up to " + worstRejectedPx.toFixed(0) + " px off): a misplaced landmark, or a subject that is not flat");
  }
  if (held) {
    const med = percentile(held.errs, 50), p95 = percentile(held.errs, 95);
    if (med > thr) lower("low", "held-out points miss by a median of " + med.toFixed(1) + " px");
    else if (p95 > 2 * thr) lower("medium", "some held-out points miss by " + p95.toFixed(1) + " px");
  }
  if (coverage < 0.1) lower("low", "the supporting points span only " + Math.round(coverage * 100) + "% of image A; elsewhere the alignment is extrapolated, not measured");
  else if (coverage < 0.25) lower("medium", "the supporting points span " + Math.round(coverage * 100) + "% of image A; elsewhere the alignment is extrapolated");
  return { level: order[level], why };
}

// Register B onto A. Points come as normalized coordinates of each image.
// Returns matrices in normalized and in working pixel coordinates.
export async function registerPair(a, b, { method = "auto", landmarks = [], model = "homography", mirror = false, threshold, minInliers, minInlierRatio } = {}) {
  const reasons = [], notes = [];
  const Wa = a.width, Ha = a.height, Wb = b.width, Hb = b.height;
  // Work in working pixels of each image; B optionally mirrored first.
  const pre = mirror ? flipX(Wb) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let pairs, matchScaleA = 1, featureCounts = null, auto = null;
  if (method === "landmarks") {
    pairs = landmarks.map((l) => ({ a: { x: l.a.x * Wa, y: l.a.y * Ha }, b: apply(pre, l.b.x * Wb, l.b.y * Hb) }));
    if (pairs.length < MIN_POINTS[model]) reasons.push(model + " needs at least " + MIN_POINTS[model] + " landmark pairs, got " + pairs.length);
  } else {
    const ga = await grayAt(a, MATCH_SIDE), gb0 = await grayAt(b, MATCH_SIDE);
    const gb = mirror ? await rawImage(sameBands(gb0, fromRaw(gb0).flop())) : gb0;
    const fa = await features(ga), fb = await features(gb);
    featureCounts = { a: fa.length, b: fb.length };
    matchScaleA = ga.k;
    auto = autoMatch(fa, fb, ga, gb, model, threshold ? threshold * ga.k : 3);
    // Back to working pixels (B: still mirrored, matching `pre`).
    pairs = auto.pairs.map((p) => ({ a: { x: p.a.x / ga.k, y: p.a.y / ga.k }, b: { x: p.b.x / gb0.k, y: p.b.y / gb0.k }, distance: p.distance }));
    if (auto.H) auto.H = chain(scale(ga.k), auto.H, scale(1 / gb0.k));
    if (fa.length < 30 || fb.length < 30) reasons.push("too few distinctive corners (" + fa.length + " / " + fb.length + "); glare, blur or a plain surface");
    if (!auto.H && auto.putative.strict < 8) reasons.push("only " + auto.putative.strict + " descriptor matches survived the ratio and mutual tests");
  }
  const thr = threshold ?? (method === "landmarks" ? Math.max(Wa, Ha) * 0.02 : 3 / matchScaleA);
  // Auto: the guided search already chose the transform and its supporters.
  const fit = reasons.length ? null : auto ? (auto.H ? { H: auto.H, inliers: pairs.map((_, i) => i) } : null) : ransac(pairs, model, { threshold: thr });
  if (!fit && !reasons.length) reasons.push("no consistent " + model + " found");
  let result = { status: "failed" };
  if (fit) {
    const AtoBm = fit.H;                          // A px -> mirrored B px
    const AtoB = chain(AtoBm, invert(pre));       // A px -> B px
    const inl = fit.inliers;
    const errs = reprojectionErrors(AtoBm, inl.map((i) => pairs[i].a), inl.map((i) => pairs[i].b));
    const inlierPts = inl.map((i) => pairs[i].a);
    const need = minInliers ?? (method === "landmarks" ? MIN_POINTS[model] : 12);
    // Auto: the share of A's features inside B that found their partner.
    const ratio = auto ? inl.length / Math.max(1, auto.inside) : inl.length / pairs.length;
    const cond = condition(AtoB);
    const coverage = hullArea(inlierPts) / (Wa * Ha);
    if (inl.length < need) reasons.push(inl.length + " inliers, fewer than " + need);
    if (auto && inl.length < CHANCE_FACTOR * auto.chance + CHANCE_MARGIN) reasons.push(inl.length + " supporting matches is not clearly above the " + auto.chance + " that a shifted transform reaches by chance on this pair");
    const floor = minInlierRatio ?? (auto ? MIN_REPEATABILITY : undefined);
    if (method !== "landmarks" && floor !== undefined && ratio < floor) reasons.push("inlier ratio " + ratio.toFixed(3) + " below " + floor);
    // A transform that turns the image over is a mirror image, not a view of
    // the same side; only symmetric details can support it.
    if (auto && orientationReversing(AtoBm, Wa / 2, Ha / 2)) reasons.push("the best fit is a mirror image of B; pass mirror: true if B is flipped (the back of a board, a mirrored scan)");
    if (!Number.isFinite(cond) || cond > 1e8) reasons.push("transform is ill-conditioned");
    if (method !== "landmarks" && coverage < 0.05) notes.push("inliers cover only " + Math.round(coverage * 100) + "% of image A; the fit is unverified elsewhere");
    if (model === "homography") notes.push("a homography is exact only for flat subjects (a board, a page); parallax or bent parts will not line up");
    const held = heldOutErrors(inl.map((i) => pairs[i]), model, method);
    const allErrs = reprojectionErrors(AtoBm, pairs.map((p) => p.a), pairs.map((p) => p.b));
    const rejectedErrs = allErrs.filter((_, i) => !inl.includes(i));
    const confidence = alignmentConfidence({ method, model, inliers: inl.length, rejected: method === "landmarks" ? rejectedErrs.length : 0, worstRejectedPx: Math.max(0, ...rejectedErrs), coverage, held, thr });
    const toNorm = (W, H) => scale(1 / W, 1 / H), fromNorm = (W, H) => scale(W, H);
    const nA2B = chain(fromNorm(Wa, Ha), AtoB, toNorm(Wb, Hb));
    const nB2A = invert(nA2B);
    result = {
      status: reasons.length ? "failed" : "ok",
      // "ok" says a transform was fitted and passed its checks; this says
      // how far to trust it across the whole image.
      alignmentConfidence: reasons.length ? "none" : confidence.level,
      ...(reasons.length || !confidence.why.length ? {} : { confidenceReasons: confidence.why }),
      model, mirror,
      normalizedAtoB: roundMatrix(nA2B), normalizedBtoA: nB2A ? roundMatrix(nB2A) : null,
      pixelAtoB: roundMatrix(AtoB),
      quality: {
        correspondences: auto ? auto.inside : pairs.length, inliers: inl.length, inlierRatio: Number(ratio.toFixed(3)),
        ...(auto ? { putativeMatches: auto.putative.strict, chanceInliers: auto.chance } : {}),
        medianErrorPx: Number((percentile(errs, 50) ?? 0).toFixed(3)), p95ErrorPx: Number((percentile(errs, 95) ?? 0).toFixed(3)),
        thresholdPx: Number(thr.toFixed(2)), condition: Number(cond.toPrecision(4)), coverage: Number(coverage.toFixed(3)),
        // Errors at points the fit did not use; the residuals above are
        // at the points it was fitted to and flatter it.
        heldOut: held ? { scheme: held.scheme, points: held.errs.length, medianErrorPx: Number(percentile(held.errs, 50).toFixed(3)), p95ErrorPx: Number(percentile(held.errs, 95).toFixed(3)), maxErrorPx: Number(Math.max(...held.errs).toFixed(3)) } : null,
        residualsByCell: residualGrid(inlierPts, errs, Wa, Ha),
        ...(featureCounts ? { features: featureCounts } : {}),
        errorUnits: "working pixels of image B",
      },
      ...(method === "landmarks" ? { landmarkResiduals: allErrs.map((e, i) => ({ index: i, errorPx: Number(e.toFixed(2)), inlier: inl.includes(i) })) } : {}),
      inlierPairs: inl.filter((_, k) => k % Math.max(1, Math.ceil(inl.length / 60)) === 0).slice(0, 60).map((i) => ({ a: { x: pairs[i].a.x / Wa, y: pairs[i].a.y / Ha }, b: (() => { const q = apply(invert(pre), pairs[i].b.x, pairs[i].b.y); return { x: q.x / Wb, y: q.y / Hb }; })() })),
    };
  }
  const id = "reg:" + createHash("sha256").update([a.imageId, b.imageId, method, model, mirror, JSON.stringify(landmarks), REGISTER_VERSION].join("|")).digest("hex").slice(0, 16);
  return { registrationId: id, version: REGISTER_VERSION, method, a: a.imageId, b: b.imageId, ...result, ...(reasons.length ? { reasons } : {}), notes };
}

// Visual check of a registration in A's frame: B warped onto A as a 50%
// overlay, an absolute difference, a checkerboard, or the matches drawn
// side by side. Also SSIM / mean difference where both images have pixels.
export async function compareView(a, b, reg, { mode = "overlay", side = 1024 } = {}) {
  const ka = Math.min(1, side / Math.max(a.width, a.height));
  const W = Math.max(1, Math.round(a.width * ka)), H = Math.max(1, Math.round(a.height * ka));
  const A = await rawImage(entrySharp(a).resize({ width: W, height: H }));
  if (mode === "matches") {
    const kb = Math.min(1, side / Math.max(b.width, b.height));
    const Wb = Math.round(b.width * kb), Hb = Math.round(b.height * kb);
    const Hc = Math.max(H, Hb);
    const lines = (reg.inlierPairs ?? []).map((p, i) => {
      const col = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0"][i % 6];
      return `<line x1="${p.a.x * W}" y1="${p.a.y * H}" x2="${W + p.b.x * Wb}" y2="${p.b.y * Hb}" stroke="${col}" stroke-width="1.5"/><circle cx="${p.a.x * W}" cy="${p.a.y * H}" r="3" fill="none" stroke="${col}"/><circle cx="${W + p.b.x * Wb}" cy="${p.b.y * Hb}" r="3" fill="none" stroke="${col}"/>`;
    }).join("");
    const bImg = await entrySharp(b).resize({ width: Wb, height: Hb }).png().toBuffer();
    const data = await sharp({ create: { width: W + Wb, height: Hc, channels: 3, background: "#ffffff" } })
      .composite([{ input: await fromRaw(A).png().toBuffer(), left: 0, top: 0 }, { input: bImg, left: W, top: 0 },
        { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W + Wb}" height="${Hc}">${lines}</svg>`), left: 0, top: 0 }])
      .jpeg({ quality: 85 }).toBuffer();
    return { data, mimeType: "image/jpeg", width: W + Wb, height: Hc, metrics: null };
  }
  if (!reg.normalizedBtoA) throw new Error("This registration has no usable transform to compare");
  const B = await rawImage(entrySharp(b));
  // A-display px -> normalized A -> normalized B -> B working px
  const toB = chain(scale(1 / W, 1 / H), reg.normalizedAtoB, scale(b.width, b.height));
  const valid = new Uint8Array(W * H);
  const warped = warp(B, toB, W, H, { fill: 0 });
  // Validity again, per pixel, for metrics.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = apply(toB, x + 0.5, y + 0.5);
    valid[y * W + x] = q.x >= 0 && q.y >= 0 && q.x <= b.width && q.y <= b.height ? 1 : 0;
  }
  const ch = A.channels, wa = warped.img.data, aa = A.data;
  const out = Buffer.alloc(W * H * 3);
  const ga = new Float32Array(W * H), gb = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const la = 0.299 * aa[i * ch] + 0.587 * aa[i * ch + 1] + 0.114 * aa[i * ch + 2];
    const lb = 0.299 * wa[i * ch] + 0.587 * wa[i * ch + 1] + 0.114 * wa[i * ch + 2];
    ga[i] = la; gb[i] = lb;
    const x = i % W, y = (i - x) / W;
    for (let k = 0; k < 3; k++) {
      const va = aa[i * ch + k], vb = wa[i * ch + k];
      let v;
      if (!valid[i]) v = mode === "difference" ? 0 : Math.round(va * 0.4 + 153);
      else if (mode === "difference") v = Math.abs(la - lb);
      else if (mode === "checkerboard") v = ((Math.floor(x / 48) + Math.floor(y / 48)) % 2) ? vb : va;
      else v = Math.round((va + vb) / 2);
      out[i * 3 + k] = v;
    }
  }
  const metrics = overlapMetrics(ga, gb, valid, W, H);
  const data = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  return { data, mimeType: "image/jpeg", width: W, height: H, metrics };
}

// Mean absolute difference, PSNR and SSIM (8x8 windows) over the overlap.
// Lighting changes lower them without any misalignment; read with care.
export function overlapMetrics(ga, gb, valid, W, H) {
  let n = 0, sad = 0, sse = 0;
  for (let i = 0; i < ga.length; i++) if (valid[i]) { n++; const d = ga[i] - gb[i]; sad += Math.abs(d); sse += d * d; }
  if (!n) return { overlap: 0 };
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let ssim = 0, windows = 0;
  for (let y = 0; y + 8 <= H; y += 8) for (let x = 0; x + 8 <= W; x += 8) {
    let ok = true, ma = 0, mb = 0;
    for (let yy = y; yy < y + 8 && ok; yy++) for (let xx = x; xx < x + 8; xx++) { const i = yy * W + xx; if (!valid[i]) { ok = false; break; } ma += ga[i]; mb += gb[i]; }
    if (!ok) continue;
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let yy = y; yy < y + 8; yy++) for (let xx = x; xx < x + 8; xx++) { const i = yy * W + xx; va += (ga[i] - ma) ** 2; vb += (gb[i] - mb) ** 2; cov += (ga[i] - ma) * (gb[i] - mb); }
    va /= 63; vb /= 63; cov /= 63;
    ssim += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
    windows++;
  }
  const mse = sse / n;
  return {
    overlap: Number((n / ga.length).toFixed(3)),
    meanAbsDiff: Number((sad / n).toFixed(2)),
    psnr: mse ? Number((10 * Math.log10(255 ** 2 / mse)).toFixed(2)) : null,
    ssim: windows ? Number((ssim / windows).toFixed(4)) : null,
  };
}
