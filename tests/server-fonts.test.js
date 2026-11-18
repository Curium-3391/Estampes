// Server-side text rendering needs a font. With none, sharp draws every
// character as the same box, so labels in render_canvas and PNG exports are
// unreadable. scripts/check-fonts.mjs detects that; the Docker build runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeSample } from "../scripts/check-fonts.mjs";

const run = (env = {}, args = []) => spawnSync(process.execPath, ["scripts/check-fonts.mjs", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

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

test("--require cjk fails when only a Latin font is available", () => {
  const dejavu = "/usr/share/fonts/truetype/dejavu";
  if (!fs.existsSync(dejavu)) return; // the negative case needs DejaVu alone; skip where it is not installed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estampes-latinonly-"));
  const conf = path.join(dir, "fonts.conf");
  fs.writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${dejavu}</dir><cachedir>${dir}/cache</cachedir></fontconfig>`);
  assert.equal(run({ FONTCONFIG_FILE: conf }).status, 0, "Latin alone passes");
  const r = run({ FONTCONFIG_FILE: conf }, ["--require", "cjk"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /cjk/);
});

// With no font, librsvg draws a string as boxes or, at random, as nothing, and
// two boxed renders can differ in light anti-aliasing. Either let the no-font
// check pass about one run in six; any blank render now fails and boxes are
// compared as black-and-white masks.
test("a blank render beside a boxed one is no font, not two different glyphs", () => {
  const blank = Buffer.alloc(64, 255), boxes = Buffer.alloc(64, 255).fill(0, 8, 24), other = Buffer.alloc(64, 255).fill(0, 30, 50);
  assert.equal(judgeSample("latin", boxes, blank).ok, false);
  assert.equal(judgeSample("latin", blank, boxes).ok, false);
  assert.equal(judgeSample("latin", blank, blank).ok, false);
  assert.equal(judgeSample("latin", boxes, boxes).ok, false);
  const greyer = Buffer.from(boxes); greyer[40] = 230; greyer[2] = 240;
  assert.equal(judgeSample("latin", boxes, greyer).ok, false, "boxes that differ only in light anti-aliasing are still boxes");
  assert.equal(judgeSample("latin", boxes, other).ok, true, "two different inked renders are text");
});

test("the check fails with no font on every run, not most runs", () => {
  for (let i = 0; i < 8; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estampes-nofonts-"));
    const conf = path.join(dir, "fonts.conf");
    fs.writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><cachedir>${dir}/cache</cachedir></fontconfig>`);
    const r = run({ FONTCONFIG_FILE: conf });
    assert.equal(r.status, 1, "run " + i + ": " + r.stdout + r.stderr);
  }
});
