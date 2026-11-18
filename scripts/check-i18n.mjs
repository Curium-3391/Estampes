#!/usr/bin/env node
// i18n Phase 0 check (docs/rfc/i18n/README.md §8.2): reports user-visible text
// that is hard-coded in code instead of coming from a message catalog.
// Run it with `npm run i18n:check`. No server, browser or network needed.
//
// Warn mode (default): prints findings and a per-file count, exits 0.
// `--strict`: exits 1 when anything is found (turned on once Phase 1
// extraction is done). `--json`: machine-readable counts per file.
//
// What it flags today: CJK text in code that is not a comment, and a
// hard-coded <html lang>. A line ending in `i18n-ignore` is skipped (for
// deliberate cases such as demo SVG content or a list of hedge words).
// Comments are skipped by a simple line heuristic, not a parser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

// Where user-facing text (classes T1, T2, T5 and module runtime text in the
// RFC) lives. Model-contract code (T3) is not scanned: it is English by rule
// and guarded by the planned golden test instead.
const ROOTS = ["public", "src", "server.js"];
const EXT = new Set([".js", ".mjs", ".html"]);
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿！-｠、-〿]/;
const HTML_LANG = /<html[^>]*\blang="[^"]+"/;

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

const findings = [];
const counts = {};
for (const f of ROOTS.flatMap((r) => files(r)).sort()) {
  const state = { block: false };
  fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
    if (isComment(line, state) || /i18n-ignore\s*(\*\/|-->)?\s*$/.test(line)) return;
    const kind = HTML_LANG.test(line) ? "html-lang" : CJK.test(line) ? "cjk" : null;
    if (!kind) return;
    counts[f] = (counts[f] ?? 0) + 1;
    findings.push({ file: f, line: i + 1, kind, text: line.trim().slice(0, 100) });
  });
}

const total = findings.length;
if (args.has("--json")) {
  console.log(JSON.stringify({ total, counts }, null, 2));
} else {
  if (args.has("--verbose")) for (const x of findings) console.log(`${x.file}:${x.line}: [${x.kind}] ${x.text}`);
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5) + "  " + f);
  console.log(total
    ? `i18n:check ${args.has("--strict") ? "FAILED" : "warning"}: ${total} line(s) with hard-coded user-visible text in ${Object.keys(counts).length} file(s). See docs/rfc/i18n/README.md §8. --verbose lists them.`
    : "i18n:check ok: no hard-coded user-visible text found.");
}
process.exit(args.has("--strict") && total ? 1 : 0);
