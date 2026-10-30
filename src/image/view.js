// Derived views (RFC PRE-01, PRE-02, PRE-04): a processed crop of an image
// with an explicit analysis resolution, a separate delivery size and codec,
// the transform back to the canvas frame and a record of what was done to
// the pixels. A view never replaces the source; its recipe is enough to
// render it again (get_derived_view), so nothing depends on cached output.
//
// Order of work:  source or working pixels -> crop at analysis resolution
//                 -> ops -> delivery resize -> encode
// "preview" sampling keeps the old process_image order (resize to the output
// size first, then ops) so existing calls return the same pixels.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { entrySharp } from "../image-store.js";
import {
  applyOp, rawImage, fromRaw, regionToPixels, pixelsToRegion, OUTPUT_LONG_SIDE, MAX_UPSCALE,
} from "../image-ops.js";
import { scale, translate, chain, step, graphSummary } from "./transform.js";

export const VIEW_API = "estampes.image/2";
export const SAMPLING_MODES = Object.freeze(["preview", "working", "native"]);
export const OUTPUT_FORMATS = Object.freeze(["auto", "png", "jpeg", "webp"]);
export const MAX_DELIVERY_SIDE = 2048;

// Bumped when an operator's output changes, so a recipe id never silently
// refers to different pixels.
export const OP_VERSIONS = Object.freeze({
  grayscale: "1", normalize: "1", clahe: "js-1", contrast: "1", brightness: "1", sharpen: "1",
  denoise: "median-1", threshold: "1", invert: "1", edges: "sobel-1",
});
export const opVersion = (op) => OP_VERSIONS[op] ?? "1";
const ENHANCING = new Set(["normalize", "clahe", "contrast", "brightness", "sharpen", "denoise", "gamma", "levels", "white_balance", "flat_field", "unsharp"]);
const BINARIZING = new Set(["threshold", "edges", "canny", "morphology"]);

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])]))
  : v;
export const canonical = (v) => JSON.stringify(sortKeys(v));
const hash16 = (v) => createHash("sha256").update(canonical(v)).digest("hex").slice(0, 16);

export function normalizeSpec(spec = {}) {
  const sampling = {
    mode: spec.sampling?.mode ?? "preview",
    allowUpscale: spec.sampling?.allowUpscale ?? (spec.sampling?.mode ?? "preview") === "preview",
    ...(spec.sampling?.maxPixels ? { maxPixels: spec.sampling.maxPixels } : {}),
    ...(spec.sampling?.alpha && spec.sampling.alpha !== "flatten" ? { alpha: spec.sampling.alpha } : {}),
  };
  if (!SAMPLING_MODES.includes(sampling.mode)) throw new Error("sampling.mode must be one of " + SAMPLING_MODES.join(", "));
  if (sampling.alpha === "keep" && sampling.mode !== "native") throw new Error("sampling.alpha keep needs sampling.mode native (the working copy is flattened on white)");
  const output = {
    format: spec.output?.format ?? "auto",
    maxLongSide: Math.min(MAX_DELIVERY_SIDE, spec.output?.maxLongSide ?? OUTPUT_LONG_SIDE),
    ...(spec.output?.quality ? { quality: spec.output.quality } : {}),
  };
  if (!OUTPUT_FORMATS.includes(output.format)) throw new Error("output.format must be one of " + OUTPUT_FORMATS.join(", "));
  return { region: spec.region ?? null, ops: spec.ops ?? [], geometry: spec.geometry ?? [], sampling, output };
}

