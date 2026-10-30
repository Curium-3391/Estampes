// M0.5: pixel preprocessing for real images. Estampes only transforms pixels
// and keeps coordinates honest; recognizing what is in the picture stays the
// model's job. Every output reports the source region it covers, in
// coordinates normalized to the full oriented source image.
import sharp from "sharp";
import { labelSvg, labelWidth, GLYPH_HEIGHT } from "./pixel-font.js";
import { entrySharp, MAX_INPUT_PIXELS } from "./image-store.js";

export const OUTPUT_LONG_SIDE = 1600;
export const MAX_UPSCALE = 8;
export const OP_NAMES = Object.freeze([
  "grayscale", "normalize", "clahe", "contrast", "brightness", "sharpen",
  "denoise", "threshold", "invert", "edges",
]);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Normalized region → integer source pixels (at least 1×1, inside the image).
export function regionToPixels(region, width, height) {
  const r = region ?? { x: 0, y: 0, x2: 1, y2: 1 };
  const x0 = clamp(Math.min(r.x, r.x2), 0, 1), x1 = clamp(Math.max(r.x, r.x2), 0, 1);
  const y0 = clamp(Math.min(r.y, r.y2), 0, 1), y1 = clamp(Math.max(r.y, r.y2), 0, 1);
  // The epsilon keeps 0.55 * 3000 = 1650.0000000000002 from taking a pixel more.
  const left = clamp(Math.floor(x0 * width + 1e-9), 0, width - 1);
  const top = clamp(Math.floor(y0 * height + 1e-9), 0, height - 1);
  const right = clamp(Math.ceil(x1 * width - 1e-9), left + 1, width);
  const bottom = clamp(Math.ceil(y1 * height - 1e-9), top + 1, height);
  return { left, top, width: right - left, height: bottom - top };
}

// The region actually covered after pixel rounding, normalized again.
export const pixelsToRegion = (px, width, height) => ({
  x: px.left / width, y: px.top / height,
  x2: (px.left + px.width) / width, y2: (px.top + px.height) / height,
});

export const rawImage = async (pipeline) => {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};
export const fromRaw = (img) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } });
export const toGray = async (img) => img.channels === 1 ? img : rawImage(fromRaw(img).greyscale().extractChannel(0));

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, weightB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB, meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// Contrast-limited adaptive histogram equalization on luminance, in JS:
// one clipped histogram per tile, bilinear blend between tile curves.
// libvips' hist_local is O(tile²) per pixel and took seconds on a photo.
export function clahe(img, { tile = 48, maxSlope = 3 } = {}) {
  const { data, width, height, channels } = img;
  const n = width * height;
  const luma = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    luma[i] = channels >= 3 ? Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) : data[p];
  }
  const tilesX = Math.max(1, Math.ceil(width / tile)), tilesY = Math.max(1, Math.ceil(height / tile));
  const luts = new Uint8Array(tilesX * tilesY * 256);
  const hist = new Float64Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      hist.fill(0);
      const x0 = tx * tile, y0 = ty * tile, x1 = Math.min(width, x0 + tile), y1 = Math.min(height, y0 + tile);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[luma[y * width + x]]++;
      const count = (x1 - x0) * (y1 - y0), limit = Math.max(1, (maxSlope * count) / 256);
      let excess = 0;
      for (let v = 0; v < 256; v++) if (hist[v] > limit) { excess += hist[v] - limit; hist[v] = limit; }
      const share = excess / 256;
      const base = (ty * tilesX + tx) * 256;
      let cdf = 0;
      for (let v = 0; v < 256; v++) { cdf += hist[v] + share; luts[base + v] = Math.min(255, Math.round((cdf / count) * 255)); }
    }
  }
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) / tile - 0.5, 0), tilesY - 1);
    const ty0 = Math.floor(fy), ty1 = Math.min(tilesY - 1, ty0 + 1), wy = fy - ty0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) / tile - 0.5, 0), tilesX - 1);
      const tx0 = Math.floor(fx), tx1 = Math.min(tilesX - 1, tx0 + 1), wx = fx - tx0;
      const i = y * width + x, v = luma[i];
      const a = luts[(ty0 * tilesX + tx0) * 256 + v], b = luts[(ty0 * tilesX + tx1) * 256 + v];
      const c = luts[(ty1 * tilesX + tx0) * 256 + v], d = luts[(ty1 * tilesX + tx1) * 256 + v];
      const mapped = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      const p = i * channels;
      if (channels === 1) { out[p] = Math.round(mapped); continue; }
      // Shift colour channels by the luminance change; keeps hue roughly intact.
      const delta = mapped - v;
      for (let k = 0; k < channels; k++) out[p + k] = k < 3 ? clamp(Math.round(data[p + k] + delta), 0, 255) : data[p + k];
    }
  }
  return { data: out, width, height, channels };
}

