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
import { analysisFor, viewAnalysis, findView } from "./view.js";
import { canny } from "./ops-extra.js";
import { apply, axisAligned, isAffine, mapMark } from "./transform.js";
import { splitByDistance, labelMask, fillHoles, regionStats, traceContour, simplifyClosed, squaredDistanceTransform } from "./segment.js";

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

// Run one engine on a region of the image, or on a processed view of it
// (`derivedViewId`). Failure is a result, not a thrown error:
// { status: "failed", reasons } keeps the shape the same for GPT. A wrong,
// unknown or stale view is a thrown error: the call itself is mistaken.
export async function runEngine(entry, id, { region, sampling, params = {}, derivedViewId } = {}) {
  const engine = registry.get(id);
  if (!engine) throw new Error("Unknown engine " + id + "; available: " + [...registry.keys()].join(", "));
  const base = { apiVersion: ENGINE_API, engine: id, engineVersion: engine.version, kind: engine.kind, imageId: entry.imageId, sourceAssetId: entry.sourceAssetId ?? null };
  const target = derivedViewId ? await viewTarget(entry, derivedViewId, { region, sampling }) : await imageTarget(entry, { region, sampling });
  const avail = await engine.available();
  if (!avail.ok) return { ...base, ...target.envelope, status: "unavailable", reasons: [avail.reason], detections: [] };
  try {
    const out = await engine.run({ img: target.img, toNormalized: target.toNormalized, params, region: target.region, entry, scale: target.scale });
    const detections = (out.detections ?? []).map((d, i) => ({ id: id + "-" + (i + 1), ...d }));
    const mapped = target.finish ? target.finish(detections) : { detections, warnings: [] };
    return {
      ...base, ...target.envelope, status: out.status ?? "ok", region: target.region,
      analysis: target.analysis,
      detections: mapped.detections,
      ...(out.quality ? { quality: out.quality } : {}), ...(out.reasons?.length ? { reasons: out.reasons } : {}),
      warnings: [...target.warnings, ...(out.warnings ?? []), ...mapped.warnings],
    };
  } catch (error) {
    return { ...base, ...target.envelope, status: "failed", reasons: [String(error?.message ?? error)], detections: [] };
  }
}

// A known length per analysis pixel, when calibrate_scale set one for this
// measurement space (the source image, or one derived view).
function scaleFor(entry, key, spacePixelsPerAnalysisPixel) {
  const cal = entry.calibrations?.get(key);
  if (!cal || !Number.isFinite(cal.unitsPerPixel)) return null;
  return { unit: cal.unit, unitsPerPixel: cal.unitsPerPixel * spacePixelsPerAnalysisPixel, relativeUncertainty: cal.relativeUncertainty ?? 0 };
}

// Source pixels of the image, cropped at the analysis resolution.
async function imageTarget(entry, { region, sampling }) {
  const { analysisPixels: a } = await analysisFor(entry, { region, sampling: { mode: "working", ...sampling } });
  const r = a.region;
  return {
    img: a.img, region: r, warnings: a.warnings, envelope: {},
    toNormalized: (x, y) => ({ x: r5(r.x + (x / a.img.width) * (r.x2 - r.x)), y: r5(r.y + (y / a.img.height) * (r.y2 - r.y)) }),
    analysis: { space: a.space, width: a.img.width, height: a.img.height, sourcePixelsPerAnalysisPixel: a.srcPerPx },
    scale: scaleFor(entry, "image", a.srcPerPx),
  };
}

