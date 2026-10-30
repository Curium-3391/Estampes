// Two-image registration (RFC PRE-05, D05-D08, D15): a transform from image
// A to image B from landmarks the model or user names, or from automatic
// feature matching (Harris corners, oriented BRIEF descriptors, ratio and
// mutual tests, RANSAC). Every result reports its quality (inliers, ratio,
// median and P95 reprojection error, conditioning, coverage, residuals per
// area) and says "failed" with reasons instead of forcing an alignment.
// A homography is only right for flat subjects; the result says so.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { entrySharp } from "../image-store.js";
import { rawImage, fromRaw, sameBands } from "../image-ops.js";
import {
  apply, invert, chain, scale, fitTransform, reprojectionErrors, percentile, condition, roundMatrix,
} from "./transform.js";
import { warp } from "./geometry.js";

export const REGISTER_VERSION = "1";
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

// Features at four scales, in level-0 (matching image) pixel coordinates.
async function features(gray) {
  const out = [];
  for (const f of [1, 0.7071, 0.5, 0.3536]) {
    const w = Math.round(gray.width * f), h = Math.round(gray.height * f);
    if (Math.min(w, h) < 64) break;
    const level = f === 1 ? gray : await rawImage(sameBands(gray, fromRaw(gray).resize({ width: w, height: h })));
    const smooth = await rawImage(sameBands(level, fromRaw(level).blur(1.6)));
    for (const d of describe(smooth, harris(level, { max: Math.round(500 * f) }))) out.push({ ...d, x: (d.x + 0.5) / (w / gray.width), y: (d.y + 0.5) / (h / gray.height), level: f });
  }
  return out;
}

