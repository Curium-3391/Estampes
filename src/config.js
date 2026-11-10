// Every deployment setting comes from the environment, so Docker, Heroku and
// Render run the same code with different .env files. Bad values fall back
// to the default with a warning instead of stopping the server.
import { resolve } from "node:path";

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
  accessKey: (process.env.ESTAMPES_ACCESS_KEY ?? "").trim(),
  // Docker sets this: without an access key, generate and keep one rather
  // than start an open server. ESTAMPES_ALLOW_OPEN=1 opts out.
  requireKey: str("ESTAMPES_REQUIRE_KEY") === "1",
  allowOpen: str("ESTAMPES_ALLOW_OPEN") === "1",
  // Proxies of yours in front of Estampes whose X-Forwarded-* headers can be
  // trusted. Render and Heroku always add one.
  trustProxy: num("ESTAMPES_TRUST_PROXY", process.env.RENDER || process.env.DYNO ? 1 : 0, { max: 10 }),
  corsOrigins: str("ESTAMPES_CORS_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
  rateLimitPerMin: num("ESTAMPES_RATE_LIMIT_PER_MIN", 120),
  // Empty = memory only (the old behaviour). Docker sets /data.
  storageDir: str("ESTAMPES_STORAGE_DIR"),
  // The UVA Beta editor (experimental_workspace). The UVA store itself is on
  // whenever the canvas store is "uva" (the default) and storage is on disk.
  uvaBeta: str("ESTAMPES_UVA_BETA") === "1",
  // The UVA store's own folder, never inside ESTAMPES_STORAGE_DIR. Docker sets
  // /uva-beta (its own volume); otherwise a sibling "<storage>-uva" folder.
  uvaBetaDir: str("ESTAMPES_UVA_DIR") || str("ESTAMPES_UVA_BETA_DIR") || (str("ESTAMPES_STORAGE_DIR") ? resolve(str("ESTAMPES_STORAGE_DIR")).replace(/\/+$/, "") + "-uva" : ""),
  // linux-process-crash-test survives a killed process, not a power loss
  // (docs/UVA-BETA.md). It is the default on Linux; elsewhere UVA needs a choice.
  uvaBetaProfile: str("ESTAMPES_UVA_PROFILE") || str("ESTAMPES_UVA_BETA_PROFILE") || (process.platform === "linux" ? "linux-process-crash-test" : ""),
  // Copy canvas checkpoints into UVA documents (needs the UVA Beta). Default off.
  uvaMirror: str("ESTAMPES_UVA_MIRROR") === "1",
  // Where canvases, workspaces, surfaces and notebooks are committed: "uva" (the
  // default: their UVA documents; needs ESTAMPES_STORAGE_DIR) or "legacy" (the
  // older files only). The legacy files are still written in "uva" mode, so
  // ESTAMPES_CANVAS_STORE=legacy switches back without losing an edit.
  canvasStore: str("ESTAMPES_CANVAS_STORE", "uva").toLowerCase() === "legacy" ? "legacy" : "uva",
  uvaAssetMaxMb: num("ESTAMPES_UVA_ASSET_MAX_MB", 1024, { min: 64, max: 1048576 }),
  // Total commits a UVA store accepts from canvases (its open time grows with them).
  uvaMirrorMaxCommits: num("ESTAMPES_UVA_MIRROR_MAX_COMMITS", 10000, { min: 1, max: 1000000 }),
  uvaMirrorIdleSec: num("ESTAMPES_UVA_MIRROR_IDLE_SEC", 15, { min: 0, max: 3600 }),
  retentionDays: num("ESTAMPES_STORAGE_RETENTION_DAYS", 0, { max: 36500 }),
  maxImageBytes: num("ESTAMPES_MAX_IMAGE_MB", 20, { min: 1, max: 200 }) * 1024 * 1024,
  maxInputPixels: num("ESTAMPES_MAX_IMAGE_MEGAPIXELS", 50, { min: 1, max: 500 }) * 1_000_000,
  workingLongSide: num("ESTAMPES_WORKING_LONG_SIDE", 4096, { min: 512, max: 16384 }),
  // Largest crop (in megapixels) processed at native or working resolution;
  // bigger crops are reduced to fit and the result says so.
  // Largest tool result in characters (claude.ai drops results above about
  // 150,000); model-facing images shrink to fit. 0 turns it off.
  maxResultChars: num("ESTAMPES_MAX_RESULT_CHARS", 145_000, { min: 0, max: 100_000_000 }),
  maxAnalysisPixels: num("ESTAMPES_MAX_ANALYSIS_MEGAPIXELS", 16, { min: 1, max: 200 }) * 1_000_000,
  // Processed-view recipes remembered per image (get_derived_view).
  derivedViewsPerImage: num("ESTAMPES_DERIVED_VIEWS_PER_IMAGE", 200, { min: 10, max: 10000 }),
  cacheBytes: num("ESTAMPES_CACHE_MB", 160, { min: 16, max: 65536 }) * 1024 * 1024,
  cacheImages: num("ESTAMPES_CACHE_IMAGES", 12, { min: 1, max: 1000 }),
  cacheTtlMs: num("ESTAMPES_CACHE_TTL_MINUTES", 60, { min: 1, max: 525600 }) * 60 * 1000,
  // cloudflared metrics address of the optional quick tunnel (compose sets it).
  tunnelMetrics: str("ESTAMPES_TUNNEL_METRICS"),
  // Unix socket of the separate SymPy service (cas-service/). Empty = no calculator.
  casSocket: str("ESTAMPES_CAS_SOCKET"),
  // Optional: ESTAMPES_ADMIN_KEY overrides the generated <storage>/admin-key.
  adminKey: (process.env.ESTAMPES_ADMIN_KEY ?? "").trim(),
  // Install module packages that carry no signature (they are always shown as high risk).
  moduleAllowUnsigned: str("ESTAMPES_MODULE_ALLOW_UNSIGNED") === "1",
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