// The pixels of a processed view (after its geometry and ops, before the
// delivery resize and codec). The engine works in the view's own pixel
// frame; detections are then mapped back to the image with the view's
// stored matrix, and keep their view-pixel geometry under `view`.
async function viewTarget(entry, derivedViewId, { region, sampling }) {
  if (region || sampling) throw new Error("With derivedViewId the view's own region and sampling apply; do not pass region or sampling");
  const record = findView(entry, derivedViewId);
  if (!record) throw new Error(derivedViewId + " is not a processed view of " + entry.imageId + " (recipes are kept per image); call process_image on this image first");
  const m = record.coordinateMapping?.derivedToNormalized;
  if (!m) throw new Error("Derived view " + derivedViewId + " has no invertible mapping back to the image, so detections on it could not be placed");
  const a = await viewAnalysis(entry, record);
  // Analysis pixels -> delivered view pixels (the frame of coordinateFrame {derivedViewId}).
  const kx = record.pixelDimensions.width / a.img.width, ky = record.pixelDimensions.height / a.img.height;
  const r2 = (v) => Number(v.toFixed(2));
  const aligned = axisAligned(m), affine = isAffine(m);
  const perPx = affine ? Number((record.evidence.sourcePixelsPerOutputPixel * kx).toFixed(4)) : null;
  const warnings = [...a.warnings, "detected on the processed pixels of " + derivedViewId + " (" + (record.recipe.ops.map((o) => o.op).join(" > ") || "no ops") + "), not on the source pixels"];
  if (!affine) warnings.push("the view is a perspective warp: pixel sizes (areaPx, lengthPx, radiusPx) are in the view's pixels and do not correspond to one fixed length on the image");
  if (!aligned) warnings.push("the view is rotated or warped: boxes are given on the image as four-corner polygons, with x/y/x2/y2 their bounding box");
  if (record.validity && record.validity.validFraction < 0.999) warnings.push(Math.round((1 - record.validity.validFraction) * 100) + "% of the view is fill, not image; detections there are marked outsideSource");
  return {
    img: a.img, region: record.recipe.region, warnings,
    toNormalized: (x, y) => ({ x: r2(x * kx), y: r2(y * ky) }),
    analysis: { space: "view", width: a.img.width, height: a.img.height, sourcePixelsPerAnalysisPixel: perPx },
    scale: scaleFor(entry, derivedViewId, Math.sqrt(kx * ky)),
    envelope: {
      derivedViewId,
      view: {
        derivedViewId, reproduced: true,
        ops: record.recipe.ops, geometry: record.recipe.geometry ?? [], sampling: record.recipe.sampling,
        versions: record.versions,
        pixelDimensions: record.pixelDimensions,
        mapping: record.coordinateMapping.kind, axisAligned: aligned,
        ...(record.validity ? { validFraction: record.validity.validFraction } : {}),
        pixelsRead: "after geometry and ops, before delivery resize and codec (lossless)",
      },
      coordinates: {
        detections: "normalized source image (0..1, top-left origin)",
        "detections[].view": "pixels of the derived view; usable as present_visual coordinateFrame {derivedViewId}",
      },
    },
    finish(detections) {
      let outside = 0;
      const mappedList = detections.map((d) => { const out = mapDetection(d, m, aligned); if (out.outsideSource) outside++; return out; });
      return { detections: mappedList, warnings: outside ? [outside + " detection" + (outside === 1 ? " lies" : "s lie") + " partly outside the source image (in the view's fill); they carry outsideSource and no mark"] : [] };
    },
  };
}

// One detection from view pixels to normalized image coordinates. The
// view-pixel geometry is kept under `view`. A box stays a box only when
// the mapping is axis-aligned; otherwise its four corners are given as
// `polygon` and x/y/x2/y2 become their bounding box.
function mapDetection(d, m, aligned) {
  let outside = false;
  const P = (p) => {
    const q = apply(m, p.x, p.y);
    if (q.x < -1e-6 || q.y < -1e-6 || q.x > 1 + 1e-6 || q.y > 1 + 1e-6) outside = true;
    return { x: r5(q.x), y: r5(q.y) };
  };
  const bounds = (pts) => ({ x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)), x2: Math.max(...pts.map((p) => p.x)), y2: Math.max(...pts.map((p) => p.y)) });
  const box = (b) => {
    const corners = [[b.x, b.y], [b.x2, b.y], [b.x2, b.y2], [b.x, b.y2]].map(([x, y]) => P({ x, y }));
    return { ...bounds(corners), ...(aligned ? {} : { polygon: corners }) };
  };
  const out = { ...d }, view = {};
  if (d.x2 !== undefined) {
    view.x = d.x; view.y = d.y; view.x2 = d.x2; view.y2 = d.y2;
    if (d.type === "line") { const a = P({ x: d.x, y: d.y }), b = P({ x: d.x2, y: d.y2 }); Object.assign(out, { x: a.x, y: a.y, x2: b.x, y2: b.y }); }
    else Object.assign(out, box(d));
  } else if (d.x !== undefined) {
    view.x = d.x; view.y = d.y;
    Object.assign(out, P(d));
  }
  if (d.centroid) { view.centroid = d.centroid; out.centroid = P(d.centroid); }
  if (d.box) { view.box = d.box; out.box = box(d.box); }
  if (d.mark) {
    const mk = mapMark(d.mark, m);
    // Rounds, and counts a mark that leaves the image as outside.
    const fix = (p) => { if (p.x < -1e-6 || p.y < -1e-6 || p.x > 1 + 1e-6 || p.y > 1 + 1e-6) outside = true; return { x: r5(p.x), y: r5(p.y) }; };
    out.mark = {
      ...mk,
      ...(mk.x !== undefined ? fix({ x: mk.x, y: mk.y }) : {}),
      ...(mk.x2 !== undefined ? (({ x, y }) => ({ x2: x, y2: y }))(fix({ x: mk.x2, y: mk.y2 })) : {}),
      ...(mk.points ? { points: mk.points.map(fix) } : {}),
    };
    // A region's outline is its mark; its box follows the outline exactly.
    if (d.type === "region" && out.mark.points?.length) { Object.assign(out, bounds(out.mark.points)); delete out.polygon; }
    if (out.mark.type === "rect") { const { x, y, x2, y2 } = out.mark; Object.assign(out.mark, { x: Math.min(x, x2), y: Math.min(y, y2), x2: Math.max(x, x2), y2: Math.max(y, y2) }); }
  }
  out.view = view;
  if (outside) { out.outsideSource = true; delete out.mark; }
  return out;
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
    const { comps } = labelComponents(mask, width, height, { minArea, maxCount: Infinity });
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
    const { comps, labels } = labelComponents(mask, width, height, { minArea: params.minArea ?? 3, maxCount: Infinity });
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