async function threshold(img, { method = "adaptive", value = 128, blockSize, offset = 15 }) {
  const gray = await toGray(img);
  const out = Buffer.alloc(gray.data.length);
  if (method === "adaptive") {
    // Local mean via Gaussian blur; handles uneven lighting on pages and boards.
    // Default window scales with the image so thick strokes are not hollowed out.
    const block = blockSize ?? Math.max(15, Math.round(Math.max(gray.width, gray.height) / 30));
    const local = await rawImage(fromRaw(gray).blur(Math.max(0.5, block / 6)));
    for (let i = 0; i < out.length; i++) out[i] = gray.data[i] > local.data[i] - offset ? 255 : 0;
  } else {
    const t = method === "otsu" ? otsu(gray.data) : value;
    for (let i = 0; i < out.length; i++) out[i] = gray.data[i] > t ? 255 : 0;
  }
  return { ...gray, data: out };
}

async function edges(img) {
  const { data, width, height } = await toGray(img);
  const mag = new Float32Array(width * height);
  let max = 1;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = -data[i - width - 1] - 2 * data[i - 1] - data[i + width - 1] +
        data[i - width + 1] + 2 * data[i + 1] + data[i + width + 1];
      const gy = -data[i - width - 1] - 2 * data[i - width] - data[i - width + 1] +
        data[i + width - 1] + 2 * data[i + width] + data[i + width + 1];
      mag[i] = Math.hypot(gx, gy);
      if (mag[i] > max) max = mag[i];
    }
  }
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((mag[i] / max) * 255);
  return { data: out, width, height, channels: 1 };
}

export async function applyOp(img, step) {
  switch (step.op) {
    case "grayscale": return toGray(img);
    case "normalize": return rawImage(fromRaw(img).normalise());
    case "clahe": return clahe(img, { tile: step.tile ?? 48, maxSlope: step.maxSlope ?? 3 });
    case "contrast": { const f = step.factor ?? 1.5; return rawImage(fromRaw(img).linear(f, 128 * (1 - f))); }
    case "brightness": return rawImage(fromRaw(img).linear(step.factor ?? 1.3, 0));
    case "sharpen": return rawImage(fromRaw(img).sharpen({ sigma: step.sigma ?? 1.2 }));
    case "denoise": return rawImage(fromRaw(img).median(step.size ?? 3));
    case "threshold": return threshold(img, step);
    case "invert": return rawImage(fromRaw(img).negate({ alpha: false }));
    case "edges": return edges(img);
    default: throw new Error("Unknown operation " + step.op);
  }
}

async function encode(img) {
  // Single-channel results (threshold, edges, grayscale) stay lossless
  // greyscale PNGs; colour photos go straight to JPEG, which is far faster.
  if (img.channels === 1) {
    const png = await fromRaw(img).toColourspace("b-w").png({ compressionLevel: 6 }).toBuffer();
    if (png.length <= 1_500_000) return { data: png, mimeType: "image/png" };
  }
  return { data: await fromRaw(img).jpeg({ quality: 88 }).toBuffer(), mimeType: "image/jpeg" };
}

// Crop to `region`, scale to fit the output size (enlarging small crops up to
// MAX_UPSCALE×), then run `ops` in order.
async function prepare(entry, region) {
  const px = regionToPixels(region, entry.width, entry.height);
  // Zoomed regions may be enlarged; a whole-image view is only ever reduced.
  const scale = Math.min(region ? MAX_UPSCALE : 1, OUTPUT_LONG_SIDE / Math.max(px.width, px.height));
  const width = Math.max(1, Math.round(px.width * scale));
  const height = Math.max(1, Math.round(px.height * scale));
  const img = await rawImage(entrySharp(entry).extract(px)
    .resize({ width, height, kernel: "lanczos3" }));
  return { img, px, scale };
}

export async function processImage(entry, { region, ops = [] }) {
  const { img: start, px, scale } = await prepare(entry, region);
  let img = start;
  for (const step of ops) img = await applyOp(img, step);
  const encoded = await encode(img);
  return {
    ...encoded,
    width: img.width, height: img.height,
    region: pixelsToRegion(px, entry.width, entry.height),
    scale,
  };
}

export const rowLabel = (index) => String.fromCharCode(65 + index);

// Cell label "C7" → normalized centre point in the full source image.
export function cellCenter(label, { rows, cols, region }) {
  const match = /^([A-Z])(\d{1,2})$/.exec(String(label).trim().toUpperCase());
  if (!match) throw new Error("Cell labels look like C7 (row letter, column number)");
  const row = match[1].charCodeAt(0) - 65, col = Number(match[2]) - 1;
  if (row < 0 || row >= rows || col < 0 || col >= cols) throw new Error("Cell " + label + " is outside the grid");
  return {
    x: region.x + ((col + 0.5) / cols) * (region.x2 - region.x),
    y: region.y + ((row + 0.5) / rows) * (region.y2 - region.y),
  };
}