function match(fa, fb, { ratio = 0.8, maxDistance = 70 } = {}) {
  const best = (f, pool) => {
    let d1 = 999, d2 = 999, j1 = -1;
    for (let j = 0; j < pool.length; j++) {
      const d = hamming(f.bits, pool[j].bits);
      if (d < d1) { d2 = d1; d1 = d; j1 = j; } else if (d < d2) d2 = d;
    }
    return { j: j1, d1, d2 };
  };
  const ab = fa.map((f) => best(f, fb));
  const ba = fb.map((f) => best(f, fa));
  const out = [];
  ab.forEach((m, i) => {
    if (m.j < 0 || m.d1 > maxDistance || m.d1 >= ratio * m.d2 || ba[m.j].j !== i) return;
    out.push({ a: { x: fa[i].x, y: fa[i].y }, b: { x: fb[m.j].x, y: fb[m.j].y }, distance: m.d1 });
  });
  return out;
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

// Register B onto A. Points come as normalized coordinates of each image.
// Returns matrices in normalized and in working pixel coordinates.
export async function registerPair(a, b, { method = "auto", landmarks = [], model = "homography", mirror = false, threshold, minInliers, minInlierRatio = 0.25 } = {}) {
  const reasons = [], notes = [];
  const Wa = a.width, Ha = a.height, Wb = b.width, Hb = b.height;
  // Work in working pixels of each image; B optionally mirrored first.
  const pre = mirror ? flipX(Wb) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let pairs, matchScaleA = 1, featureCounts = null;
  if (method === "landmarks") {
    pairs = landmarks.map((l) => ({ a: { x: l.a.x * Wa, y: l.a.y * Ha }, b: apply(pre, l.b.x * Wb, l.b.y * Hb) }));
    if (pairs.length < MIN_POINTS[model]) reasons.push(model + " needs at least " + MIN_POINTS[model] + " landmark pairs, got " + pairs.length);
  } else {
    const ga = await grayAt(a, MATCH_SIDE), gb0 = await grayAt(b, MATCH_SIDE);
    const gb = mirror ? await rawImage(sameBands(gb0, fromRaw(gb0).flop())) : gb0;
    const fa = await features(ga), fb = await features(gb);
    featureCounts = { a: fa.length, b: fb.length };
    const m = match(fa, fb);
    matchScaleA = ga.k;
    // Back to working pixels (B: still mirrored, matching `pre`).
    pairs = m.map((p) => ({ a: { x: p.a.x / ga.k, y: p.a.y / ga.k }, b: { x: p.b.x / gb0.k, y: p.b.y / gb0.k }, distance: p.distance }));
    if (fa.length < 30 || fb.length < 30) reasons.push("too few distinctive corners (" + fa.length + " / " + fb.length + "); glare, blur or a plain surface");
    if (pairs.length < 8) reasons.push("only " + pairs.length + " descriptor matches survived the ratio and mutual tests");
  }
  const thr = threshold ?? (method === "landmarks" ? Math.max(Wa, Ha) * 0.02 : 3 / matchScaleA);
  const fit = reasons.length ? null : ransac(pairs, model, { threshold: thr });
  if (!fit && !reasons.length) reasons.push("no consistent " + model + " found");
  let result = { status: "failed" };
  if (fit) {
    const AtoBm = fit.H;                          // A px -> mirrored B px
    const AtoB = chain(AtoBm, invert(pre));       // A px -> B px
    const inl = fit.inliers;
    const errs = reprojectionErrors(AtoBm, inl.map((i) => pairs[i].a), inl.map((i) => pairs[i].b));
    const inlierPts = inl.map((i) => pairs[i].a);
    const need = minInliers ?? (method === "landmarks" ? MIN_POINTS[model] : 12);
    const ratio = inl.length / pairs.length;
    const cond = condition(AtoB);
    const coverage = hullArea(inlierPts) / (Wa * Ha);
    if (inl.length < need) reasons.push(inl.length + " inliers, fewer than " + need);
    if (method !== "landmarks" && ratio < minInlierRatio) reasons.push("inlier ratio " + ratio.toFixed(2) + " below " + minInlierRatio);
    if (!Number.isFinite(cond) || cond > 1e8) reasons.push("transform is ill-conditioned");
    if (method !== "landmarks" && coverage < 0.05) notes.push("inliers cover only " + Math.round(coverage * 100) + "% of image A; the fit is unverified elsewhere");
    if (model === "homography") notes.push("a homography is exact only for flat subjects (a board, a page); parallax or bent parts will not line up");
    const toNorm = (W, H) => scale(1 / W, 1 / H), fromNorm = (W, H) => scale(W, H);
    const nA2B = chain(fromNorm(Wa, Ha), AtoB, toNorm(Wb, Hb));
    const nB2A = invert(nA2B);
    result = {
      status: reasons.length ? "failed" : "ok",
      model, mirror,
      normalizedAtoB: roundMatrix(nA2B), normalizedBtoA: nB2A ? roundMatrix(nB2A) : null,
      pixelAtoB: roundMatrix(AtoB),
      quality: {
        correspondences: pairs.length, inliers: inl.length, inlierRatio: Number(ratio.toFixed(3)),
        medianErrorPx: Number((percentile(errs, 50) ?? 0).toFixed(3)), p95ErrorPx: Number((percentile(errs, 95) ?? 0).toFixed(3)),
        thresholdPx: Number(thr.toFixed(2)), condition: Number(cond.toPrecision(4)), coverage: Number(coverage.toFixed(3)),
        residualsByCell: residualGrid(inlierPts, errs, Wa, Ha),
        ...(featureCounts ? { features: featureCounts } : {}),
        errorUnits: "working pixels of image B",
      },
      ...(method === "landmarks" ? { landmarkResiduals: reprojectionErrors(AtoBm, pairs.map((p) => p.a), pairs.map((p) => p.b)).map((e, i) => ({ index: i, errorPx: Number(e.toFixed(2)), inlier: inl.includes(i) })) } : {}),
      inlierPairs: inl.slice(0, 60).map((i) => ({ a: { x: pairs[i].a.x / Wa, y: pairs[i].a.y / Ha }, b: (() => { const q = apply(invert(pre), pairs[i].b.x, pairs[i].b.y); return { x: q.x / Wb, y: q.y / Hb }; })() })),
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
