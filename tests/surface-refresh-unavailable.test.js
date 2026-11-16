// A canvas that cannot be read during a refresh is "unavailable", not
// "deleted": its plot link must stay retryable (architecture review A08).
// Before, any read error marked the link removed for good.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotebooks } from "../src/cas/notebooks.js";
import { refreshLinks } from "../src/surface/refresh.js";

const CANVAS = "img:00000000000000aa";
async function notebookWithLink() {
  const notebooks = createNotebooks({ dir: join(await mkdtemp(join(tmpdir(), "estampes-refresh-")), "nb") });
  const nb = await notebooks.create();
  await notebooks.mutate(nb.id, {}, (d) => {
    d.cells.push({ id: "cell:000000000001", operation: "evaluate", input: { text: "x" }, params: {}, revision: 1,
      result: { resultId: "r1", status: "exact", exact: { plain: "x" } }, stale: false,
      links: [{ canvas: CANVAS, object: "o2", status: "stale" }] });
    return d;
  });
  return { notebooks, id: nb.id };
}
function fakeHost(ensure) {
  const runs = [];
  return { runs, canvases: { ensure }, router: { execute: async (call) => { runs.push(call); return { entry: null }; } } };
}
const linkOf = async (notebooks, id) => (await notebooks.get(id)).cells[0].links[0];

test("a canvas read error leaves the link stale and retryable; the next refresh redraws it", async () => {
  const { notebooks, id } = await notebookWithLink();
  const failing = fakeHost(async () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); });
  const first = await refreshLinks({ host: failing, notebooks, notebookId: id });
  assert.equal((await linkOf(notebooks, id)).status, "stale", "not marked removed");
  assert.match(first.failed[0].reason, /could not be read/);
  assert.equal(failing.runs.length, 0);
  const ok = fakeHost(async () => ({ imageId: CANVAS, objects: new Map([["o2", {}]]) }));
  const second = await refreshLinks({ host: ok, notebooks, notebookId: id });
  assert.deepEqual(second.updated.map((u) => u.object), ["o2"]);
  assert.equal(ok.runs[0].capability, "plot_result");
});

test("a canvas that was read and no longer has the plot marks the link removed", async () => {
  const { notebooks, id } = await notebookWithLink();
  const host = fakeHost(async () => ({ imageId: CANVAS, objects: new Map() }));
  const r = await refreshLinks({ host, notebooks, notebookId: id });
  assert.equal((await linkOf(notebooks, id)).status, "removed");
  assert.match(r.failed[0].reason, /was removed/);
  assert.equal(host.runs.length, 0);
});
