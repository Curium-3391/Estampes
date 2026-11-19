// i18n: the hard-coded-text check runs in warn mode (exit 0) by default and
// fails in --strict mode while hard-coded text remains. Phase 1 extraction is
// done, so the repository itself must pass --strict. See docs/rfc/i18n §8.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (...args) => spawnSync(process.execPath, ["scripts/check-i18n.mjs", ...args], { encoding: "utf8" });

test("i18n:check warns but does not fail by default", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /i18n:check (ok|warning)/);
});

test("i18n:check --json reports counts per file", () => {
  const r = run("--json");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(typeof out.total, "number");
  assert.equal(out.total, Object.values(out.counts).reduce((a, b) => a + b, 0));
});

test("i18n:check --strict fails exactly when something is found", () => {
  const total = JSON.parse(run("--json").stdout).total;
  assert.equal(run("--strict").status, total ? 1 : 0);
});

test("the repository has no hard-coded user-visible text (Phase 1 done, strict)", () => {
  const r = run("--strict", "--verbose");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /i18n:check ok/);
});

test("the English catalog has every key (Phase 2)", () => {
  const out = JSON.parse(run("--json").stdout);
  assert.deepEqual(out.catalogErrors, []);
  assert.equal(out.missing.en, 0);
});
