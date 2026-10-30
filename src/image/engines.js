// Analysis engines (RFC PRE-08, F02, C03, C05, C10): pure functions from an
// image region to structured detections. An engine never touches the
// canvas; its output is evidence that GPT or the user may turn into marks.
// Every detection is in normalized coordinates of the oriented source
// image, carries the engine's name and version, and low-confidence results
// are labelled as such. Built-in engines are plain JS; optional ones (OCR)
// load lazily and report `unavailable` when their package is missing, so
// the core starts and works without them.
//
// engine = { id, version, kind, description, params (JSON-schema-ish),
//            available(): Promise<{ok, reason?}>, run(input): Promise<{detections, warnings?, quality?}> }
// input  = { img (analysis pixels), toNormalized(x, y) -> {x, y}, scaleToNormalized (px -> normalized length),
//            params, region, entry }
import { rawImage, fromRaw, toGray, sameBands } from "../image-ops.js";
import { analysisFor } from "./view.js";
import { canny } from "./ops-extra.js";

export const ENGINE_API = "estampes.engine/1";
const registry = new Map();

export function registerEngine(engine) {
  for (const key of ["id", "version", "kind", "description", "run"]) if (!engine[key]) throw new Error("engine needs " + key);
  if (registry.has(engine.id)) throw new Error("engine " + engine.id + " is already registered");
  registry.set(engine.id, { available: async () => ({ ok: true }), params: {}, ...engine });
  return engine.id;
}
export const getEngine = (id) => registry.get(id);
export async function listEngines() {
  return Promise.all([...registry.values()].map(async (e) => ({
    id: e.id, version: e.version, kind: e.kind, description: e.description, params: e.params, builtin: Boolean(e.builtin), ...(await e.available()),
  })));
}

const r5 = (v) => Number(v.toFixed(5));

// Run one engine on a region. Failure is a result, not a thrown error:
// { status: "failed", reasons } keeps the shape the same for GPT.
export async function runEngine(entry, id, { region, sampling, params = {} } = {}) {
  const engine = registry.get(id);
  if (!engine) throw new Error("Unknown engine " + id + "; available: " + [...registry.keys()].join(", "));
  const base = { apiVersion: ENGINE_API, engine: id, engineVersion: engine.version, kind: engine.kind, imageId: entry.imageId, sourceAssetId: entry.sourceAssetId ?? null };
  const avail = await engine.available();
  if (!avail.ok) return { ...base, status: "unavailable", reasons: [avail.reason], detections: [] };
  const { analysisPixels: a } = await analysisFor(entry, { region, sampling: { mode: "working", ...sampling } });
  const r = a.region;
  const toNormalized = (x, y) => ({ x: r5(r.x + (x / a.img.width) * (r.x2 - r.x)), y: r5(r.y + (y / a.img.height) * (r.y2 - r.y)) });
  const sx = (r.x2 - r.x) / a.img.width, sy = (r.y2 - r.y) / a.img.height;
  try {
    const out = await engine.run({ img: a.img, toNormalized, sx, sy, params, region: r, entry });
    return {
      ...base, status: out.status ?? "ok", region: r,
      analysis: { space: a.space, width: a.img.width, height: a.img.height, sourcePixelsPerAnalysisPixel: a.srcPerPx },
      detections: (out.detections ?? []).map((d, i) => ({ id: id + "-" + (i + 1), ...d })),
      ...(out.quality ? { quality: out.quality } : {}), ...(out.reasons?.length ? { reasons: out.reasons } : {}),
      warnings: [...a.warnings, ...(out.warnings ?? [])],
    };
  } catch (error) {
    return { ...base, status: "failed", reasons: [String(error?.message ?? error)], detections: [] };
  }
}

