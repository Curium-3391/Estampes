// UVA Phase 4A-4: a new blank canvas is a Graph document by default, when the
// canvas store is on. ESTAMPES_NEW_CANVAS=image keeps the blank-image path.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack } from "./helpers/widget-host.js";

const idOf = (r) => (JSON.stringify(r.structuredContent).match(/(img|gph):[0-9a-f]{16}/) ?? [])[0];
const make = (s, newCanvas) => s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas });

test("a new canvas is a Graph by default; kind image or a background gives an image", { timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    await s.enable(["org.estampes.graph"]);
    assert.match(idOf(await make(s, {})), /^gph:/, "default is a Graph");
    const bare = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" } });
    assert.match(idOf(bare), /^gph:/, "no canvas and no newCanvas: a new Graph too");
    assert.match(idOf(await make(s, { kind: "image" })), /^img:/);
    assert.match(idOf(await make(s, { background: "paper" })), /^img:/, "a background preset is for an image");
    assert.match(idOf(await make(s, { kind: "graph", color: "#102030" })), /^gph:/);
  } finally { await s.close(); }
});

test("ESTAMPES_NEW_CANVAS=image keeps new canvases as blank images", { timeout: 120000 }, async () => {
  const s = await startStack({ cas: false, env: { ESTAMPES_NEW_CANVAS: "image" } });
  try {
    await s.enable(["org.estampes.graph"]);
    assert.match(idOf(await make(s, {})), /^img:/);
    assert.match(idOf(await make(s, { kind: "graph" })), /^gph:/, "an explicit Graph is still a Graph");
  } finally { await s.close(); }
});

test("without the canvas store a new canvas is a blank image", { timeout: 120000 }, async () => {
  const s = await startStack({ cas: false, env: { ESTAMPES_CANVAS_STORE: "legacy" } });
  try {
    await s.enable(["org.estampes.graph"]);
    assert.match(idOf(await make(s, {})), /^img:/);
  } finally { await s.close(); }
});
