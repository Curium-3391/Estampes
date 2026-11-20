// Capability search (issue #244, L0): a bounded, deterministic keyword search
// over the installed modules' capabilities, so a model can find what it needs
// without reading the whole catalog. It reads manifests only; it never runs
// anything and never changes what execute_module allows.
//
// Module-authored text (names, titles, descriptions) is untrusted data: it is
// stripped of control characters, cut to a fixed length and returned only in
// data fields.
import { createHash } from "node:crypto";
import { localized } from "./manifest.js";
import { capabilityPermissions, riskOf } from "./permissions.js";

export const SEARCH_DEFAULTS = { limit: 10, maxLimit: 25, maxBytes: 16 * 1024, summaryChars: 120, titleChars: 60 };

const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => { const c = [...clean(s)]; return c.length > n ? { text: c.slice(0, n - 1).join("") + "…", truncated: true } : { text: c.join(""), truncated: false }; };

// Words are runs of letters or digits; CJK text has no spaces, so every
// character and every adjacent pair of characters counts as a word.
export function tokens(text) {
  const out = [];
  for (const run of clean(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;
    const cjk = [...run].filter((ch) => /[㐀-鿿豈-﫿぀-ヿ가-힯]/u.test(ch)); // character ranges for word splitting, not user-visible text. i18n-ignore
    if (cjk.length === [...run].length && cjk.length) {
      const chars = [...run];
      out.push(...chars);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
    } else out.push(run);
  }
  return out;
}

const stable = (v) => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v ?? null);
const sha = (s) => createHash("sha256").update(s).digest("hex");

// The hash of what a caller must send and may get: it changes whenever the
// input schema, target or permissions of the capability change.
export function schemaHash(manifest, cap) {
  return sha(stable({ input: cap.inputSchema, target: manifest.v2?.targets[cap.id] ?? cap.target, permissions: capabilityPermissions(manifest, cap) })).slice(0, 16);
}

export function buildIndex(mods, lang = "zh-TW") {
  const docs = [];
  for (const mod of mods) {
    const m = mod.manifest;
    for (const c of m.capabilities) {
      const title = localized(c, "title", lang) ?? c.id;
      const fields = {
        id: tokens(m.id + " " + c.id.replace(/_/g, " ")), title: tokens(title), module: tokens(localized(m, "name", lang) ?? ""),
        category: tokens(m.category ?? ""), description: tokens((c.description ?? "") + " " + (localized(m, "description", lang) ?? "")),
      };
      docs.push({ mod, cap: c, title, fields });
    }
  }
  const df = new Map();
  for (const d of docs) for (const t of new Set(Object.values(d.fields).flat())) df.set(t, (df.get(t) ?? 0) + 1);
  const fingerprint = sha(mods.map((x) => [x.manifest.id, x.manifest.version, x.record.state, (x.record.granted ?? []).join(",")].join("|")).sort().join("\n") + "\n" + lang).slice(0, 12);
  return { docs, df, n: docs.length, fingerprint };
}

const WEIGHT = { id: 6, title: 5, module: 3, category: 2, description: 1 };

function score(index, doc, words, query) {
  const q = clean(query).toLowerCase();
  let s = 0;
  const full = (doc.mod.manifest.id + "/" + doc.cap.id).toLowerCase();
  if (q && (q === doc.cap.id.toLowerCase() || q === full)) s += 100;
  else if (q && (full.includes(q) || clean(doc.title).toLowerCase() === q)) s += 40;
  for (const w of words) {
    const idf = Math.log(1 + (index.n - (index.df.get(w) ?? 0) + 0.5) / ((index.df.get(w) ?? 0) + 0.5));
    for (const [field, list] of Object.entries(doc.fields)) {
      const tf = list.filter((t) => t === w).length;
      if (tf) s += WEIGHT[field] * idf * (tf / (tf + 1.2));
    }
  }
  return s;
}

function encodeCursor(offset, fp, key) { return Buffer.from(offset + "." + fp + "." + key).toString("base64url"); }
function decodeCursor(c) {
  try { const [o, fp, key] = Buffer.from(c, "base64url").toString("utf8").split("."); const offset = Number(o); if (Number.isInteger(offset) && offset >= 0 && fp && key) return { offset, fp, key }; } catch { /* below */ }
  return null;
}

export class SearchError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

// One result row: a fixed, small shape.
function row(doc, score, lang) {
  const { mod, cap } = doc, m = mod.manifest;
  const summary = cut(cap.description || localized(m, "description", lang), SEARCH_DEFAULTS.summaryChars);
  const title = cut(doc.title, SEARCH_DEFAULTS.titleChars);
  return {
    module: m.id, capability: cap.id, title: title.text, summary: summary.text, ...(summary.truncated ? { summaryTruncated: true } : {}),
    category: m.category, state: mod.record.state, enabled: mod.record.state === "enabled",
    target: m.v2?.targets[cap.id] ?? cap.target, risk: riskOf(capabilityPermissions(m, cap)),
    leavesServer: !!cap.profile?.dataFlow?.leavesServer, ...(cap.async ? { async: true } : {}),
    schemaHash: schemaHash(m, cap), score: Math.round(score * 100) / 100,
  };
}

