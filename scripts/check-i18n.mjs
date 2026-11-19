#!/usr/bin/env node
// i18n Phase 0 check (docs/rfc/i18n/README.md §8.2): reports user-visible text
// that is hard-coded in code instead of coming from a message catalog.
// Run it with `npm run i18n:check`. No server, browser or network needed.
//
// Warn mode (default): prints findings and a per-file count, exits 0.
// `--strict`: exits 1 when anything is found. Phase 1 extraction is done,
// so CI and tests/i18n-check.test.js run it strict. `--json`: machine-readable counts per file.
//
// What it flags today: CJK text in code that is not a comment, and a
// hard-coded <html lang>. A line ending in `i18n-ignore` is skipped (for
// deliberate cases such as demo SVG content or a list of hedge words), and so
// is every line between a line containing `i18n-ignore-start` and one
// containing `i18n-ignore-end` (for a whole block, such as user-voice text
// sent to the AI that a later phase splits; say why on the start line).
// Comments are skipped by a simple line heuristic, not a parser.
//
// Text in a built-in module (src/builtin-modules/) is module-owned: it is
// localized through the module's own locales/ in module system v2 (RFC §6.3,
// P5), so it is listed as deferred and never fails --strict.
//
// Catalog checks (src/i18n/locales/*.json, Phase 1 on) always fail, in
// every mode: a message that does not parse, a key outside zh-TW (the
// complete catalog), a translation whose parameters differ from zh-TW, and a
// t("literal.key") or data-i18n="key" in code that no catalog has. Keys zh-TW has and en lacks
// are only counted until Phase 2 fills en.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messageParams } from "../src/i18n/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

// Where user-facing text (classes T1, T2, T5 and module runtime text in the
// RFC) lives. Model-contract code (T3) is not scanned: it is English by rule
// and guarded by the planned golden test instead.
const ROOTS = ["public", "src", "server.js"];
const EXT = new Set([".js", ".mjs", ".html"]);
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿！-｠、-〿]/;
const HTML_LANG = /<html[^>]*\blang="(?!__ESTAMPES_LANG__")[^"]+"/;

function files(rel, out = []) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isFile()) { if (EXT.has(path.extname(rel))) out.push(rel); return out; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    files(path.join(rel, e.name), out);
  }
  return out;
}

function isComment(line, state) {
  const t = line.trim();
  if (state.block) { if (t.includes("*/")) state.block = false; return true; }
  if (t.startsWith("/*") || t.startsWith("<!--")) { if (!t.includes("*/") && !t.includes("-->")) state.block = true; return true; }
  return t.startsWith("//") || t.startsWith("*");
}

const MODULE_OWNED = "src/builtin-modules/";
const findings = [];
const deferred = {};
const counts = {};
for (const f of ROOTS.flatMap((r) => files(r)).sort()) {
  const state = { block: false, ignore: false };
  fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
    if (line.includes("i18n-ignore-start")) { state.ignore = true; return; }
    if (line.includes("i18n-ignore-end")) { state.ignore = false; return; }
    if (state.ignore) return;
    if (isComment(line, state) || /i18n-ignore\s*(\*\/|-->)?\s*$/.test(line)) return;
    const kind = HTML_LANG.test(line) ? "html-lang" : CJK.test(line) ? "cjk" : null;
    if (!kind) return;
    if (f.startsWith(MODULE_OWNED)) { deferred[f] = (deferred[f] ?? 0) + 1; return; }
    counts[f] = (counts[f] ?? 0) + 1;
    findings.push({ file: f, line: i + 1, kind, text: line.trim().slice(0, 100) });
  });
}

// Catalogs.
const LOCALES = path.join(ROOT, "src", "i18n", "locales");
const catalogErrors = [];
const catalogs = Object.fromEntries(fs.readdirSync(LOCALES).filter((f) => f.endsWith(".json")).sort()
  .map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(LOCALES, f), "utf8"))]));
const BASE = "zh-TW";
const params = {};
for (const [loc, cat] of Object.entries(catalogs)) {
  params[loc] = {};
  for (const [k, v] of Object.entries(cat)) {
    if (typeof v !== "string") { catalogErrors.push(`${loc}: ${k} is not a string`); continue; }
    try { params[loc][k] = messageParams(v); } catch (e) { catalogErrors.push(`${loc}: ${k}: ${e.message}`); }
  }
}
const sig = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
for (const loc of Object.keys(catalogs)) {
  if (loc === BASE) continue;
  for (const k of Object.keys(catalogs[loc])) {
    if (!(k in catalogs[BASE])) catalogErrors.push(`${loc}: ${k} is not in ${BASE}`);
    else if (k in params[loc] && k in params[BASE] && sig(params[loc][k]) !== sig(params[BASE][k])) catalogErrors.push(`${loc}: ${k} has parameters ${sig(params[loc][k])}, ${BASE} has ${sig(params[BASE][k])}`);
  }
}
const MARKUP_KEY = /\bdata-i18n(?:-[a-z-]+)?="([^"]+)"/g;
const KEY_USE = /\b(?:t|i18nT)\(\s*["']([a-z][\w.-]*)["']\s*[,)]/g;
for (const f of ROOTS.flatMap((r) => files(r)).sort()) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of [...src.matchAll(KEY_USE), ...(f.endsWith(".html") ? src.matchAll(MARKUP_KEY) : [])]) {
    if (!(m[1] in catalogs[BASE])) catalogErrors.push(`${f}: t("${m[1]}") is not in ${BASE}`);
  }
}
const missing = Object.fromEntries(Object.keys(catalogs).filter((l) => l !== BASE)
  .map((l) => [l, Object.keys(catalogs[BASE]).filter((k) => !(k in catalogs[l])).length]));

const total = findings.length;
if (args.has("--json")) {
  console.log(JSON.stringify({ total, counts, deferred, catalogErrors, keys: Object.keys(catalogs[BASE]).length, missing }, null, 2));
} else {
  if (args.has("--verbose")) for (const x of findings) console.log(`${x.file}:${x.line}: [${x.kind}] ${x.text}`);
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5) + "  " + f);
  console.log(total
    ? `i18n:check ${args.has("--strict") ? "FAILED" : "warning"}: ${total} line(s) with hard-coded user-visible text in ${Object.keys(counts).length} file(s). See docs/rfc/i18n/README.md §8. --verbose lists them.`
    : "i18n:check ok: no hard-coded user-visible text found.");
  const d = Object.values(deferred).reduce((a, b) => a + b, 0);
  if (d) console.log(`deferred: ${d} line(s) of module-owned text in ${Object.keys(deferred).join(", ")} (module locales/, RFC §6.3).`);
  console.log(`catalogs: ${Object.keys(catalogs[BASE]).length} key(s) in ${BASE}; ` +
    Object.entries(missing).map(([l, n]) => `${l} lacks ${n}`).join(", ") + ".");
  for (const e of catalogErrors) console.error("catalog error: " + e);
}
process.exit(catalogErrors.length || (args.has("--strict") && total) ? 1 : 0);
