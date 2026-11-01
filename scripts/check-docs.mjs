#!/usr/bin/env node
// Documentation checks. No server, Docker, CAS or browser needed; run it with
// `npm run docs:check`. Every problem is printed as file:line, then a reason.
// Exit code 1 if anything is reported.
//
// What it checks (see docs/DOCUMENTATION-MAINTENANCE.md):
//   links      local links and #anchors resolve
//   headings   no duplicate heading in a file; no link target listed twice in one index section
//   tools      every registered MCP tool is documented in docs/TOOLS.md; tool-looking names in docs exist
//   env        ESTAMPES_* names in docs exist in code; those read by src/config.js are documented
//   version    package.json, lockfile and the newest CHANGELOG heading agree; image tags in docs
//   stale      phrases that were wrong once and must not come back
//   commands   fenced shell examples parse (bash -n) and name real scripts / npm scripts / subcommands
//
// docs/history/ is a record of past milestones: it is link-checked only.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const report = (file, line, check, msg) => problems.push({ file, line, check, msg });
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ---------- collect files ----------
function walk(dir, out, filter) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out, filter);
    else if (filter(rel)) out.push(rel);
  }
  return out;
}
const mdFiles = [
  ...fs.readdirSync(ROOT).filter((f) => f.endsWith(".md")),
  ...walk("docs", [], (f) => f.endsWith(".md")),
  ...walk("examples", [], (f) => f.endsWith(".md")),
  ...(exists("cas-service") ? walk("cas-service", [], (f) => f.endsWith(".md")) : []),
].sort();
const isHistory = (f) => f.startsWith("docs/history/");
const isCurrentDoc = (f) => !isHistory(f);

// ---------- parse markdown (fence aware) ----------
function parse(file) {
  const lines = read(file).split("\n");
  const headings = []; // {line, level, text, slug}
  const links = []; // {line, target}
  const fences = []; // {line, lang, body[]}
  const codeSpans = []; // {line, text}
  let fence = null;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const m = raw.match(/^\s*(```+|~~~+)\s*([\w-]*)/);
    if (m) {
      if (!fence) fence = { line: n, lang: m[2].toLowerCase(), body: [], mark: m[1][0] };
      else if (m[1][0] === fence.mark) { fences.push(fence); fence = null; }
      return;
    }
    if (fence) { fence.body.push(raw); return; }
    const h = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) headings.push({ line: n, level: h[1].length, text: h[2], slug: slugify(h[2]) });
    const noSpans = raw.replace(/`[^`]*`/g, (s) => { codeSpans.push({ line: n, text: s.slice(1, -1) }); return ""; });
    for (const l of noSpans.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push({ line: n, target: l[1] });
  });
  return { lines, headings, links, fences, codeSpans };
}

// GitHub's anchor rule: lowercase, drop punctuation except - and _, spaces to -.
function slugify(text) {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, (c) => (c === "_" ? "_" : ""));
  return plain.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}
function anchorsOf(parsed) {
  const seen = new Map();
  const set = new Set();
  for (const h of parsed.headings) {
    const k = seen.get(h.slug) ?? 0;
    seen.set(h.slug, k + 1);
    set.add(k === 0 ? h.slug : `${h.slug}-${k}`);
  }
  return set;
}

const parsed = new Map(mdFiles.map((f) => [f, parse(f)]));
const anchors = new Map(mdFiles.map((f) => [f, anchorsOf(parsed.get(f))]));

// ---------- links ----------
for (const f of mdFiles) {
  for (const { line, target } of parsed.get(f).links) {
    if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
    const [rawPath, rawAnchor] = target.split("#");
    const dest = rawPath ? path.posix.normalize(path.posix.join(path.posix.dirname(f), decodeURI(rawPath))) : f;
    if (dest.startsWith("..")) { report(f, line, "links", `link leaves the repository: ${target}`); continue; }
    if (!exists(dest)) { report(f, line, "links", `broken link: ${target} (no such file ${dest})`); continue; }
    if (rawAnchor && dest.endsWith(".md")) {
      const set = anchors.get(dest) ?? (parsed.set(dest, parse(dest)), anchors.set(dest, anchorsOf(parsed.get(dest))), anchors.get(dest));
      if (!set.has(decodeURIComponent(rawAnchor).toLowerCase())) report(f, line, "links", `broken anchor: ${target} (no heading "#${rawAnchor}" in ${dest})`);
    }
  }
}

