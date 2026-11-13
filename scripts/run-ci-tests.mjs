import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const tier = process.argv[2];
if (tier !== "fast" && tier !== "full") {
  console.error("Usage: node scripts/run-ci-tests.mjs fast|full");
  process.exit(2);
}

function test(files, env = process.env) {
  const result = spawnSync(process.execPath, ["--test", ...files], { env, stdio: "inherit" });
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
} else {
  test([]);
  test([
    "claims-mcp", "workspace-mcp", "gesture-mcp", "bundle-mcp",
    "geometry-tools", "derived-view", "upload-e2e", "cards-e2e", "surface",
  ].map(name => `tests/${name}.test.js`), { ...process.env, ESTAMPES_CANVAS_STORE: "legacy" });
}
