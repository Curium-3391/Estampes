// What a module may do. A module asks for permissions in its manifest;
// the instance owner grants them when enabling it. The router checks the
// grant on every call, so a module can never do more than was approved,
// and an update that asks for more must be approved again.
export const PERMISSIONS = Object.freeze({
  "canvas.read": { risk: "low", zh: "讀取目標畫布上的物件與標記摘要", en: "Read the objects and marks on the target canvas" },
  "canvas.write": { risk: "low", zh: "在目標畫布新增、修改自己建立的物件", en: "Add objects to the target canvas and change its own objects" },
  "workspace.write": { risk: "low", zh: "建立新的空白畫布", en: "Create new blank canvases" },
  "asset.read.selected": { risk: "medium", zh: "讀取目標圖片（或選定區域）的像素", en: "Read the pixels of the target image or selected region" },
  "module.storage.write": { risk: "medium", zh: "在伺服器保存自己的設定與資料", en: "Keep its own settings and data on the server" },
  "network.request.approved": { risk: "high", zh: "連線到清單上的外部網站（可能傳送圖片）", en: "Send requests to the listed external hosts (may upload images)" },
  "module.secrets": { risk: "high", zh: "使用管理員設定的 API 金鑰等密鑰（模組看不到原文）", en: "Use secrets such as API keys set by the administrator (never shown to the module)" },
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

export const describePermission = (p) => ({ id: p, ...(PERMISSIONS[p] ?? { risk: "high", zh: "未知權限", en: "Unknown permission" }) });

// A capability may need less than its module; it can never need more.
export function capabilityPermissions(manifest, capability) {
  return capability.permissions ?? manifest.permissions;
}

export function missingPermissions(granted, needed) {
  const g = new Set(granted);
  return needed.filter((p) => !g.has(p));
}
