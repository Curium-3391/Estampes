// M0.5: real-image intake. Images arrive either as a ChatGPT file param
// ({download_url, file_id, ...} via _meta["openai/fileParams"]) or as a
// public https URL the model found. Both are fetched server-side, normalized
// (EXIF orientation applied, long side capped) and kept in a small in-memory
// cache keyed by a content hash. Nothing is logged; with
// ESTAMPES_STORAGE_DIR set, src/storage.js also keeps the source bytes and
// canvas on disk so an image survives eviction and restarts.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";
import { config } from "./config.js";

export const MAX_DOWNLOAD_BYTES = config.maxImageBytes;
export const MAX_INPUT_PIXELS = config.maxInputPixels;
export const WORKING_LONG_SIDE = config.workingLongSide;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const CACHE_LIMIT = config.cacheImages;
// Render free instances have 512 MB of RAM; the default keeps cached pixels
// well under it. Pixels are cached raw: a 4096×3072 photo is ~38 MB.
const CACHE_BYTES = config.cacheBytes;
const CACHE_TTL_MS = config.cacheTtlMs;
const MB = Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) + " MB";

const cache = new Map();

function isPrivateAddress(address) {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80")) return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

// Only public https hosts. This blocks the obvious SSRF targets (metadata
// services, localhost, LAN); DNS rebinding between check and fetch is an
// accepted residual risk for this experimental server.
export async function assertPublicHttpsUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Image URL is not a valid absolute URL"); }
  if (url.protocol !== "https:") throw new Error("Only https image URLs are accepted");
  if (url.username || url.password) throw new Error("Image URLs with credentials are not accepted");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error("Image URL must resolve to a public address");
  }
  return url;
}

async function readLimited(response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than " + MB);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than " + MB);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadImage(rawUrl, { fetchImpl = fetch, checkUrl = assertPublicHttpsUrl } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await checkUrl(current);
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location"), url).toString();
      continue;
    }
    if (!response.ok) throw new Error("Image download failed with HTTP " + response.status);
    return readLimited(response);
  }
  throw new Error("Too many redirects while downloading image");
}

// Raw working pixels plus the source file kept for native-resolution crops.
const entryBytes = (entry) => entry.pixels.length + (entry.sourceBytes?.length ?? 0);

function prune(now = Date.now()) {
  for (const [id, entry] of cache) if (now - entry.touched > CACHE_TTL_MS) cache.delete(id);
  let bytes = 0;
  for (const entry of cache.values()) bytes += entryBytes(entry);
  // Map order is least-recently used first; always keep the newest entry.
  while (cache.size > 1 && (cache.size > CACHE_LIMIT || bytes > CACHE_BYTES)) {
    const [oldest, entry] = cache.entries().next().value;
    bytes -= entryBytes(entry);
    cache.delete(oldest);
  }
}

// Decode with sharp (which also rejects non-images), apply EXIF orientation
// and cap the working size. Coordinates are always normalized to this
// oriented image, so the cap never changes what a coordinate means.
export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const imageIdOf = (bytes) => "img:" + sha256Of(bytes).slice(0, 16);

// The same bytes again return the cached entry, so its marks survive.
export async function registerImage(bytes, { source, fileName = null, page = null } = {}) {
  const imageId = imageIdOf(bytes);
  if (cache.has(imageId)) return getImage(imageId);
  let meta;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error("The file is not a supported image (or exceeds " + MAX_INPUT_PIXELS / 1e6 + " megapixels)");
  }
  const working = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: WORKING_LONG_SIDE, height: WORKING_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const digest = sha256Of(bytes);
  const entry = {
    imageId,
    // The full hash is the immutable source asset's identity (RFC PRE-02);
    // imageId stays the short form every tool already uses.
    sourceAssetId: "sha256:" + digest,
    sourceBytes: bytes,
    sourceInfo: describeSource(meta, bytes.length),
    pixels: working.data,
    channels: working.info.channels,
    width: working.info.width,
    height: working.info.height,
    original: { format: meta.format, width: meta.width, height: meta.height },
    source,
    fileName,
    // Set when the image is a rendered PDF page (src/image/pdf.js).
    ...(page ? { page } : {}),
    touched: Date.now(),
  };
  cache.set(imageId, entry);
  prune();
  return entry;
}

// What the source file is, reported rather than silently dropped (RFC A04):
// stored vs oriented size, EXIF orientation, colour space, bit depth, alpha,
// ICC profile and density. Oriented width/height is the frame of `source`
// pixel coordinates.
export function describeSource(meta, bytes) {
  const orientation = meta.orientation ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  const depthBits = { uchar: 8, char: 8, ushort: 16, short: 16, uint: 32, int: 32, float: 32, complex: 64, double: 64, dpcomplex: 128 }[meta.depth] ?? null;
  return {
    format: meta.format ?? null,
    bytes,
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    storedWidth: meta.width, storedHeight: meta.height,
    orientation,
    colorSpace: meta.space ?? null,
    channels: meta.channels ?? null,
    bitDepth: meta.bitsPerSample ?? depthBits,
    hasAlpha: Boolean(meta.hasAlpha),
    hasIccProfile: Boolean(meta.hasProfile),
    density: meta.density ?? null,
    pages: meta.pages ?? 1,
    progressive: Boolean(meta.isProgressive),
    ...(meta.chromaSubsampling ? { chromaSubsampling: meta.chromaSubsampling } : {}),
  };
}

export function getImage(imageId) {
  const entry = cache.get(imageId);
  if (!entry) {
    throw new Error("Unknown or expired imageId " + imageId + "; call load_image again (images are kept in memory about " +
      Math.round(CACHE_TTL_MS / 60000) + " min" + (config.storageDir ? " and on disk until removed" : "") + ")");
  }
  entry.touched = Date.now();
  cache.delete(imageId);
  cache.set(imageId, entry);
  return entry;
}

// A sharp pipeline over an entry's cached pixels.
export const entrySharp = (entry) =>
  sharp(entry.pixels, { raw: { width: entry.width, height: entry.height, channels: entry.channels } });

export const hasImage = (imageId) => cache.has(imageId);

export function clearImages() {
  cache.clear();
}
