import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

  file("docs/rfc/unified-visual-architecture/evidence/fixture.json");
  assert.equal(tier(git("rev-parse", "HEAD"), commit()), "full");
});
