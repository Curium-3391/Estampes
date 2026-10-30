// More pixel operators (RFC 4B/4C, P1): exposure, levels, white balance,
// channel views, illumination correction, morphology and Canny edges.
// Like the original ten, they change pixels for a person or model to read;
// none of them identifies anything. Kernel sizes are in analysis pixels, and
// the derived view record says how many source pixels that is.
import { rawImage, fromRaw, toGray, sameBands } from "../image-ops.js";

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const mapChannels = (img, lut, { alpha = true } = {}) => {
  const { data, channels } = img;
  const out = Buffer.alloc(data.length);
  const colour = channels >= 3 ? 3 : 1;
  for (let i = 0; i < data.length; i += channels) {
    for (let k = 0; k < channels; k++) out[i + k] = k < colour || !alpha ? lut(data[i + k], k) : data[i + k];
  }
  return { ...img, data: out };
};

// Gamma on display values (exposure-like, unlike the multiplicative
// `brightness`): out = 255 * (in/255)^(1/gamma). gamma > 1 brightens shadows.
export function gamma(img, { gamma: g = 1.5 } = {}) {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp8(255 * (v / 255) ** (1 / g));
  return mapChannels(img, (v) => lut[v]);
}

const lumaOf = (data, channels, i) => channels >= 3 ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] : data[i];

// Percentile stretch: black point at `low`%, white point at `high`% of the
// luminance histogram, so a few hot or dead pixels do not decide the range.
export function levels(img, { low = 1, high = 99, black, white } = {}) {
  const { data, channels } = img;
  let lo = black, hi = white;
  if (lo === undefined || hi === undefined) {
    const hist = new Float64Array(256);
    for (let i = 0; i < data.length; i += channels) hist[Math.round(lumaOf(data, channels, i))]++;
    const total = data.length / channels;
    const at = (p) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= (p / 100) * total) return v; } return 255; };
    lo ??= at(low); hi ??= at(high);
  }
  if (hi <= lo) hi = Math.min(255, lo + 1);
  return mapChannels(img, (v) => clamp8(((v - lo) * 255) / (hi - lo)));
}

// Gray world (average colour becomes neutral) or white patch (the brightest
// percentile becomes white).
export function whiteBalance(img, { method = "gray_world", percentile = 99 } = {}) {
  const { data, channels } = img;
  if (channels < 3) return img;
  const gains = [1, 1, 1];
  if (method === "white_patch") {
    for (let k = 0; k < 3; k++) {
      const hist = new Float64Array(256);
      for (let i = k; i < data.length; i += channels) hist[data[i]]++;
      let c = 0, v = 255;
      const target = (percentile / 100) * (data.length / channels);
      for (let t = 0; t < 256; t++) { c += hist[t]; if (c >= target) { v = t; break; } }
      gains[k] = 255 / Math.max(1, v);
    }
  } else {
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += channels) for (let k = 0; k < 3; k++) sum[k] += data[i + k];
    const mean = (sum[0] + sum[1] + sum[2]) / 3;
    for (let k = 0; k < 3; k++) gains[k] = mean / Math.max(1, sum[k]);
  }
  return mapChannels(img, (v, k) => (k < 3 ? clamp8(v * gains[k]) : v));
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60 + 360) % 360) / 360 * 255, max ? (d / max) * 255 : 0, max];
}
function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [(116 * Y - 16) * 2.55, 500 * (X - Y) + 128, 200 * (Y - Z) + 128];
}

// One channel as a grey image: r, g, b, hue, saturation, value, or Lab
// lightness / a (green-red) / b (blue-yellow), scaled to 0..255.
export function channel(img, { channel: ch = "value" } = {}) {
  const { data, width, height, channels } = img;
  const out = Buffer.alloc(width * height);
  for (let i = 0, p = 0; p < out.length; i += channels, p++) {
    const r = data[i], g = channels >= 3 ? data[i + 1] : r, b = channels >= 3 ? data[i + 2] : r;
    let v;
    switch (ch) {
      case "red": v = r; break;
      case "green": v = g; break;
      case "blue": v = b; break;
      case "hue": v = rgbToHsv(r, g, b)[0]; break;
      case "saturation": v = rgbToHsv(r, g, b)[1]; break;
      case "value": v = Math.max(r, g, b); break;
      case "lab_l": v = rgbToLab(r, g, b)[0]; break;
      case "lab_a": v = rgbToLab(r, g, b)[1]; break;
      case "lab_b": v = rgbToLab(r, g, b)[2]; break;
      default: throw new Error("Unknown channel " + ch);
    }
    out[p] = clamp8(v);
  }
  return { data: out, width, height, channels: 1 };
}