export async function overlayGrid(entry, { region, rows = 8, cols = 8 }) {
  const { img, px, scale } = await prepare(entry, region);
  const { width, height } = img;
  const lines = [];
  for (let c = 1; c < cols; c++) {
    const x = (c / cols) * width;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  }
  for (let r = 1; r < rows; r++) {
    const y = (r / rows) * height;
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  }
  // Glyph pixel size: as large as fits a cell's corner, at least 1.
  const cellW = width / cols, cellH = height / rows;
  const px1 = Math.max(1, Math.floor(Math.min(cellW / (labelWidth(rowLabel(rows - 1) + cols) + 4), cellH / (GLYPH_HEIGHT + 4)) * 0.6));
  const labels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      labels.push(labelSvg(rowLabel(r) + (c + 1), c * cellW + 2, r * cellH + 2, px1));
    }
  }
  // Dark line on a white halo stays visible on both light and dark images.
  const stroke = Math.max(1, Math.round(Math.max(width, height) / 800));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges">` +
    `<g stroke="white" stroke-width="${stroke * 3}" opacity=".85">${lines.join("")}</g>` +
    `<g stroke="#111" stroke-width="${stroke}">${lines.join("")}</g>${labels.join("")}</svg>`;
  const composed = await rawImage(fromRaw(img).composite([{ input: Buffer.from(svg) }]));
  const encoded = await encode(composed);
  return {
    ...encoded,
    width, height,
    region: pixelsToRegion(px, entry.width, entry.height),
    scale, rows, cols,
  };
}

export async function previewImage(entry) {
  return processImage(entry, { ops: [] });
}

// What the person sees in the present_visual canvas: the original pixels,
// only reduced, as a compact JPEG.
export const DISPLAY_LONG_SIDE = 1400;
export async function displayImage(entry) {
  // Cached on the entry: present_visual is often called again for one photo.
  entry.display ??= entrySharp(entry)
    .resize({ width: DISPLAY_LONG_SIDE, height: DISPLAY_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 }).toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ data, mimeType: "image/jpeg", width: info.width, height: info.height }))
    .catch((error) => { entry.display = undefined; throw error; });
  return entry.display;
}

// Keep widget payloads small: ChatGPT drops the widget's data when a tool
// result gets too big, so large processed views become modest JPEGs.
export const VIEW_LONG_SIDE = 1200;
export async function compactForDisplay(out, maxBytes = 220_000) {
  if (out.data.length <= maxBytes) return out;
  const shrink = (quality) => sharp(out.data)
    .resize({ width: VIEW_LONG_SIDE, height: VIEW_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality }).toBuffer();
  let data = await shrink(78);
  if (data.length > maxBytes) data = await shrink(62);
  return { ...out, data, mimeType: "image/jpeg" };
}

// A sharper tile of the photo for the canvas when the user zooms in: the
// region at native resolution (never enlarged), long side <= maxSide. When
// the source file is larger than the working copy, the tile is cut from the
// source itself (RFC PRE-04), so zooming past 4096 px shows real pixels.
const tileCache = new Map();
const TILE_CACHE = 24;
export async function regionTile(entry, region, maxSide = 1600) {
  const px = regionToPixels(region, entry.width, entry.height);
  const side = Math.min(2048, Math.max(256, Math.round(maxSide)));
  const src = entry.sourceInfo;
  const useSource = Boolean(entry.sourceBytes && src && src.width > entry.width * 1.05 &&
    Math.max(px.width, px.height) < side);
  const box = useSource ? regionToPixels(region, src.width, src.height) : px;
  const key = entry.imageId + ":" + (useSource ? "s" : "w") + ":" + [box.left, box.top, box.width, box.height, side].join(",");
  const hit = tileCache.get(key);
  if (hit) { tileCache.delete(key); tileCache.set(key, hit); return hit; }
  const base = useSource
    ? sharp(entry.sourceBytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().extract(box).flatten({ background: "#ffffff" }).toColourspace("srgb")
    : entrySharp(entry).extract(px);
  const { data, info } = await base
    .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const tile = { data, mimeType: "image/jpeg", width: info.width, height: info.height,
    region: useSource ? pixelsToRegion(box, src.width, src.height) : pixelsToRegion(px, entry.width, entry.height),
    native: useSource, sourcePixels: { width: box.width, height: box.height } };
  tileCache.set(key, tile);
  while (tileCache.size > TILE_CACHE) tileCache.delete(tileCache.keys().next().value);
  return tile;
}