// ---------- duplicate headings and index entries ----------
for (const f of mdFiles.filter(isCurrentDoc)) {
  if (f === "CHANGELOG.md") continue; // repeated "Added/Changed" style headings are fine there
  const p = parsed.get(f);
  const first = new Map();
  for (const h of p.headings) {
    const key = `${h.level}|${h.slug}`;
    if (first.has(key)) report(f, h.line, "headings", `duplicate heading "${h.text}" (first at line ${first.get(key)})`);
    else first.set(key, h.line);
  }
  // index rows: "| [x](a.md) |" or "- [x](a.md)" listed twice under the same heading.
  let section = "";
  const rows = new Map();
  p.lines.forEach((raw, i) => {
    const h = raw.match(/^#{1,6}\s+(.*)/);
    if (h) { section = h[1]; return; }
    if (!/^\s*(\||[-*]\s)/.test(raw)) return;
    const m = raw.match(/^\s*(?:\|\s*|[-*]\s+)\[[^\]]*\]\(([^)#\s]+\.md)\)/);
    if (!m) return;
    const key = `${section}|${m[1]}`;
    if (rows.has(key)) report(f, i + 1, "headings", `index entry ${m[1]} listed twice under "${section}" (first at line ${rows.get(key)})`);
    else rows.set(key, i + 1);
  });
}

// ---------- tools ----------
const toolSources = ["server.js", ...walk("src", [], (x) => x.endsWith(".js"))];
const registered = new Set();
for (const src of toolSources) {
  for (const m of read(src).matchAll(/register(?:App)?Tool\(\s*(?:server,\s*)?["'`]([a-z][a-z0-9_]*)["'`]/g)) registered.add(m[1]);
}
const toolsDoc = parsed.get("docs/TOOLS.md");
const toolsDocText = toolsDoc ? read("docs/TOOLS.md") : "";
for (const t of [...registered].sort()) {
  if (!new RegExp("`" + t + "`").test(toolsDocText)) report("docs/TOOLS.md", 1, "tools", `registered tool \`${t}\` is not documented (server code: ${toolSources.find((s) => read(s).includes(`"${t}"`)) ?? "?"})`);
}
// Names in backticks that look like tools: snake_case followed by "(" or listed in a TOOLS.md table first column.
const KNOWN_NON_TOOLS = new Set(JSON.parse(read("scripts/docs-allowlist.json")).nonTools);
for (const f of mdFiles.filter((x) => isCurrentDoc(x) && x !== "CHANGELOG.md")) {
  const p = parsed.get(f);
  const firstCell = (line, text) => f === "docs/TOOLS.md" && (p.lines[line - 1] ?? "").startsWith("| `" + text + "`");
  for (const { line, text } of p.codeSpans) {
    const name = text.match(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/)?.[1] ?? (firstCell(line, text) && text.match(/^[a-z][a-z0-9_]*$/)?.[0]);
    if (name && !registered.has(name) && !KNOWN_NON_TOOLS.has(name)) report(f, line, "tools", `\`${name}\` looks like a tool call but no such tool is registered (add to scripts/docs-allowlist.json "nonTools" if it is not a tool)`);
  }
}

// ---------- environment variables ----------
const envCodeFiles = [
  "server.js", "Dockerfile", "compose.yaml", ".env.example", "render.yaml", "app.json", "Procfile",
  ...walk("src", [], (x) => /\.(js|mjs)$/.test(x)),
  ...walk("scripts", [], (x) => /\.(js|mjs)$/.test(x) && !x.endsWith("check-docs.mjs")),
  ...walk("cas-service", [], (x) => /\.(py|txt|lock)$/.test(x) || x.endsWith("Dockerfile")),
  ...walk(".github", [], () => true),
].filter(exists);
const envInCode = new Set();
for (const f of envCodeFiles) for (const m of read(f).matchAll(/\bESTAMPES_[A-Z0-9_]+\b/g)) envInCode.add(m[0]);
const envAllow = new Set(JSON.parse(read("scripts/docs-allowlist.json")).envNames);
const envInDocs = new Map();
for (const f of mdFiles.filter(isCurrentDoc)) {
  parsed.get(f).lines.forEach((raw, i) => {
    for (const m of raw.matchAll(/\bESTAMPES_[A-Z0-9_]+\b/g)) {
      if (m[0].endsWith("_")) continue; // prefix such as ESTAMPES_MODULE_ in prose
      if (!envInDocs.has(m[0])) envInDocs.set(m[0], []);
      envInDocs.get(m[0]).push([f, i + 1]);
      if (!envInCode.has(m[0]) && !envAllow.has(m[0])) report(f, i + 1, "env", `${m[0]} is not used anywhere in the code`);
    }
  });
}
const configEnv = new Set([...read("src/config.js").matchAll(/\bESTAMPES_[A-Z0-9_]+\b/g)].map((m) => m[0]));
for (const e of [...configEnv].sort()) {
  if (!envInDocs.has(e)) report("src/config.js", 1, "env", `${e} is read by the server but documented nowhere (README, docs/DEPLOYMENT.md ...)`);
}

// ---------- versions ----------
const pkg = JSON.parse(read("package.json"));
const lock = exists("package-lock.json") ? JSON.parse(read("package-lock.json")) : null;
if (lock && (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version)) report("package-lock.json", 1, "version", `lockfile version ${lock.version}/${lock.packages?.[""]?.version} differs from package.json ${pkg.version}`);
{
  const cl = parsed.get("CHANGELOG.md").lines;
  const idx = cl.findIndex((l) => /^##\s+\[?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.test(l));
  const head = idx >= 0 ? cl[idx].match(/^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)[1] : null;
  if (head !== pkg.version) report("CHANGELOG.md", idx + 1 || 1, "version", `newest released heading is ${head}, package.json is ${pkg.version}`);
}
// Image tags: a concrete X.Y.Z tag of our own image must be the current version.
for (const f of mdFiles.filter(isCurrentDoc)) {
  if (f === "CHANGELOG.md") continue;
  parsed.get(f).lines.forEach((raw, i) => {
    for (const m of raw.matchAll(/ghcr\.io\/[\w.-]+\/estampes:v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.-])/gi)) {
      if (m[1] !== pkg.version && !raw.includes("docs:check-ignore")) report(f, i + 1, "version", `image tag ${m[1]} is not the current version ${pkg.version}`);
    }
  });
}

// ---------- stale statements ----------
const stale = JSON.parse(read("scripts/docs-allowlist.json")).stale;
for (const f of mdFiles.filter((x) => isCurrentDoc(x) && x !== "CHANGELOG.md")) {
  parsed.get(f).lines.forEach((raw, i) => {
    for (const s of stale) {
      if (new RegExp(s.pattern, "i").test(raw) && !(s.except ?? []).includes(f)) report(f, i + 1, "stale", `${s.reason} (/${s.pattern}/)`);
    }
  });
}

// ---------- example commands ----------
const npmScripts = new Set(Object.keys(pkg.scripts ?? {}));
const moduleCli = new Set([...read("scripts/estampes-module.js").matchAll(/cmd === "([a-z-]+)"/g)].map((m) => m[1]));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
for (const f of mdFiles.filter(isCurrentDoc)) {
  for (const fence of parsed.get(f).fences) {
    if (!["bash", "sh", "shell", "console"].includes(fence.lang)) continue;
    const body = fence.body.map((l) => l.replace(/^\s*\$ /, "")).join("\n");
    // Skip blocks that are templates (placeholders, ellipses) for the syntax check.
    const template = /<[a-zA-Z][^>\n]*>|\.\.\.|…/.test(body);
    if (hasBash && !template && fence.lang !== "console") {
      const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
      if (r.status !== 0) report(f, fence.line, "commands", `shell example does not parse: ${(r.stderr || "").trim().split("\n")[0]}`);
    }
    fence.body.forEach((raw, i) => {
      const line = fence.line + 1 + i;
      for (const m of raw.matchAll(/\bnpm run ([\w:.-]+)/g)) {
        if (!npmScripts.has(m[1]) && !raw.includes("docs:check-ignore")) report(f, line, "commands", `npm run ${m[1]}: no such script in package.json`);
      }
      for (const m of raw.matchAll(/\bnode\s+(scripts\/[\w./-]+|server\.js|examples\/[\w./-]+)/g)) {
        if (!exists(m[1])) report(f, line, "commands", `node ${m[1]}: no such file`);
      }
      const sub = raw.match(/estampes-module\.js\s+([a-z-]+)/);
      if (sub && !moduleCli.has(sub[1])) report(f, line, "commands", `estampes-module.js ${sub[1]}: no such subcommand (have ${[...moduleCli].join(", ")})`);
    });
  }
}

// ---------- output ----------
problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const p of problems) console.log(`${p.file}:${p.line}: [${p.check}] ${p.msg}`);
console.log(problems.length
  ? `\n${problems.length} documentation problem(s) in ${mdFiles.length} files.`
  : `docs:check ok (${mdFiles.length} markdown files, ${registered.size} tools, ${configEnv.size} config variables).`);
process.exit(problems.length ? 1 : 0);