// Flat-field: divide by a heavily blurred copy (the estimated illumination),
// which removes vignetting, uneven scanner light and shadows across a page.
export async function flatField(img, { radius } = {}) {
  const sigma = radius ?? Math.max(8, Math.round(Math.max(img.width, img.height) / 16));
  const bg = await rawImage(sameBands(img, fromRaw(img).blur(Math.min(1000, sigma))));
  const { data, channels } = img;
  const sums = new Float64Array(Math.min(channels, 3));
  for (let i = 0; i < data.length; i += channels) for (let k = 0; k < sums.length; k++) sums[k] += bg.data[i + k];
  const means = [...sums].map((s) => s / (data.length / channels));
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += channels) {
    for (let k = 0; k < channels; k++) out[i + k] = k < sums.length ? clamp8((data[i + k] * means[k]) / Math.max(1, bg.data[i + k])) : data[i + k];
  }
  return { ...img, data: out };
}

// Grey morphology with a square or disk structuring element of `radius`
// analysis pixels: erode (min), dilate (max), open, close.
function morphPass(gray, radius, shape, max) {
  const { data, width, height } = gray;
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (shape === "disk" && dx * dx + dy * dy > radius * radius + 0.5) continue;
    offsets.push([dx, dy]);
  }
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = max ? 0 : 255;
    for (const [dx, dy] of offsets) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const s = data[yy * width + xx];
      if (max ? s > v : s < v) v = s;
    }
    out[y * width + x] = v;
  }
  return { ...gray, data: out };
}
export async function morphology(img, { operation = "open", radius = 1, shape = "square" } = {}) {
  const gray = await toGray(img);
  const erode = (g) => morphPass(g, radius, shape, false), dilate = (g) => morphPass(g, radius, shape, true);
  switch (operation) {
    case "erode": return erode(gray);
    case "dilate": return dilate(gray);
    case "open": return dilate(erode(gray));
    case "close": return erode(dilate(gray));
    default: throw new Error("Unknown morphology operation " + operation);
  }
}

// Canny: Gaussian blur, Sobel gradients, non-maximum suppression and
// hysteresis between `low` and `high` (fractions of the strongest gradient
// in the crop, so thresholds are relative, not comparable across images).
export async function canny(img, { sigma = 1.4, low = 0.1, high = 0.25 } = {}) {
  const gray = await toGray(img);
  const blurred = sigma >= 0.3 ? await rawImage(sameBands(gray, fromRaw(gray).blur(sigma))) : gray;
  const { data, width, height } = blurred;
  const mag = new Float32Array(width * height), dir = new Uint8Array(width * height);
  let maxMag = 1;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = -data[i - width - 1] - 2 * data[i - 1] - data[i + width - 1] + data[i - width + 1] + 2 * data[i + 1] + data[i + width + 1];
    const gy = -data[i - width - 1] - 2 * data[i - width] - data[i - width + 1] + data[i + width - 1] + 2 * data[i + width] + data[i + width + 1];
    const m = Math.hypot(gx, gy);
    mag[i] = m; if (m > maxMag) maxMag = m;
    const a = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  const nms = new Float32Array(width * height);
  const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, [dx, dy] = off[dir[i]];
    const m = mag[i];
    if (m >= mag[i + dy * width + dx] && m >= mag[i - dy * width - dx]) nms[i] = m;
  }
  const hi = high * maxMag, lo = low * maxMag;
  const out = Buffer.alloc(width * height);
  const stack = [];
  for (let i = 0; i < nms.length; i++) if (nms[i] >= hi && !out[i]) { out[i] = 255; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % width, y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const j = yy * width + xx;
      if (!out[j] && nms[j] >= lo) { out[j] = 255; stack.push(j); }
    }
  }
  return { data: out, width, height, channels: 1 };
}

export async function applyExtraOp(img, s) {
  switch (s.op) {
    case "gamma": return gamma(img, s);
    case "levels": return levels(img, s);
    case "white_balance": return whiteBalance(img, s);
    case "channel": return channel(img, s);
    case "flat_field": return flatField(img, s);
    case "morphology": return morphology(img, s);
    case "canny": return canny(img, s);
    default: return null;
  }
}
export const EXTRA_OP_NAMES = Object.freeze(["gamma", "levels", "white_balance", "channel", "flat_field", "morphology", "canny"]);
