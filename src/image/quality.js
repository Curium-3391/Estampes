// Image quality measurements (RFC F07, B14, C12): what limits reading this
// image, measured before choosing filters. Blur (variance of the
// Laplacian), noise (Immerkaer's estimate), contrast and dynamic range,
// clipping per channel, colour cast, a luminance histogram and the
// dominant line direction. Numbers depend on the analysis resolution, which
// the result states; compare them only between crops at the same scale.
import sharp from "sharp";
import { toGray } from "../image-ops.js";
import { estimateSkew } from "./geometry.js";

export const QUALITY_VERSION = "1";

export async function measureQuality(img) {
  const gray = await toGray(img);
  const { data, width, height } = gray;
  const n = width * height;
  // Laplacian variance (sharpness) and Immerkaer noise sigma.
  let lapSum = 0, lapSq = 0, noiseSum = 0, count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const lap = data[i - 1] + data[i + 1] + data[i - width] + data[i + width] - 4 * data[i];
    lapSum += lap; lapSq += lap * lap;
    const m = data[i - width - 1] - 2 * data[i - width] + data[i - width + 1] - 2 * data[i - 1] + 4 * data[i] - 2 * data[i + 1] + data[i + width - 1] - 2 * data[i + width] + data[i + width + 1];
    noiseSum += Math.abs(m); count++;
  }
  const lapVar = count ? lapSq / count - (lapSum / count) ** 2 : 0;
  const noiseSigma = count ? Math.sqrt(Math.PI / 2) * noiseSum / (6 * count) : 0;
  const hist = new Array(256).fill(0);
  let sum = 0, sq = 0;
  for (const v of data) { hist[v]++; sum += v; sq += v * v; }
  const mean = sum / n, rms = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const pct = (p) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= (p / 100) * n) return v; } return 255; };
  const p1 = pct(1), p99 = pct(99);
  // Clipping per channel and colour cast on the colour image.
  const ch = img.channels, cols = Math.min(3, ch);
  const low = new Array(cols).fill(0), high = new Array(cols).fill(0), means = new Array(cols).fill(0);
  for (let i = 0; i < img.data.length; i += ch) for (let k = 0; k < cols; k++) {
    const v = img.data[i + k]; means[k] += v;
    if (v <= 2) low[k]++; else if (v >= 253) high[k]++;
  }
  const frac = (v) => Number((v / n).toFixed(4));
  const channelNames = cols === 3 ? ["red", "green", "blue"] : ["grey"];
  const clipping = Object.fromEntries(channelNames.map((name, k) => [name, { shadows: frac(low[k]), highlights: frac(high[k]) }]));
  const cm = means.map((m) => m / n);
  const cast = cols === 3 ? { red: Number((cm[0] - (cm[0] + cm[1] + cm[2]) / 3).toFixed(1)), green: Number((cm[1] - (cm[0] + cm[1] + cm[2]) / 3).toFixed(1)), blue: Number((cm[2] - (cm[0] + cm[1] + cm[2]) / 3).toFixed(1)) } : null;
  const bins = [];
  for (let b = 0; b < 32; b++) { let c = 0; for (let v = b * 8; v < b * 8 + 8; v++) c += hist[v]; bins.push(Number((c / n).toFixed(4))); }
  const skew = await estimateSkew(gray);
  const metrics = {
    width, height,
    sharpness: { laplacianVariance: Number(lapVar.toFixed(1)) },
    noise: { sigma: Number(noiseSigma.toFixed(2)) },
    contrast: { mean: Number(mean.toFixed(1)), rms: Number(rms.toFixed(1)), p1, p99, dynamicRange: p99 - p1 },
    clipping, ...(cast ? { colourCast: cast } : {}),
    histogram: { bins: 32, binWidth: 8, fractions: bins },
    dominantLine: { skewDeg: skew.angle, confidence: skew.confidence },
  };
  return { metrics, advice: advise(metrics) };
}

// Plain hints for the model; it still decides what to do.
function advise(m) {
  const out = [];
  if (m.sharpness.laplacianVariance < 60) out.push("soft or blurred at this scale: sharpening cannot add detail; try sampling native, or ask for a sharper photo");
  if (m.noise.sigma > 8) out.push("noisy (sigma " + m.noise.sigma + "): denoise before threshold or edges; it may erase thin lines");
  if (m.contrast.dynamicRange < 80) out.push("low contrast (1-99% range " + m.contrast.dynamicRange + "): levels or clahe");
  const hi = Math.max(...Object.values(m.clipping).map((c) => c.highlights)), lo = Math.max(...Object.values(m.clipping).map((c) => c.shadows));
  if (hi > 0.02) out.push(Math.round(hi * 100) + "% clipped highlights (glare): no filter recovers them; detail there is lost");
  if (lo > 0.05) out.push(Math.round(lo * 100) + "% crushed shadows: gamma or levels may show a little; clipped pixels stay black");
  if (m.colourCast && Math.max(...Object.values(m.colourCast).map(Math.abs)) > 12) out.push("colour cast: white_balance (gray_world) before reading colours");
  if (m.dominantLine.confidence > 0.2 && Math.abs(m.dominantLine.skewDeg) > 0.5) out.push("lines are tilted " + m.dominantLine.skewDeg + "°: geometry deskew");
  return out;
}

// Clipping map: highlights red, shadows blue, over a dim grey copy.
export async function clippingMap(img) {
  const { data, width, height, channels } = img;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, p = 0; p < out.length; i += channels, p += 3) {
    const r = data[i], g = channels >= 3 ? data[i + 1] : r, b = channels >= 3 ? data[i + 2] : r;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const hot = r >= 253 || g >= 253 || b >= 253, cold = r <= 2 && g <= 2 && b <= 2;
    const base = Math.round(luma * 0.5 + 64);
    out[p] = hot ? 255 : cold ? 0 : base; out[p + 1] = hot || cold ? 0 : base; out[p + 2] = cold ? 255 : hot ? 0 : base;
  }
  return { data: await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer(), mimeType: "image/png", width, height };
}
