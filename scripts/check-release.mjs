#!/usr/bin/env node
// Pre-release check. Needs no network, Docker or push:
//   node scripts/check-release.mjs [vX.Y.Z]
// Without an argument it checks that the working tree is ready to release the
// version in package.json. With a tag (the release workflow passes
// $GITHUB_REF_NAME) it also checks that the tag names that version.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const problems = [];
const bad = (msg) => problems.push(msg);

const version = JSON.parse(read("package.json")).version;
const tag = process.argv[2];
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
if (!semver.test(version)) bad(`package.json version "${version}" is not X.Y.Z`);

const lock = JSON.parse(read("package-lock.json"));
if (lock.version !== version) bad(`package-lock.json version is ${lock.version}, package.json is ${version} (run npm install)`);
if (lock.packages?.[""]?.version !== version) bad(`package-lock.json packages[""] version is ${lock.packages?.[""]?.version}, expected ${version}`);

if (tag !== undefined && tag !== `v${version}`) bad(`tag "${tag}" does not match package.json version (expected v${version})`);

const headings = [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/gm)].map((m) => m[1]);
if (headings[0] !== version) bad(`CHANGELOG.md: the newest "## X.Y.Z" heading is ${headings[0] ?? "missing"}, expected ${version}`);
const uriTag = (v) => "v" + v.replace(/\./g, "");
const server = read("server.js");
const list = (name) => {
  const m = server.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  return m ? m[1].match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)) ?? [] : null;
};
for (const name of ["LEGACY_VISUAL_URIS", "LEGACY_EVIDENCE_URIS"]) {
  const uris = list(name);
  if (!uris) { bad(`server.js: ${name} not found`); continue; }
  if (uris.includes(uriTag(version))) bad(`server.js: ${name} already lists ${uriTag(version)}, the current version`);
  const previous = headings[1];
  if (previous && !uris.includes(uriTag(previous))) {
    bad(`server.js: ${name} is missing ${uriTag(previous)} (the previous release ${previous}); saved conversations would stop resolving`);
  }
}

const wf = read(".github/workflows/docker.yml");
if (!/^on:\s*\n\s+push:\s*\n\s+tags:\s*\['v\*'\]/m.test(wf)) bad("docker.yml must trigger only on pushed v* tags");
if (/pull_request|branches:/.test(wf.split(/^jobs:/m)[0])) bad("docker.yml must not trigger on pull requests or branches");
if (/is_default_branch/.test(wf)) bad("docker.yml still uses is_default_branch, which is never true for a tag push");

if (problems.length) {
  console.error(`Release check failed for ${version}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const stable = !version.includes("-");
const owner = "<owner>";
console.log(`Release ${version} looks consistent.`);
console.log(`Pushing tag v${version} would publish ghcr.io/${owner}/estampes: ${[version, stable ? "latest" : null, "sha-<short>"].filter(Boolean).join(", ")}`);
