import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const classifier = fileURLToPath(new URL("../scripts/ci-tier.mjs", import.meta.url));

test("CI selects a tier from the complete PR diff and defaults to full", t => {
  const cwd = mkdtempSync(join(tmpdir(), "estampes-ci-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.invalid");
  git("config", "commit.gpgsign", "false");

  function file(path) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "fixture\n");
  }

  function commit() {
    git("add", "-A");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }

  const event = join(cwd, ".git", "event.json");
  function tier(base, head, eventName = "pull_request") {
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
    return execFileSync(process.execPath, [classifier], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().split(": ").at(-1);
  }

  file("src/persistence/old.js");
  const base = commit();
  file("docs/guide.md");
  const docs = commit();
  assert.equal(tier(base, docs), "docs");
  assert.equal(tier(base, docs, "merge_group"), "full");
  assert.equal(tier("0".repeat(40), docs), "full");
  assert.equal(tier(base, base), "full");

  file("src/image/register.js");
  const fast = commit();
  assert.equal(tier(base, fast), "fast");

  // The integrity change sorts after 300 changed docs files.
  for (let i = 0; i < 301; i++) file(`docs/page-${i}.md`);
  file("src/uva/change.js");
  assert.equal(tier(fast, commit()), "full");

  renameSync(join(cwd, "src/persistence/old.js"), join(cwd, "docs/old.md"));
  assert.equal(tier(git("rev-parse", "HEAD"), commit()), "full");

  const cases = [
    ["docs/rfc/unified-visual-architecture/evidence/fixture.md", "full"],
    ["docs/fixture.json", "full"],
    ["server.js", "full"],
    ["tests/helpers/widget-host.js", "full"],
    ["tests/uva-powerloss.test.js", "full"],
    ["tests/document-revisions.test.js", "full"],
    ["tests/canvas-save-rollback.test.js", "full"],
    ["public/visual-surface.html", "full"],
    ["public/workbench.js", "full"],
    ["public/module-view.js", "full"],
    ["public/flow-view.js", "full"],
    ["public/sandboxed-view.js", "full"],
    ["src/surface/widget-source.js", "full"],
    ["src/uva/README.md", "full"],
    [".github/workflows/pr-baseline.yml", "full"],
    ["public/calculator.js", "fast"],
    ["tests/upload-e2e.test.js", "fast"],
  ];
  for (const [path, expected] of cases) {
    const previous = git("rev-parse", "HEAD");
    file(path);
    assert.equal(tier(previous, commit()), expected, path);
  }
});

test("the required baseline checks successful quick and full results for the selected tier", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pr-baseline.yml", import.meta.url), "utf8");
  const baseline = workflow.slice(workflow.indexOf("\n  baseline:\n"));
  assert.match(baseline, /\n    name: baseline\n    needs: \[quick, full\]\n    if: always\(\)/);
  const run = baseline.split("        run: |\n")[1];
  assert.ok(run);

  const passing = new Set(["docs:success:skipped", "fast:success:skipped", "full:success:success"]);
  const results = ["success", "failure", "skipped", "cancelled", ""];
  for (const tier of ["docs", "fast", "full", "", "unknown"]) {
    for (const quick of results) {
      for (const full of results) {
        const key = `${tier}:${quick}:${full}`;
        const result = spawnSync("bash", ["-c", run], {
          encoding: "utf8",
          env: { ...process.env, TIER: tier, QUICK_RESULT: quick, FULL_RESULT: full },
        });
        assert.equal(result.status, passing.has(key) ? 0 : 1, result.error?.message ?? key);
      }
    }
  }
});

test("the full matrix covers each discovered Node test once and includes Legacy Store", t => {
  const workflow = readFileSync(new URL("../.github/workflows/pr-baseline.yml", import.meta.url), "utf8");
  const full = workflow.slice(workflow.indexOf("\n  full:\n"), workflow.indexOf("\n  baseline:\n"));
  assert.match(full, /\n    needs: quick\n    if: needs\.quick\.outputs\.tier == 'full'/);
  assert.match(full, /\n      fail-fast: false\n/);
  assert.match(full, /\n          suite: \$\{\{ matrix\.suite \}\}/);
  const suites = full.match(/\n        suite: \[(.+)\]/)[1].split(", ").map(value => value.replaceAll("'", ""));
  const shards = suites.filter(suite => suite !== "legacy");
  assert.deepEqual(suites.filter(suite => suite === "legacy"), ["legacy"]);
  assert.ok(shards.length > 1);
  assert.deepEqual(shards, shards.map((_, index) => `${index + 1}/${shards.length}`));

  const runner = fileURLToPath(new URL("../scripts/run-ci-tests.mjs", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "estampes-shards-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "nested", "test"), { recursive: true });
  const expected = Array.from({ length: shards.length * 2 }, (_, index) => `ci-discovery-${index}`);
  for (const name of expected) {
    writeFileSync(join(cwd, "nested", "test", `${name}.cjs`), `require("node:test")("${name}", () => {});\n`);
  }
  const env = { ...process.env, NODE_OPTIONS: "--test-reporter=tap" };
  delete env.NODE_TEST_CONTEXT;
  const actual = shards.flatMap(shard => {
    const output = execFileSync(process.execPath, [runner, "full", shard], {
      cwd, encoding: "utf8", env,
    });
    return Array.from(output.matchAll(/^ok \d+ - (ci-discovery-\d+)$/gm), match => match[1]);
  });
  assert.deepEqual(actual.sort(), expected.sort());
});
