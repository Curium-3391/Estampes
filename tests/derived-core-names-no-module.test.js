// UVA 5B-2b-3c: the generic derived-binding code names no module and no object
// type. This is the acceptance test for "generality is a hard requirement":
// the calculator joined the contract without any line in these files knowing it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const FILES = ["src/documents/derived-binding.js", "src/documents/derived-coordinator.js", "src/documents/derived-index.js", "src/documents/derived-broadcast.js", "src/modules/derived-flow.js"];
// Module ids of this repository, and the names of what modules draw.
const FORBIDDEN = [/org\.estampes\./i, /\bcas\b/i, /\bsympy\b/i, /\bgraph\b/i, /function-plot/, /axes-2d/, /notebook/i, /calculator/i, /plot_result/, /refresh_plot/];

test("the generic derived-binding files name no module, capability or object type", async () => {
  for (const file of FILES) {
    // Comments may explain by example; only code is checked.
    const code = (await readFile(new URL("../" + file, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
    for (const re of FORBIDDEN) assert.ok(!re.test(code), file + " mentions " + re);
  }
});

test("the router's derived section names none either", async () => {
  const src = await readFile(new URL("../src/modules/router.js", import.meta.url), "utf8");
  const start = src.indexOf("// Derived objects and broadcasts"), end = src.indexOf("if (runtime.after)");
  assert.ok(start > 0 && end > start, "markers found");
  const code = src.slice(start, end).split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
  for (const re of FORBIDDEN) assert.ok(!re.test(code), "router derived section mentions " + re);
});
