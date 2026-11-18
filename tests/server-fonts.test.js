// Server-side text rendering needs a font. With none, sharp draws every
// character as the same box, so labels in render_canvas and PNG exports are
// unreadable. scripts/check-fonts.mjs detects that; the Docker build runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (env = {}) => spawnSync(process.execPath, ["scripts/check-fonts.mjs"], { encoding: "utf8", env: { ...process.env, ...env } });

test("server-side text renders with the fonts on this machine", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the check fails when no font is available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estampes-nofonts-"));
  const conf = path.join(dir, "fonts.conf");
  fs.writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><cachedir>${dir}/cache</cachedir></fontconfig>`);
  const r = run({ FONTCONFIG_FILE: conf });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /fonts FAILED/);
});