// Crop at the requested analysis resolution. Returns raw pixels plus the
// source-pixel box and analysis pixels per source pixel.
async function analysisCrop(entry, region, sampling, output) {
  const src = entry.sourceInfo ?? { width: entry.width, height: entry.height };
  const norm = regionToPixels(region, entry.width, entry.height);
  let covered = pixelsToRegion(norm, entry.width, entry.height);
  const maxPixels = Math.min(sampling.maxPixels ?? config.maxAnalysisPixels, config.maxAnalysisPixels);
  const warnings = [];
  if (sampling.mode === "preview") {
    // Old behaviour: fit the output size, enlarging zoomed crops up to 8x.
    const k = Math.min(region ? MAX_UPSCALE : 1, output.maxLongSide / Math.max(norm.width, norm.height));
    const width = Math.max(1, Math.round(norm.width * k)), height = Math.max(1, Math.round(norm.height * k));
    const img = await rawImage(entrySharp(entry).extract(norm).resize({ width, height, kernel: "lanczos3" }));
    return { img, covered, space: "working", box: norm, boxSize: { width: entry.width, height: entry.height }, scaleX: width / norm.width, scaleY: height / norm.height, legacyScale: k, warnings };
  }
  if (sampling.mode === "native" && entry.sourceBytes) {
    // Snap on the source grid, from the requested region (not the working one).
    const box = regionToPixels(region, src.width, src.height);
    covered = pixelsToRegion(box, src.width, src.height);
    let pipeline = sharp(entry.sourceBytes, { limitInputPixels: config.maxInputPixels }).rotate().extract(box);
    let width = box.width, height = box.height;
    if (width * height > maxPixels) {
      const k = Math.sqrt(maxPixels / (width * height));
      width = Math.max(1, Math.floor(width * k)); height = Math.max(1, Math.floor(height * k));
      pipeline = pipeline.resize({ width, height, kernel: "lanczos3" });
      warnings.push("native crop of " + box.width + "x" + box.height + " px exceeds the analysis budget; reduced to " + width + "x" + height);
    }
    if (sampling.alpha !== "keep") pipeline = pipeline.flatten({ background: sampling.alpha === "flatten-black" ? "#000000" : "#ffffff" });
    if ((src.bitDepth ?? 8) > 8) warnings.push("source has " + src.bitDepth + "-bit samples; quantized to 8-bit for processing");
    const img = await rawImage(pipeline.toColourspace("srgb"));
    return { img, covered, space: "source", box, boxSize: { width: src.width, height: src.height }, scaleX: width / box.width, scaleY: height / box.height, warnings };
  }
  if (sampling.mode === "native") warnings.push("source file not available; used the working copy");
  let pipeline = entrySharp(entry).extract(norm);
  let width = norm.width, height = norm.height;
  if (width * height > maxPixels) {
    const k = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * k)); height = Math.max(1, Math.floor(height * k));
    pipeline = pipeline.resize({ width, height, kernel: "lanczos3" });
    warnings.push("working crop exceeds the analysis budget; reduced to " + width + "x" + height);
  }
  const img = await rawImage(pipeline);
  return { img, covered, space: "working", box: norm, boxSize: { width: entry.width, height: entry.height }, scaleX: width / norm.width, scaleY: height / norm.height, warnings };
}

async function encodeView(img, output) {
  const fmt = output.format;
  if (fmt === "png" || (fmt === "auto" && img.channels === 1)) {
    let p = fromRaw(img);
    if (img.channels === 1) p = p.toColourspace("b-w");
    const png = await p.png({ compressionLevel: 6 }).toBuffer();
    if (fmt === "png" || png.length <= 1_500_000) return { data: png, mimeType: "image/png", lossy: false };
  }
  if (fmt === "webp") return { data: await fromRaw(img).webp({ lossless: true }).toBuffer(), mimeType: "image/webp", lossy: false };
  return { data: await fromRaw(img).jpeg({ quality: output.quality ?? 88 }).toBuffer(), mimeType: "image/jpeg", lossy: true, quality: output.quality ?? 88 };
}