// ---- helpers ---------------------------------------------------------
async function binaryMask(img, { polarity = "dark", method = "otsu", value, offset }) {
  const gray = await toGray(img);
  const { data } = gray;
  let t = value ?? 128;
  if (method === "otsu") {
    const hist = new Array(256).fill(0);
    for (const v of data) hist[v]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = -1;
    for (let k = 0; k < 256; k++) {
      wB += hist[k]; if (!wB) continue;
      const wF = data.length - wB; if (!wF) break;
      sB += k * hist[k];
      const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
      if (between > best) { best = between; t = k; }
    }
  }
  const mask = new Uint8Array(data.length);
  if (method === "adaptive") {
    const block = Math.max(15, Math.round(Math.max(gray.width, gray.height) / 30));
    const local = await rawImage(sameBands(gray, fromRaw(gray).blur(Math.max(0.5, block / 6))));
    const off = offset ?? 15;
    for (let i = 0; i < data.length; i++) mask[i] = polarity === "dark" ? (data[i] < local.data[i] - off ? 1 : 0) : (data[i] > local.data[i] + off ? 1 : 0);
  } else {
    for (let i = 0; i < data.length; i++) mask[i] = polarity === "dark" ? (data[i] <= t ? 1 : 0) : (data[i] > t ? 1 : 0);
  }
  return { mask, width: gray.width, height: gray.height, gray, threshold: method === "adaptive" ? null : t };
}

// 8-connected components with bounding box, area, centroid and perimeter.
export function labelComponents(mask, width, height, { minArea = 1, maxCount = 5000 } = {}) {
  const labels = new Int32Array(mask.length);
  const comps = [];
  const stack = [];
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = ++next;
    let area = 0, sx = 0, sy = 0, x0 = width, y0 = height, x1 = 0, y1 = 0, perimeter = 0;
    stack.push(i); labels[i] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = (p - x) / width;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) { edge = true; continue; }
        const q = yy * width + xx;
        if (!mask[q]) { edge = true; continue; }
        if (!labels[q]) { labels[q] = id; stack.push(q); }
      }
      if (edge) perimeter++;
    }
    if (area >= minArea) comps.push({ label: id, area, cx: sx / area, cy: sy / area, x0, y0, x1: x1 + 1, y1: y1 + 1, perimeter });
    if (comps.length > maxCount) break;
  }
  return { comps, labels, truncated: comps.length > maxCount };
}

// ---- built-in engines ------------------------------------------------
registerEngine({
  id: "components", version: "1", kind: "detect", builtin: true,
  description: "Connected regions of dark or light pixels (ink, pads, symbols, particles) as boxes with area, centroid and fill ratio. Not an identification of what they are.",
  params: { polarity: "dark|light (default dark)", method: "otsu|adaptive|fixed (default otsu)", value: "0-255 for fixed", minArea: "px (default 12)", maxCount: "default 300" },
  async run({ img, toNormalized, params }) {
    const { mask, width, height, threshold } = await binaryMask(img, params);
    const minArea = params.minArea ?? 12, maxCount = params.maxCount ?? 300;
    const { comps } = labelComponents(mask, width, height, { minArea });
    comps.sort((a, b) => b.area - a.area);
    const warnings = [];
    if (comps.length > maxCount) warnings.push(comps.length + " components; the largest " + maxCount + " returned");
    const frac = comps.reduce((s, c) => s + c.area, 0) / mask.length;
    if (frac > 0.5) warnings.push("over half the crop is foreground; check polarity");
    return {
      detections: comps.slice(0, maxCount).map((c) => {
        const a = toNormalized(c.x0, c.y0), b = toNormalized(c.x1, c.y1), ctr = toNormalized(c.cx, c.cy);
        return { type: "bbox", x: a.x, y: a.y, x2: b.x, y2: b.y, centroid: ctr, attributes: { areaPx: c.area, fill: Number((c.area / ((c.x1 - c.x0) * (c.y1 - c.y0))).toFixed(3)), widthPx: c.x1 - c.x0, heightPx: c.y1 - c.y0 }, mark: { type: "rect", x: a.x, y: a.y, x2: b.x, y2: b.y } };
      }),
      quality: { components: comps.length, foregroundFraction: Number(frac.toFixed(4)), threshold },
      warnings,
    };
  },
});

