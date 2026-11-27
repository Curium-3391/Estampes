// What a module may do. A module asks for permissions in its manifest;
// the instance owner grants them when enabling it. The router checks the
// grant on every call, so a module can never do more than was approved,
// and an update that asks for more must be approved again.
import { t } from "../i18n/index.js";
// Descriptions come from the catalogs; zh and en stay as fields because the
// Store and get_module_capabilities read them (Phase 2 picks one by locale).
export const PERMISSIONS = Object.freeze({
  "canvas.read": { risk: "low", zh: t("perm.canvasRead", undefined, "zh-TW"), en: t("perm.canvasRead", undefined, "en") },
  "canvas.write": { risk: "low", zh: t("perm.canvasWrite", undefined, "zh-TW"), en: t("perm.canvasWrite", undefined, "en") },
  "workspace.write": { risk: "low", zh: t("perm.workspaceWrite", undefined, "zh-TW"), en: t("perm.workspaceWrite", undefined, "en") },
  "asset.read.selected": { risk: "medium", zh: t("perm.assetReadSelected", undefined, "zh-TW"), en: t("perm.assetReadSelected", undefined, "en") },
  "module.storage.write": { risk: "medium", zh: t("perm.moduleStorageWrite", undefined, "zh-TW"), en: t("perm.moduleStorageWrite", undefined, "en") },
  "cas.compute": { risk: "medium", zh: t("perm.casCompute", undefined, "zh-TW"), en: t("perm.casCompute", undefined, "en") },
  "network.request.approved": { risk: "high", zh: t("perm.networkRequestApproved", undefined, "zh-TW"), en: t("perm.networkRequestApproved", undefined, "en") },
  "ui.sandboxed-frame": { risk: "high", zh: t("perm.uiSandboxedFrame", undefined, "zh-TW"), en: t("perm.uiSandboxedFrame", undefined, "en") },
  "module.secrets": { risk: "high", zh: t("perm.moduleSecrets", undefined, "zh-TW"), en: t("perm.moduleSecrets", undefined, "en") },
});
export const PERMISSION_NAMES = Object.keys(PERMISSIONS);
const RANK = { low: 0, medium: 1, high: 2 };

export const riskOf = (perms) => perms.reduce((r, p) => (RANK[PERMISSIONS[p]?.risk ?? "high"] > RANK[r] ? PERMISSIONS[p]?.risk ?? "high" : r), "low");

// Added and removed permissions between what is granted and what is asked.
export function permissionDiff(granted = [], requested = []) {
  const g = new Set(granted), r = new Set(requested);
  const added = requested.filter((p) => !g.has(p)), removed = granted.filter((p) => !r.has(p));
  return { added, removed, unchanged: requested.filter((p) => g.has(p)), risk: riskOf(added) };
}

export const describePermission = (p) => ({ id: p, ...(PERMISSIONS[p] ?? { risk: "high", zh: t("perm.unknown", undefined, "zh-TW"), en: t("perm.unknown", undefined, "en") }) });

// A capability may need less than its module; it can never need more.
export function capabilityPermissions(manifest, capability) {
  return capability.permissions ?? manifest.permissions;
}

export function missingPermissions(granted, needed) {
  const g = new Set(granted);
  return needed.filter((p) => !g.has(p));
}
