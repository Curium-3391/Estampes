// Every deployment setting comes from the environment, so Docker, Heroku and
// Render run the same code with different .env files. Bad values fall back
// to the default with a warning instead of stopping the server.
const warnings = [];

function num(name, fallback, { min = 0, max = Infinity, integer = true } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    warnings.push(name + "=" + JSON.stringify(raw) + " is not valid (" + min + ".." + max + "); using " + fallback);
    return fallback;
  }
  return value;
}

const str = (name, fallback = "") => (process.env[name] ?? fallback).trim();

export const config = Object.freeze({
  port: num("PORT", 8787, { min: 1, max: 65535 }),
  host: str("HOST", "0.0.0.0") || "0.0.0.0",
  // Origin used in download links; empty = taken from the incoming request.
  publicUrl: (str("PUBLIC_BASE_URL") || str("RENDER_EXTERNAL_URL")).replace(/\/+$/, ""),
  accessKey: process.env.ESTAMPES_ACCESS_KEY ?? "",
  corsOrigins: str("ESTAMPES_CORS_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
  rateLimitPerMin: num("ESTAMPES_RATE_LIMIT_PER_MIN", 120),
  // Empty = memory only (the old behaviour). Docker sets /data.
  storageDir: str("ESTAMPES_STORAGE_DIR"),
  retentionDays: num("ESTAMPES_STORAGE_RETENTION_DAYS", 0, { max: 36500 }),
  maxImageBytes: num("ESTAMPES_MAX_IMAGE_MB", 20, { min: 1, max: 200 }) * 1024 * 1024,
  maxInputPixels: num("ESTAMPES_MAX_IMAGE_MEGAPIXELS", 50, { min: 1, max: 500 }) * 1_000_000,
  workingLongSide: num("ESTAMPES_WORKING_LONG_SIDE", 4096, { min: 512, max: 16384 }),
  cacheBytes: num("ESTAMPES_CACHE_MB", 160, { min: 16, max: 65536 }) * 1024 * 1024,
  cacheImages: num("ESTAMPES_CACHE_IMAGES", 12, { min: 1, max: 1000 }),
  cacheTtlMs: num("ESTAMPES_CACHE_TTL_MINUTES", 60, { min: 1, max: 525600 }) * 60 * 1000,
  logFormat: str("ESTAMPES_LOG_FORMAT", "text") === "json" ? "json" : "text",
});

export const configWarnings = () => [...warnings];

// One line per event on stdout/stderr, which `docker compose logs`, Heroku
// and Render all collect. json gives one object per line for log tools.
export function log(level, message, fields = {}) {
  const line = config.logFormat === "json"
    ? JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })
    : message + Object.entries(fields).map(([k, v]) => " " + k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join("");
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