registerEngine({
  id: "blobs", version: "1", kind: "detect", builtin: true,
  description: "Bright (or dark) point-like sources against the local background (stars, solder joints, particles, LEDs): intensity-weighted centroid, peak, flux and FWHM in pixels. Generic, no catalogue or identification.",
  params: { polarity: "light|dark (default light)", sigma: "detection threshold above background noise (default 5)", minArea: "px (default 3)", maxCount: "default 200" },
  async run({ img, toNormalized, params }) {
    const gray = await toGray(img);
    const light = (params.polarity ?? "light") === "light";
    const { data, width, height } = gray;
    const bgImg = await rawImage(sameBands(gray, fromRaw(gray).blur(Math.max(4, Math.min(width, height) / 20))));
    const resid = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) resid[i] = (light ? 1 : -1) * (data[i] - bgImg.data[i]);
    // Robust noise from the median absolute deviation.
    const sample = []; const step = Math.max(1, Math.floor(resid.length / 20000));
    for (let i = 0; i < resid.length; i += step) sample.push(resid[i]);
    sample.sort((a, b) => a - b);
    const med = sample[sample.length >> 1];
    const dev = sample.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const sigma = Math.max(1, 1.4826 * dev[dev.length >> 1]);
    const k = params.sigma ?? 5;
    const mask = new Uint8Array(resid.length);
    for (let i = 0; i < resid.length; i++) mask[i] = resid[i] > med + k * sigma ? 1 : 0;
    const { comps, labels } = labelComponents(mask, width, height, { minArea: params.minArea ?? 3 });
    const out = comps.map((c) => {
      let flux = 0, mx = 0, my = 0, peak = 0;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) {
        const v = Math.max(0, resid[y * width + x] - med);
        if (labels[y * width + x] !== c.label) continue;
        flux += v; mx += v * x; my += v * y; if (v > peak) peak = v;
      }
      const cx = flux ? mx / flux + 0.5 : c.cx + 0.5, cy = flux ? my / flux + 0.5 : c.cy + 0.5;
      // FWHM from the second moment of a Gaussian: 2.355 * sigma_x.
      let vx = 0;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (labels[y * width + x] === c.label) vx += Math.max(0, resid[y * width + x] - med) * (x + 0.5 - cx) ** 2;
      const fwhm = flux ? 2.355 * Math.sqrt(vx / flux) : 0;
      return { c, flux, peak, cx, cy, fwhm };
    }).sort((a, b) => b.flux - a.flux).slice(0, params.maxCount ?? 200);
    return {
      detections: out.map(({ c, flux, peak, cx, cy, fwhm }) => {
        const p = toNormalized(cx, cy), a = toNormalized(c.x0, c.y0), b = toNormalized(c.x1, c.y1);
        return { type: "point", x: p.x, y: p.y, attributes: { areaPx: c.area, flux: Number(flux.toFixed(1)), peak: Number(peak.toFixed(1)), fwhmPx: Number(fwhm.toFixed(2)), snr: Number((peak / sigma).toFixed(1)) }, box: { x: a.x, y: a.y, x2: b.x, y2: b.y }, mark: { type: "point", x: p.x, y: p.y } };
      }),
      quality: { backgroundNoise: Number(sigma.toFixed(2)), thresholdSigma: k, detected: out.length },
    };
  },
});

