#!/usr/bin/env node
/**
 * Conservative pre-public Git history preflight. Read-only, dependency-free,
 * and deliberately redacts matched values. Scans added lines across reachable
 * commits in local Git refs (including content subsequently deleted).
 *
 * This is NOT an exhaustive secret scanner: generic passwords, binary files,
 * GitHub comments/issues, and dangling/unfetched refs may be missed. Use a
 * maintained tool and a manual review before changing repository visibility.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const patterns = [
  ["github-token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{25,})/],
  ["openai-token", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["aws-access-key-id", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["google-api-key", /AIza[0-9A-Za-z_-]{35}/],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{15,}/],
  ["private-key-header", /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
];
const sensitivePath = (path) =>
  /(?:^|\/)\.env(?:\.[^/]*)?$/i.test(path) && !/(?:^|\/)\.env\.example$/i.test(path) ||
  /(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json|service-account\.json)$/i.test(path) ||
  /\.(?:pem|p12|pfx)$/i.test(path);

const git = spawn("git", [
  "log", "--all", "--full-history", "-m", "--no-ext-diff", "--no-textconv",
  "--no-renames", "--unified=0", "--format=ESTAMPES_COMMIT:%H", "--patch"
], { stdio: ["ignore", "pipe", "pipe"] });

const findings = new Set();
let commit = "unknown";
let path = "";
let observedCommits = new Set();
let stderr = "";
git.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

for await (const line of createInterface({ input: git.stdout, crlfDelay: Infinity })) {
  if (line.startsWith("ESTAMPES_COMMIT:")) {
    commit = line.slice("ESTAMPES_COMMIT:".length).trim();
    observedCommits.add(commit);
    path = "";
    continue;
  }
  if (line.startsWith("diff --git ")) { path = ""; continue; }
  if (line.startsWith("+++ b/")) {
    path = line.slice(6);
    if (sensitivePath(path)) findings.add(`sensitive-filename | ${commit.slice(0, 12)} | ${path}`);
    continue;
  }
  if (!path || !line.startsWith("+") || line.startsWith("+++")) continue;
  const added = line.slice(1);
  for (const [rule, pattern] of patterns) {
    if (pattern.test(added)) findings.add(`${rule} | ${commit.slice(0, 12)} | ${path}`);
  }
}

const code = await new Promise((resolve) => git.on("close", resolve));
if (code !== 0) {
  console.error("Git history scan could not complete:", stderr.slice(0, 400));
  process.exit(2);
}

console.log(`Checked added text lines in ${observedCommits.size} reachable commit(s).`);
if (findings.size) {
  console.error(`Potential sensitive content: ${findings.size} finding(s). Values are never printed.`);
  for (const finding of [...findings].sort().slice(0, 100)) console.error("  " + finding);
  if (findings.size > 100) console.error(`  ... ${findings.size - 100} additional findings omitted`);
  console.error("Review privately; rotate exposed credentials. Do not publish until resolved.");
  process.exit(1);
}
console.log("No high-confidence pattern hits. This is NOT proof of secret-free history.");
