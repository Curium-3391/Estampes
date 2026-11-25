// #174-4: built-in modules may declare `init` and `health` hooks, so the server's start-up code does not build the calculator's
// service client and notebook store itself. Invented stand-in modules for the host; the real calculator for its own hooks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import * as cas from "../src/builtin-modules/cas/index.js";

const manifest = (id) => ({ schema: "estampes.module/1", id, name: "Stand-in", description: "A stand-in module for tests.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: ["canvas.read"], runtime: { kind: "builtin", entry: "x" },
  capabilities: [{ id: "noop", title: "noop", description: "Does nothing.", target: "none", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
const host = async (builtins) => createModuleHost({ storageDir: await mkdtemp(join(tmpdir(), "hooks-")), coreVersion: "0.10.0", builtins, canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });

test("init runs once per module with the context, health is reported under the module's key, a module without hooks is skipped", async () => {
  const seen = [];
  const a = { manifest: manifest("org.example.a"), run: () => ({}), init: (c) => seen.push(c), healthKey: "a", health: async () => ({ available: true }) };
  const b = { manifest: manifest("org.example.b"), run: () => ({}) };
  const h = await host([a, b]);
  await h.initBuiltins({ marker: 1 });
  assert.deepEqual(seen, [{ marker: 1 }]);
  assert.deepEqual(await h.health(), { a: { available: true } });
});

test("a hook that throws stops nothing: init is audited, health reads as unavailable, the other modules still report", async () => {
  const bad = { manifest: manifest("org.example.bad"), run: () => ({}), init: () => { throw new Error("boom"); }, healthKey: "bad", health: async () => { throw new Error("down"); } };
  const good = { manifest: manifest("org.example.good"), run: () => ({}), init: () => {}, healthKey: "good", health: async () => ({ available: true }) };
  const h = await host([bad, good]);
  await h.initBuiltins({});
  const out = await h.health();
  assert.deepEqual(out.good, { available: true });
  assert.equal(out.bad.available, false);
  assert.match(out.bad.reason, /down/);
});

test("the calculator builds its own client and notebooks from the context, and an unreachable service degrades only itself", async () => {
  cas.init({ config: { casSocket: join(tmpdir(), "no-such-cas.sock"), storageDir: tmpdir() }, persistent: false, records: () => null });
  assert.ok(cas.casClient(), "a client was built");
  assert.ok(cas.notebookStore(), "a notebook store was built");
  assert.equal(cas.healthKey, "cas");
  const out = await cas.health();
  assert.equal(out.available, false);
  assert.ok(out.reason);
});