registerEngine({
  id: "lines", version: "1", kind: "detect", builtin: true,
  description: "Straight line segments (Hough transform on Canny edges): endpoints, length and angle. Candidate strokes only; whether two lines are connected in a circuit or a drawing is for you to judge.",
  params: { sigma: "edge blur (default 1.4)", minLength: "px (default 25)", maxGap: "px (default 6)", maxCount: "default 60", thetaStep: "degrees (default 1)" },
  async run({ img, toNormalized, params }) {
    const edges = await canny(img, { sigma: params.sigma ?? 1.4, low: 0.1, high: 0.25 });
    const { data, width, height } = edges;
    const step = params.thetaStep ?? 1, nTheta = Math.floor(180 / step);
    const diag = Math.ceil(Math.hypot(width, height)), nRho = diag * 2 + 1;
    const acc = new Int32Array(nTheta * nRho);
    const cos = new Float32Array(nTheta), sin = new Float32Array(nTheta);
    for (let t = 0; t < nTheta; t++) { cos[t] = Math.cos((t * step * Math.PI) / 180); sin[t] = Math.sin((t * step * Math.PI) / 180); }
    const pts = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[y * width + x]) pts.push(x, y);
    if (pts.length / 2 > 250000) throw new Error("too many edge pixels (" + pts.length / 2 + "); use a smaller region or a larger sigma");
    for (let i = 0; i < pts.length; i += 2) for (let t = 0; t < nTheta; t++) acc[t * nRho + Math.round(pts[i] * cos[t] + pts[i + 1] * sin[t]) + diag]++;
    const minLen = params.minLength ?? 25, maxGap = params.maxGap ?? 6, out = [];
    const used = new Uint8Array(data.length);
    const peaks = [];
    for (let t = 0; t < nTheta; t++) for (let r = 1; r < nRho - 1; r++) { const v = acc[t * nRho + r]; if (v >= minLen) peaks.push([v, t, r]); }
    peaks.sort((a, b) => b[0] - a[0]);
    for (const [, t, r] of peaks) {
      if (out.length >= (params.maxCount ?? 60)) break;
      const rho = r - diag;
      // Edge pixels within 1 px of this line, ordered along it, split at gaps.
      const along = [];
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        if (Math.abs(x * cos[t] + y * sin[t] - rho) <= 1.5 && !used[y * width + x]) along.push([-x * sin[t] + y * cos[t], x, y]);
      }
      along.sort((a, b) => a[0] - b[0]);
      // These pixels now belong to this peak, even the short pieces, so
      // neighbouring peaks (same stroke, 1 degree apart) cannot recount them.
      const claimed = along.length >= minLen ? along.map(([, x, y]) => y * width + x) : [];
      for (const q of claimed) used[q] = 1;
      let start = 0;
      for (let i = 1; i <= along.length; i++) {
        if (i === along.length || along[i][0] - along[i - 1][0] > maxGap) {
          const seg = along.slice(start, i); start = i;
          if (seg.length < 2) continue;
          const len = seg.at(-1)[0] - seg[0][0];
          if (len < minLen) continue;
          const p1 = toNormalized(seg[0][1] + 0.5, seg[0][2] + 0.5), p2 = toNormalized(seg.at(-1)[1] + 0.5, seg.at(-1)[2] + 0.5);
          out.push({ type: "line", x: p1.x, y: p1.y, x2: p2.x, y2: p2.y, attributes: { lengthPx: Number(len.toFixed(1)), angleDeg: Number((((Math.atan2(seg.at(-1)[2] - seg[0][2], seg.at(-1)[1] - seg[0][1]) * 180) / Math.PI + 360) % 360).toFixed(1)), supportPixels: seg.length }, mark: { type: "polyline", points: [p1, p2] } });
          if (out.length >= (params.maxCount ?? 60)) break;
        }
      }
    }
    return { detections: out, quality: { edgePixels: pts.length / 2, segments: out.length }, warnings: ["a thick stroke gives two parallel edge lines, one per side"] };
  },
});

registerEngine({
  id: "circles", version: "1", kind: "detect", builtin: true,
  description: "Circles (holes, pads, dials, knobs) by gradient-voting Hough transform within a radius range. Candidates with a vote score; check them against the image.",
  params: { minRadius: "px (default 5)", maxRadius: "px (default 60)", minCoverage: "fraction of the ring with edge pixels, 0-1 (default 0.9)", maxCount: "default 40" },
  async run({ img, toNormalized, params }) {
    const gray = await toGray(img);
    const blurred = await rawImage(sameBands(gray, fromRaw(gray).blur(1.5)));
    const { data, width, height } = blurred;
    const rMin = Math.max(2, Math.floor(params.minRadius ?? 5)), rMax = Math.max(rMin, Math.floor(params.maxRadius ?? 60));
    if (rMax - rMin > 200) throw new Error("radius range too wide");
    const edges = await canny(img, { sigma: 1.4, low: 0.1, high: 0.25 });
    const acc = new Float32Array(width * height);
    // Vote for centres along the gradient direction at every radius; the
    // radius is recovered per candidate centre from the edge pixels.
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      if (!edges.data[y * width + x]) continue;
      const gx = data[y * width + x + 1] - data[y * width + x - 1], gy = data[(y + 1) * width + x] - data[(y - 1) * width + x];
      const m = Math.hypot(gx, gy); if (m < 1) continue;
      const ux = gx / m, uy = gy / m;
      for (const sign of [1, -1]) for (let r = rMin; r <= rMax; r++) {
        const cx = Math.round(x + sign * ux * r), cy = Math.round(y + sign * uy * r);
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) break;
        acc[cy * width + cx]++;
      }
    }
    const peaks = [];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const v = acc[y * width + x];
      if (v < 8) continue;
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && acc[(y + dy) * width + x + dx] > v) { peak = false; break; }
      if (peak) peaks.push({ x, y, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    // Radius and support per candidate centre from the edge pixels around it.
    const edgePts = [];
    for (let i = 0; i < edges.data.length; i++) if (edges.data[i]) edgePts.push(i % width, (i - (i % width)) / width);
    const cands = [];
    for (const pk of peaks.slice(0, 200)) {
      const hist = new Float32Array(rMax + 4);
      for (let i = 0; i < edgePts.length; i += 2) {
        const d = Math.round(Math.hypot(edgePts[i] - pk.x, edgePts[i + 1] - pk.y));
        if (d >= rMin - 2 && d <= rMax + 2) hist[d]++;
      }
      let bestR = rMin, bestSum = 0;
      for (let r = rMin; r <= rMax; r++) { const sum = hist[r - 2] + hist[r - 1] + hist[r] + hist[r + 1] + (hist[r + 2] ?? 0); if (sum > bestSum) { bestSum = sum; bestR = r; } }
      // A circle has edge pixels all the way round; a square's corners do not.
      const sectors = new Set();
      for (let i = 0; i < edgePts.length; i += 2) {
        const dx = edgePts[i] - pk.x, dy = edgePts[i + 1] - pk.y;
        if (Math.abs(Math.hypot(dx, dy) - bestR) <= 2.5) sectors.add(Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 36) % 36);
      }
      const score = Math.min(sectors.size / 36, bestSum / (2 * Math.PI * bestR));
      if (score >= (params.minCoverage ?? 0.9)) cands.push({ x: pk.x, y: pk.y, r: bestR, score });
    }
    cands.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of cands) if (kept.every((k) => Math.hypot(k.x - c.x, k.y - c.y) > Math.min(k.r, c.r) * 0.8)) kept.push(c);
    return {
      detections: kept.slice(0, params.maxCount ?? 40).map((c) => {
        const p = toNormalized(c.x + 0.5, c.y + 0.5), a = toNormalized(c.x - c.r, c.y - c.r), b = toNormalized(c.x + c.r, c.y + c.r);
        return { type: "circle", x: p.x, y: p.y, radiusPx: c.r, confidence: Number(c.score.toFixed(3)), box: { x: a.x, y: a.y, x2: b.x, y2: b.y }, mark: { type: "rect", x: a.x, y: a.y, x2: b.x, y2: b.y } };
      }),
      quality: { candidates: cands.length },
    };
  },
});

