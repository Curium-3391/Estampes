// M0.5: real-image intake. Images arrive either as a ChatGPT file param
// ({download_url, file_id, ...} via _meta["openai/fileParams"]) or as a
// public https URL the model found. Both are fetched server-side, normalized
// (EXIF orientation applied, long side capped) and kept in a small in-memory
// cache keyed by a content hash. Nothing is written to disk or logged.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 50_000_000;
export const WORKING_LONG_SIDE = 4096;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const CACHE_LIMIT = 12;
// Render free instances have 512 MB of RAM; keep cached pixels well under it.
const CACHE_BYTES = 160 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

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
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than 20 MB");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than 20 MB");
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

function prune(now = Date.now()) {
  for (const [id, entry] of cache) if (now - entry.touched > CACHE_TTL_MS) cache.delete(id);
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.png.length;
  // Map order is least-recently used first; always keep the newest entry.
  while (cache.size > 1 && (cache.size > CACHE_LIMIT || bytes > CACHE_BYTES)) {
    const [oldest, entry] = cache.entries().next().value;
    bytes -= entry.png.length;
    cache.delete(oldest);
  }
}

// Decode with sharp (which also rejects non-images), apply EXIF orientation
// and cap the working size. Coordinates are always normalized to this
// oriented image, so the cap never changes what a coordinate means.
export async function registerImage(bytes, { source, fileName = null } = {}) {
  let meta;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error("The file is not a supported image (or exceeds 50 megapixels)");
  }
  const working = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: WORKING_LONG_SIDE, height: WORKING_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  const imageId = "img:" + createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const entry = {
    imageId,
    png: working.data,
    width: working.info.width,
    height: working.info.height,
    original: { format: meta.format, width: meta.width, height: meta.height },
    source,
    fileName,
    touched: Date.now(),
  };
  cache.delete(imageId);
  cache.set(imageId, entry);
  prune();
  return entry;
}

export function getImage(imageId) {
  const entry = cache.get(imageId);
  if (!entry) {
    throw new Error("Unknown or expired imageId " + imageId + "; call load_image again (images are kept about an hour)");
  }
  entry.touched = Date.now();
  cache.delete(imageId);
  cache.set(imageId, entry);
  return entry;
}

export function clearImages() {
  cache.clear();
}
