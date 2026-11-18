// Administrator approval, separate from the connector's access key and from
// anything the chat can carry. The model, the widget and ChatGPT never see
// the admin key. The administrator approves a plan on the server itself:
//
//   node scripts/estampes-module.js approve <planId>
//
// (inside Docker, prefix it with: docker compose exec estampes)
//
// which writes a small file proving knowledge of <storage>/admin-key (or
// ESTAMPES_ADMIN_KEY). Committing a plan that needs administrator approval
// consumes that file once. Nothing typed in the chat can stand in for it.
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sameSecret } from "../security.js";

export const ADMIN_KEY_FILE = "admin-key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const APPROVAL_TTL_MS = 30 * 60 * 1000;
const PLAN_ID = /^plan_[A-Za-z0-9_-]{6,40}$/;

export const approvalMac = (key, planId) => createHmac("sha256", key).update("estampes-approve:" + planId).digest("base64url");
export const approvalsDir = (storageDir) => join(storageDir, "modules", "approvals");

// Reads the key, making one on first use when there is a storage folder.
export async function resolveAdminKey({ storageDir = "", configured = "" } = {}) {
  if (configured) {
    if (!KEY_PATTERN.test(configured)) throw new Error("ESTAMPES_ADMIN_KEY must be 32 to 256 letters, digits, - or _");
    return { key: configured, source: "env" };
  }
  if (!storageDir) return { key: "", source: "none" };
  const path = join(storageDir, ADMIN_KEY_FILE);
  try {
    const saved = (await readFile(path, "utf8")).trim();
    if (KEY_PATTERN.test(saved)) return { key: saved, source: "file", path };
  } catch {}
  const key = randomBytes(32).toString("base64url");
  await mkdir(storageDir, { recursive: true });
  await writeFile(path, key + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return { key, source: "generated", path };
}

// Used by the CLI on the server: record that the administrator approves
// this plan. The file holds only a MAC, never the key.
export async function writeApproval(storageDir, key, planId) {
  if (!PLAN_ID.test(planId)) throw new Error("not a plan id: " + planId);
  const dir = approvalsDir(storageDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, planId + ".json"), JSON.stringify({ planId, mac: approvalMac(key, planId), at: new Date().toISOString() }), { mode: 0o600 });
}

export function createAdmin({ storageDir = "", key = "", audit = null } = {}) {
  const failures = [];
  return {
    status: () => ({ configured: !!(key && storageDir), how: key && storageDir ? "cli" : "none" }),
    // proof is ignored on purpose: only the file on the server counts.
    async verify(_proof, planId) {
      if (!key || !storageDir || !PLAN_ID.test(planId)) return false;
      const file = join(approvalsDir(storageDir), planId + ".json");
      let data;
      try { data = JSON.parse(await readFile(file, "utf8")); } catch { return false; }
      const fresh = Date.now() - Date.parse(data?.at ?? "") < APPROVAL_TTL_MS;
      const ok = data?.planId === planId && typeof data.mac === "string" && sameSecret(data.mac, approvalMac(key, planId)) && fresh;
      await rm(file, { force: true });
      if (!ok) { failures.push(Date.now()); audit?.record({ kind: "admin.failed", planId, reason: fresh ? "bad approval" : "expired approval" }); return false; }
      return { via: "cli" };
    },
  };
}