// Optional OCR through tesseract.js. Not a dependency: install it where
// wanted. Its language data is downloaded on first use unless
// ESTAMPES_OCR_LANG_PATH points at a folder of .traineddata files, which is
// a network access the server owner should know about.
let tess = null;
registerEngine({
  id: "ocr", version: "1", kind: "ocr", builtin: true,
  description: "Text recognition (optional, tesseract.js): words with boxes and confidence. Recognised text is a candidate reading, never a verified fact; low-confidence words are flagged.",
  params: { lang: "tesseract language code (default eng)", minConfidence: "0-100 (default 60) below which words are flagged lowConfidence" },
  async available() {
    tess ??= import("tesseract.js").then((m) => ({ ok: true, m: m.default ?? m })).catch((e) => ({ ok: false, reason: "OCR is not installed on this server (npm i tesseract.js): " + String(e?.code ?? e?.message ?? e) }));
    const t = await tess;
    return t.ok ? { ok: true } : { ok: false, reason: t.reason };
  },
  async run({ img, toNormalized, params }) {
    const t = await tess;
    const png = await fromRaw(img).png().toBuffer();
    const langPath = process.env.ESTAMPES_OCR_LANG_PATH || undefined;
    const worker = await t.m.createWorker(params.lang ?? "eng", 1, { ...(langPath ? { langPath, gzip: false } : {}) });
    try {
      const { data } = await worker.recognize(png, {}, { blocks: true });
      const min = params.minConfidence ?? 60, words = [];
      for (const block of data.blocks ?? []) for (const para of block.paragraphs ?? []) for (const line of para.lines ?? []) for (const w of line.words ?? []) {
        if (!w.text?.trim()) continue;
        const a = toNormalized(w.bbox.x0, w.bbox.y0), b = toNormalized(w.bbox.x1, w.bbox.y1);
        words.push({ type: "bbox", x: a.x, y: a.y, x2: b.x, y2: b.y, text: w.text, confidence: Number((w.confidence / 100).toFixed(3)), attributes: { lowConfidence: w.confidence < min }, mark: { type: "rect", x: a.x, y: a.y, x2: b.x, y2: b.y } });
      }
      return { detections: words, quality: { words: words.length, meanConfidence: words.length ? Number((words.reduce((s, w) => s + w.confidence, 0) / words.length).toFixed(3)) : null }, warnings: ["OCR text is a candidate reading; check it against the image"] };
    } finally { await worker.terminate().catch(() => {}); }
  },
});
