// .estampes bundles carry the Visual Surface and its calculator notebooks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, noPython } from "./helpers/widget-host.js";
import { unzipFiles } from "../src/zip.js";
import { createNotebooks } from "../src/cas/notebooks.js";
import { createSurfaceStore } from "../src/surface/store.js";
import { installBundleExtras } from "../src/surface/bundle-extras.js";

test("export writes surface.json and notebooks; install rebuilds them under new ids, stale, without overwriting", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "image" } });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const opened = await s.call("surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }] });
    const nb = opened.structuredContent.panels.find((p) => p.kind === "calculator").notebook;
    const cas = (capability, params) => s.call("surface_cas", { imageId, capability, params: { notebook: nb, ...params } });
    await cas("define", { name: "f", params: ["x"], text: "2*x^2" });
    const calc = await cas("calculate", { operation: "differentiate", text: "f(x)", variable: "x" });
    const cellId = calc.structuredContent.data.cell.cellId;
    await cas("plot_result", { cell: cellId, domain: [-3, 3] });

    const made = await s.call("create_workspace", { canvases: [imageId] });
    assert.notEqual(made.isError, true, made.content?.[0]?.text);
    const exp = await s.call("export_workspace_bundle", { workspace: made.structuredContent.workspaceId });
    assert.notEqual(exp.isError, true, exp.content?.[0]?.text);
    const link = new URL(exp.structuredContent.downloadUrl);
    const res = await fetch("http://127.0.0.1:" + s.port + link.pathname + link.search);
    assert.equal(res.status, 200);
    const files = unzipFiles(Buffer.from(await res.arrayBuffer()));
    assert.ok(files.has("surface.json"), "surface.json is in the bundle");
    const surface = JSON.parse(files.get("surface.json").toString());
    assert.ok(surface.panels.some((p) => p.kind === "calculator"));
    const nbFile = [...files.keys()].find((n) => n.startsWith("notebooks/"));
    const raw = JSON.parse(files.get(nbFile).toString());
    assert.equal(raw.id, nb);
    assert.equal(raw.cells[0].result.exact.plain, "4*x");
    assert.equal(raw.idem, undefined);

    // Install into an empty server's stores, with canvas ids remapped.
    const dir = await mkdtemp(join(tmpdir(), "estampes-extras-"));
    const notebooks = createNotebooks({ dir: join(dir, "nb") }), surfaceStore = createSurfaceStore({ dir: join(dir, "sf") });
    const extras = { surface, notebooks: [{ id: raw.id, raw }], imageIds: { [imageId]: "img:aaaaaaaaaaaaaaaa" } };
    const out = await installBundleExtras({ surfaceStore, notebooks, workspaceId: "ws:0123456789abcdef", extras });
    assert.equal(out.notebooks, 1);
    assert.equal(out.surface, true);
    const doc = await surfaceStore.peek("ws:0123456789abcdef");
    const calcPanel = doc.panels.find((p) => p.kind === "calculator");
    assert.ok(calcPanel.notebook && calcPanel.notebook !== nb, "notebook has a new id");
    const imported = await notebooks.get(calcPanel.notebook);
    const cell = imported.cells[0];
    assert.equal(cell.stale, true, "imported results are stale until recomputed");
    assert.equal(cell.links[0].canvas, "img:aaaaaaaaaaaaaaaa");
    assert.equal(cell.links[0].cellRevision, 0, "an imported link counts as out of date");
    assert.ok(doc.layouts.desktop, "layouts came along");

    // Nothing is overwritten: a second install leaves the existing surface alone.
    const again = await installBundleExtras({ surfaceStore, notebooks, workspaceId: "ws:0123456789abcdef", extras });
    assert.equal(again.surface, false);
    assert.equal((await surfaceStore.peek("ws:0123456789abcdef")).panels.find((p) => p.kind === "calculator").notebook, calcPanel.notebook);

    // A hostile notebook is refused, not half-imported.
    const bad = await installBundleExtras({ surfaceStore, notebooks, workspaceId: "ws:fedcba9876543210", extras: { surface: null, notebooks: [{ id: "nb:x", raw: { schema: "nope" } }], imageIds: {} } });
    assert.equal(bad.notebooks, 0);
    assert.ok(bad.notes.length);
  } finally { await s.close(); }
});