// Render a view. `geometryStage` (optional) is a function provided by the
// geometry module that warps the analysis crop and returns extra transform
// steps; it runs before pixel ops so ops see rectified pixels.
export async function renderView(entry, rawSpec, { geometryStage } = {}) {
  const spec = normalizeSpec(rawSpec);
  const crop = await analysisCrop(entry, spec.region, spec.sampling, spec.output);
  const { covered, box, boxSize } = crop;
  const warnings = [...crop.warnings];
  // normalized -> crop space pixels -> analysis pixels
  const steps = [
    step("to-pixels", "normalized", crop.space, scale(boxSize.width, boxSize.height), { pixelConvention: "corner" }),
    step("crop", crop.space, "crop", translate(-box.left, -box.top), { box }),
  ];
  if (crop.scaleX !== 1 || crop.scaleY !== 1) {
    steps.push(step("resample", "crop", "analysis", scale(crop.scaleX, crop.scaleY), { interpolation: "lanczos3" }));
  }
  let img = crop.img;
  let validity = null;
  if (spec.geometry.length) {
    if (!geometryStage) throw new Error("geometry steps are not available in this build");
    const g = await geometryStage(img, spec.geometry, { entry, steps });
    img = g.img; steps.push(...g.steps); warnings.push(...g.warnings); validity = g.validity;
  }
  for (const s of spec.ops) img = await applyOp(img, s);
  const binary = spec.ops.some((s) => BINARIZING.has(s.op));
  // Delivery: shrink to fit; enlarge only when asked (interpolation adds no detail).
  const long = Math.max(img.width, img.height);
  let k = Math.min(1, spec.output.maxLongSide / long);
  if (spec.sampling.mode !== "preview" && spec.sampling.allowUpscale && k === 1) {
    k = Math.min(MAX_UPSCALE, spec.output.maxLongSide / long);
  }
  if (k !== 1) {
    const width = Math.max(1, Math.round(img.width * k)), height = Math.max(1, Math.round(img.height * k));
    const kx = width / img.width, ky = height / img.height;
    img = await rawImage(fromRaw(img).resize({ width, height, kernel: binary && k > 1 ? "nearest" : "lanczos3" }));
    steps.push(step("deliver", "analysis", "derived", scale(kx, ky), { interpolation: binary && k > 1 ? "nearest" : "lanczos3" }));
  }
  const encoded = await encodeView(img, spec.output);
  const graph = graphSummary(steps);
  // Source pixels per delivered pixel, along x (what a 1 px line in the
  // output is worth in the original).
  const srcW = entry.sourceInfo?.width ?? entry.width;
  const sourcePixelsPerOutputPixel = Math.abs(1 / (graph.normalizedToDerived[0] / srcW));
  const upscaled = sourcePixelsPerOutputPixel < 0.999;
  if (upscaled) warnings.push("enlarged " + (1 / sourcePixelsPerOutputPixel).toFixed(1) + "x beyond source pixels by interpolation; it shows no new detail");
  if (spec.ops.some((s) => s.op === "threshold")) warnings.push("thresholded: grey levels are discarded");
  if (spec.ops.some((s) => ENHANCING.has(s.op))) warnings.push("enhanced pixels can show artefacts (halos, amplified noise); check against the original");
  if (encoded.lossy) warnings.push("delivered as lossy JPEG (quality " + encoded.quality + ")");
  const recipe = {
    region: covered, sampling: spec.sampling, ops: spec.ops, ...(spec.geometry.length ? { geometry: spec.geometry } : {}), output: spec.output,
  };
  const derivedViewId = "dv:" + hash16({ api: VIEW_API, source: entry.sourceAssetId ?? entry.imageId, recipe, ops: spec.ops.map((s) => s.op + "@" + opVersion(s.op)) });
  const record = {
    apiVersion: VIEW_API,
    derivedViewId, imageId: entry.imageId, sourceAssetId: entry.sourceAssetId ?? null,
    recipe,
    sourceDimensions: { width: srcW, height: entry.sourceInfo?.height ?? entry.height },
    workingDimensions: { width: entry.width, height: entry.height },
    analysis: {
      space: crop.space, sourceBox: crop.space === "source" ? box : regionToPixels(covered, srcW, entry.sourceInfo?.height ?? entry.height),
      width: crop.img.width, height: crop.img.height,
      scale: Number((crop.scaleX * (crop.space === "source" ? 1 : boxSize.width / srcW)).toFixed(6)),
    },
    pixelDimensions: { width: img.width, height: img.height },
    delivery: { mimeType: encoded.mimeType, lossy: encoded.lossy, ...(encoded.quality ? { quality: encoded.quality } : {}), bytes: encoded.data.length, scale: Number(k.toFixed(6)) },
    coordinateMapping: graph,
    ...(validity ? { validity } : {}),
    evidence: {
      interpolated: upscaled,
      sourcePixelsPerOutputPixel: Number(sourcePixelsPerOutputPixel.toFixed(4)),
      lossyDelivery: encoded.lossy,
      thresholded: spec.ops.some((s) => s.op === "threshold"),
      enhanced: spec.ops.some((s) => ENHANCING.has(s.op)),
      geometricallyInvertible: graph.invertible,
      pixelValuesInvertible: spec.ops.length === 0,
      warnings,
    },
    versions: { ops: Object.fromEntries(spec.ops.map((s) => [s.op, opVersion(s.op)])), sharp: sharp.versions.sharp, vips: sharp.versions.vips },
  };
  return {
    data: encoded.data, mimeType: encoded.mimeType, width: img.width, height: img.height,
    region: covered, scale: crop.legacyScale ?? Number((img.width / box.width).toFixed(6)), record,
  };
}

// Remembered recipes per image, newest last, bounded.
export function rememberView(entry, record) {
  entry.derivedViews ??= new Map();
  entry.derivedViews.delete(record.derivedViewId);
  entry.derivedViews.set(record.derivedViewId, { ...record, createdAt: record.createdAt ?? new Date().toISOString() });
  while (entry.derivedViews.size > config.derivedViewsPerImage) entry.derivedViews.delete(entry.derivedViews.keys().next().value);
  return entry.derivedViews.get(record.derivedViewId);
}

export const findView = (entry, id) => entry.derivedViews?.get(id) ?? null;

// Model coordinates read off a derived view -> normalized canvas frame.
// units "pixels" (default) or "normalized" (0..1 of the view).
export function frameFromView(record, units = "pixels") {
  const m = record.coordinateMapping?.derivedToNormalized;
  if (!m) throw new Error("Derived view " + record.derivedViewId + " has no invertible mapping back to the image");
  const { width, height } = record.pixelDimensions;
  return { matrix: units === "normalized" ? chain(scale(width, height), m) : m };
}
