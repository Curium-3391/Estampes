import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("layer rename re-renders the mounted panel, not detached rows", () => {
  const html = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  const rename = html.match(/if\(b\.dataset\.act==="rename"\)\{([^}]*)\}/);
  assert.ok(rename, "rename handler exists");
  assert.match(rename[1], /renamingLayer=id;\s*render\(\)/);
  assert.doesNotMatch(rename[1], /renderLayers\(\)/);
});