// Regions: connected foreground split where blobs touch, with shape
// statistics and an outline per region. Generic: it knows nothing about
// grains, cells or pads.
const MAX_REGION_PIXELS = 6_000_000;
const median = (values) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
registerEngine({
  id: "regions", version: "1", kind: "segment", builtin: true,
  description: "Closed regions (grains, cells, particles, pads) of dark or light pixels, with touching blobs split by shape (watershed of the distance transform). Per region: outline polygon, area, perimeter, equivalent diameter, axes, eccentricity, circularity, whether it touches the frame, and whether it was split from a larger blob. Best on a cleaned binary view (process_image threshold/morphology, then derivedViewId). A split is inferred from shape, not seen; counts are candidates, not a verified count of objects.",
  params: {
    polarity: "dark|light (default dark)", method: "otsu|adaptive|fixed (default otsu)", value: "0-255 for fixed",
    split: "true|false (default true): split touching blobs", minDepth: "px a neck must dip below the smaller part's inner radius to split (default 1.5)",
    minRelativeDepth: "the same as a fraction of that radius, 0-1 (default 0.12; higher splits less)",
    fillHoles: "true|false (default false)", minArea: "px (default 20)", excludeBorder: "true|false (default false): drop regions cut by the frame",
    maxCount: "regions returned, largest first (default 80; statistics cover all)", contours: "true|false (default true): outline polygons", maxVertices: "per outline (default 16, max 64)", tolerance: "outline simplification in px (default 1)",
  },
  async run({ img, toNormalized, params, scale }) {
    const bin = await binaryMask(img, params);
    const { width, height, threshold } = bin;
    if (width * height > MAX_REGION_PIXELS) throw new Error("region of " + width + "x" + height + " px is too large to segment (limit " + MAX_REGION_PIXELS + " px); use a smaller region or working sampling");
    let mask = bin.mask, filled = 0;
    if (params.fillHoles === true) ({ mask, filled } = fillHoles(mask, width, height));
    let fg = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) fg++;
    const warnings = [];
    const frac = fg / mask.length;
    if (!fg) return { detections: [], quality: { regions: 0, foregroundFraction: 0, threshold }, warnings: ["no foreground pixels"] };
    const split = params.split !== false;
    const d2 = squaredDistanceTransform(mask, width, height, { borderIsBackground: true });
    let labels, count, info, components;
    if (split) {
      const res = splitByDistance(mask, width, height, { minDepth: params.minDepth ?? 1.5, minRelativeDepth: params.minRelativeDepth ?? 0.12, distance2: d2 });
      ({ labels, count, components } = res); info = res.regions;
    } else {
      ({ labels, count } = labelMask(mask, width, height)); components = count;
      info = Array.from({ length: count }, (_, i) => ({ label: i + 1, component: i + 1, weakestSplit: null, peak: 0 }));
      for (let i = 0; i < labels.length; i++) { const l = labels[i]; if (l) { const r = Math.sqrt(d2[i]); if (r > info[l - 1].peak) info[l - 1].peak = r; } }
    }
    const perComponent = new Map();
    for (const r of info) perComponent.set(r.component, (perComponent.get(r.component) ?? 0) + 1);
    const stats = regionStats(labels, width, height, count);
    const minArea = params.minArea ?? 20;
    let small = 0, cut = 0;
    const all = [];
    for (const st of stats) {
      if (!st) continue;
      if (st.area < minArea) { small++; continue; }
      if (st.touchesBorder) { cut++; if (params.excludeBorder === true) continue; }
      all.push(st);
    }
    all.sort((a, b) => b.area - a.area || a.label - b.label);
    const maxCount = Math.max(1, Math.min(300, params.maxCount ?? 80));
    const withContours = params.contours !== false;
    const maxVertices = Math.max(4, Math.min(64, params.maxVertices ?? 16));
    if (all.length > maxCount) warnings.push(all.length + " regions; the largest " + maxCount + " returned (quality covers all " + all.length + ")");
    const splitRegions = all.filter((st) => perComponent.get(info[st.label - 1].component) > 1).length;
    if (splitRegions) warnings.push(splitRegions + " regions come from splitting touching blobs by shape; no boundary was seen between them (see attributes.splitFrom and weakestSplit)");
    if (cut && params.excludeBorder !== true) warnings.push(cut + " regions touch the frame and are probably cut off (touchesBorder); their sizes are lower bounds");
    const n2 = (v, d = 2) => Number(v.toFixed(d));
    const k = scale?.unitsPerPixel ?? null;
    const first = new Int32Array(count + 1).fill(-1);
    if (withContours) for (let i = 0; i < labels.length; i++) { const l = labels[i]; if (l && first[l] < 0) first[l] = i; }
    const detections = all.slice(0, maxCount).map((st) => {
      const r = info[st.label - 1], parts = perComponent.get(r.component);
      const a = toNormalized(st.bbox.x0, st.bbox.y0), b = toNormalized(st.bbox.x1, st.bbox.y1), c = toNormalized(st.centroid.x, st.centroid.y);
      let mark = { type: "rect", x: a.x, y: a.y, x2: b.x, y2: b.y }, outline = null;
      if (withContours) {
        const ring = traceContour(labels, width, height, st.label, first[st.label]);
        const simple = simplifyClosed(ring, { tolerance: params.tolerance ?? 1, maxVertices });
        if (simple.points.length >= 3) {
          mark = { type: "polyline", closed: true, points: simple.points.map((p) => toNormalized(p.x, p.y)) };
          outline = { vertices: simple.points.length, tolerancePx: simple.tolerance };
        }
      }
      return {
        type: "region", x: a.x, y: a.y, x2: b.x, y2: b.y, centroid: c,
        attributes: {
          areaPx: st.area, perimeterPx: n2(st.perimeter, 1), equivalentDiameterPx: n2(st.equivalentDiameter),
          majorPx: n2(st.major), minorPx: n2(st.minor), eccentricity: n2(st.eccentricity, 3), orientationDeg: n2(st.orientation, 1),
          circularity: n2(st.circularity, 3), inscribedRadiusPx: n2(r.peak),
          touchesBorder: st.touchesBorder,
          ...(parts > 1 ? { splitFrom: "component-" + r.component, splitParts: parts, weakestSplit: r.weakestSplit === null ? null : n2(r.weakestSplit, 3) } : {}),
          ...(outline ? { outline } : {}),
          ...(k ? { area: Number((st.area * k * k).toPrecision(5)), equivalentDiameter: Number((st.equivalentDiameter * k).toPrecision(5)), perimeter: Number((st.perimeter * k).toPrecision(5)), unit: scale.unit } : {}),
        },
        verification: "unverified",
        mark,
      };
    });
    const diam = all.map((st) => st.equivalentDiameter), areas = all.map((st) => st.area);
    return {
      detections,
      quality: {
        regions: all.length, returned: detections.length, components, splitRegions, touchingBorder: cut, belowMinArea: small,
        foregroundFraction: n2(frac, 4), threshold, ...(filled ? { holePixelsFilled: filled } : {}),
        medianEquivalentDiameterPx: diam.length ? n2(median(diam)) : null, meanAreaPx: areas.length ? n2(areas.reduce((s, v) => s + v, 0) / areas.length, 1) : null,
        ...(k ? { calibration: { unit: scale.unit, unitsPerAnalysisPixel: Number(k.toPrecision(6)), relativeUncertainty: Number((scale.relativeUncertainty ?? 0).toPrecision(3)), medianEquivalentDiameter: diam.length ? Number((median(diam) * k).toPrecision(5)) : null } } : { calibration: null }),
        split: split ? { minDepth: params.minDepth ?? 1.5, minRelativeDepth: params.minRelativeDepth ?? 0.12 } : null,
      },
      warnings,
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
