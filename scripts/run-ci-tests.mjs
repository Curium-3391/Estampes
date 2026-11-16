import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const [tier, suite, ...extra] = process.argv.slice(2);
const validSuite = suite === "legacy" || /^[1-9]\d*\/[1-9]\d*$/.test(suite ?? "");
if (!["fast", "full"].includes(tier) || extra.length || (suite !== undefined && (tier !== "full" || !validSuite))) {
  console.error("Usage: node scripts/run-ci-tests.mjs fast | full [index/total|legacy]");
  process.exit(2);
}

function test(args, env = process.env) {
  const result = spawnSync(process.execPath, ["--test", ...args], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (tier === "fast") {
  // Keep the ordinary UVA integration and targeted storage checks. Defer the
  // long fault matrices, scale tests and exhaustive crash recovery to full.
  const fullOnly = /^(?:persistence-(?:backup|capacity|filesystem-trust|gc-readoption|history-compaction|integrity-hardening|lifecycle(?:-faults)?|performance|reclaim|state-machine|temporary-attribution|verification-race)|pr1d-evidence-preservation|uva-powerloss)\.test\.js$/;
  const files = readdirSync("tests")
    .filter(file => file.endsWith(".test.js") && !fullOnly.test(file))
    .map(file => `tests/${file}`);
  test(files);
} else if (suite && suite !== "legacy") {
  test([`--test-shard=${suite}`]);
} else {
  if (!suite) test([]);
  test([
    "claims-mcp", "workspace-mcp", "gesture-mcp", "bundle-mcp",
    "geometry-tools", "derived-view", "upload-e2e", "cards-e2e", "surface",
  ].map(name => `tests/${name}.test.js`), { ...process.env, ESTAMPES_CANVAS_STORE: "legacy" });
}