// search(index, { query, category, state, limit, cursor, maxBytes }) -> a page.
// total counts every match; returned is this page; complete says whether
// this page ends the list. A page that is cut by the byte budget says so.
export function searchCapabilities(index, { query = "", category, state = "enabled", limit = SEARCH_DEFAULTS.limit, cursor, maxBytes = SEARCH_DEFAULTS.maxBytes, lang = "zh-TW" } = {}) {
  const cap = Math.min(Math.max(1, Math.floor(limit) || SEARCH_DEFAULTS.limit), SEARCH_DEFAULTS.maxLimit);
  const key = sha(JSON.stringify([clean(query).toLowerCase(), category ?? "", state])).slice(0, 8);
  let offset = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) throw new SearchError("this cursor is not valid; search again without one", "cursor");
    if (c.fp !== index.fingerprint) throw new SearchError("the module catalog changed since that page was made; search again from the start", "stale-cursor");
    if (c.key !== key) throw new SearchError("this cursor belongs to a different query, category or state; search again without it", "cursor");
    offset = c.offset;
  }
  const words = [...new Set(tokens(query))];
  const matches = [];
  for (const doc of index.docs) {
    if (state === "enabled" && doc.mod.record.state !== "enabled") continue;
    if (category && doc.mod.manifest.category !== category) continue;
    if (!words.length) { matches.push({ doc, s: 0 }); continue; }
    const s = score(index, doc, words, query);
    if (s > 0) matches.push({ doc, s });
  }
  matches.sort((a, b) => b.s - a.s || a.doc.mod.manifest.id.localeCompare(b.doc.mod.manifest.id) || a.doc.cap.id.localeCompare(b.doc.cap.id));
  const total = matches.length;
  const rows = [];
  let bytes = 0, byBudget = false;
  for (const { doc, s } of matches.slice(offset, offset + cap)) {
    const r = row(doc, s, lang);
    const size = Buffer.byteLength(JSON.stringify(r));
    if (rows.length && bytes + size > maxBytes) { byBudget = true; break; }
    rows.push(r); bytes += size;
  }
  const next = offset + rows.length;
  const complete = next >= total;
  return {
    query: clean(query), state, ...(category ? { category } : {}), total, returned: rows.length, offset, complete,
    ...(complete ? {} : { nextCursor: encodeCursor(next, index.fingerprint, key) }),
    ...(byBudget ? { truncatedByBudget: true } : {}), results: rows,
    ...(total === 0 ? { hint: state === "enabled" ? "no enabled capability matched; try other words, or state \"any\" to include modules that are not enabled yet" : "no capability matched; try other words, or list_modules for a compact catalog" } : {}),
  };
}

// A compact module list (issue #244, L0 listing): one small row per module,
// bounded and paged the same way as search_capabilities. Ordered by id.
export function compactModules(mods, { state = "any", limit = SEARCH_DEFAULTS.limit, cursor, maxBytes = SEARCH_DEFAULTS.maxBytes, lang = "zh-TW" } = {}) {
  const cap = Math.min(Math.max(1, Math.floor(limit) || SEARCH_DEFAULTS.limit), SEARCH_DEFAULTS.maxLimit);
  const list = mods.filter((m) => state === "any" || m.record.state === "enabled").sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const fingerprint = sha(mods.map((x) => [x.manifest.id, x.manifest.version, x.record.state].join("|")).sort().join("\n") + "\n" + lang).slice(0, 12);
  const key = sha("list|" + state).slice(0, 8);
  let offset = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) throw new SearchError("this cursor is not valid; list again without one", "cursor");
    if (c.fp !== fingerprint) throw new SearchError("the module catalog changed since that page was made; list again from the start", "stale-cursor");
    if (c.key !== key) throw new SearchError("this cursor belongs to a different state filter; list again without it", "cursor");
    offset = c.offset;
  }
  const rows = [];
  let bytes = 0, byBudget = false;
  for (const mod of list.slice(offset, offset + cap)) {
    const m = mod.manifest;
    const r = { id: m.id, name: cut(localized(m, "name", lang) ?? m.id, SEARCH_DEFAULTS.titleChars).text, version: m.version, state: mod.record.state, category: m.category,
      capabilities: m.capabilities.map((c) => c.id) };
    const size = Buffer.byteLength(JSON.stringify(r));
    if (rows.length && bytes + size > maxBytes) { byBudget = true; break; }
    rows.push(r); bytes += size;
  }
  const next = offset + rows.length, complete = next >= list.length;
  return { state, total: list.length, returned: rows.length, offset, complete, ...(complete ? {} : { nextCursor: encodeCursor(next, fingerprint, key) }),
    ...(byBudget ? { truncatedByBudget: true } : {}), modules: rows };
}
