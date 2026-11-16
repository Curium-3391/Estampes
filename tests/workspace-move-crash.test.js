// A04: moving images between two workspaces is one change. If the server
// stops after acknowledging the move but before both workspaces are written,
// the next start finishes it: neither workspace is left with half of it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, rmdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startCanvasStoreServer } from "./helpers/canvas-store-server.js";

const pendingPath = (storage, id) => join(storage, "uva-pending", "records", "workspace-" + id.replace(":", "_") + ".json");
const intents = async (storage) => (await readdir(join(storage, "uva-pending", "intents")).catch(() => [])).filter((n) => n.endsWith(".json"));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error("timed out"); await sleep(100); }
}

test("a move cut off between the two workspaces is finished at the next start", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ws-move-crash-")), storage = join(root, "data"), beta = join(root, "uva");
  await mkdir(storage); await mkdir(beta, { mode: 0o700 });
  let server = null;
  t.after(async () => { await server?.kill(); await rm(root, { recursive: true, force: true }); });
  server = await startCanvasStoreServer(storage, beta, { idle: "0" });
  const [a, b, c] = [await server.upload("#c03030"), await server.upload("#30c030"), await server.upload("#3030c0")];
  const source = (await server.call("create_workspace", { name: "source", canvases: [a, b] })).structuredContent.workspaceId;
  const target = (await server.call("create_workspace", { name: "target", canvases: [c] })).structuredContent.workspaceId;
  const assets = async (ws) => (await server.call("get_workspace_state", { workspace: ws })).structuredContent.items.map((it) => it.asset);
  // Wait for the target's own record to be committed, then make its next
  // record write fail: the move is acknowledged (its intent is durable) but
  // only the source is written, which is where a crash could have left it.
  await until(async () => !(await readdir(join(storage, "uva-pending", "records"))).some((n) => n.includes(target.slice(3))));
  await mkdir(pendingPath(storage, target));
  const moved = await server.call("merge_workspaces", { target, source, items: ["wi-1"], removeFromSource: true, commit: true });
  assert.equal(moved.structuredContent.verified, true);
  assert.equal((await intents(storage)).length, 1, "the move's intent is kept until both workspaces are written");
  assert.deepEqual(await assets(target), [c, a], "the target is answered from the intent meanwhile");
  await server.kill();

  await rmdir(pendingPath(storage, target));
  server = await startCanvasStoreServer(storage, beta, { idle: "0" });
  assert.deepEqual(await assets(source), [b]);
  assert.deepEqual(await assets(target), [c, a], "the target was rolled forward");
  assert.deepEqual(await intents(storage), []);
  // The move stays one change: undoing it restores both workspaces.
  await server.call("undo_workspace_change", { workspaceId: target, undoToken: moved.structuredContent.undoToken });
  assert.deepEqual(await assets(source), [a, b]);
  assert.deepEqual(await assets(target), [c]);
});
