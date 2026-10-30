// Secure defaults for self-hosting. Docker sets ESTAMPES_REQUIRE_KEY=1: with
// no ESTAMPES_ACCESS_KEY the server makes one on first start, keeps it in the
// storage folder (mode 600) and reuses it, instead of starting open. Running
// open then takes an explicit ESTAMPES_ALLOW_OPEN=1.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export const KEY_FILE = "access-key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{24,256}$/;

// Returns { key, source }: env (set by the operator), file (generated
// earlier), generated (new, saved), memory (new, no storage to keep it in)
// or open (no key, explicitly allowed or not required).
export async function resolveAccessKey({ configured = "", require = false, allowOpen = false, storageDir = "" } = {}) {
  if (configured) return { key: configured, source: "env" };
  if (!require || allowOpen) return { key: "", source: "open" };
  const path = storageDir ? join(storageDir, KEY_FILE) : "";
  if (path) {
    try {
      const saved = (await readFile(path, "utf8")).trim();
      if (KEY_PATTERN.test(saved)) return { key: saved, source: "file", path };
    } catch {}
  }
  const key = randomBytes(24).toString("base64url");
  if (!path) return { key, source: "memory" };
  await mkdir(storageDir, { recursive: true });
  await writeFile(path, key + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return { key, source: "generated", path };
}

export function sameSecret(given, key) {
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The client address for rate limiting. X-Forwarded-For can be written by
// anyone, so it only counts when the operator says how many proxies of
// theirs sit in front (ESTAMPES_TRUST_PROXY): the client is then the entry
// that many hops from the right, the last one a trusted proxy appended.
export function clientIp(req, trustHops = 0) {
  const direct = req.socket?.remoteAddress || "unknown";
  if (!(trustHops > 0)) return direct;
  const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain.length >= trustHops ? chain[chain.length - trustHops] : chain[0] || direct;
}

// Download links carry an HMAC of the image hash and file name when a key is
// set, so knowing an image's hash alone is not enough to download it.
export const exportSignature = (key, hex, file) =>
  createHmac("sha256", key).update("export:" + hex + "/" + file).digest("base64url").slice(0, 32);

export function exportAllowed(key, hex, file, sig) {
  return !key || sameSecret(sig, exportSignature(key, hex, file));
}
