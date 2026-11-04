import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { ReaderPins } from "../../../../../src/persistence/pins.js";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-readers-"));
const files = new ManagedFiles(root);
const TIME = Date.UTC(2030, 0, 1);
const emit = (event, detail) => console.log(JSON.stringify({ event, ...detail }));
const doc = { ...document(), persistence: "durable" };
let store, passed = false;
try {
  if (process.argv[2] === "sessions") {
    store = await openIsolatedStore(root, { profile: "linux-local-durable", purpose: "isolated-pr1c-testing",
      testClockMs: TIME, lifecycle: { enabled: true, autoMaintenance: false } });
    assert.equal(store.status.state, "ready");
    await store.commit(command([doc]), actor(), await epoch(store));
    const pins = [];
    for (let index = 0; index < 64; index++) pins.push(await store.maintenance("pin", { ttlMs: 1000 }));
    const status = (await store.diagnostics()).lifecycle.pins;
    assert.equal(status.sessions, 64);
    assert.equal(status.physicalBytes, pins[0].bytes);
    await assert.rejects(store.maintenance("pin"), { code: "LIMIT" });
    const next = { ...doc, revision: 2, title: "concurrent change" };
    const expected = await epoch(store), start = performance.now();
    const result = await Promise.all([
      store.commit(command([next], 2, 1), actor(2), expected),
      ...pins.map(pin => store.maintenance("readPin", { id: pin.id })),
    ]);
    assert.equal(result[0].ack.revisionVector[0].revision, 2);
    for (const old of result.slice(1)) assert.deepEqual(old, [doc]);
    emit("shared-readers", { ...status, readers: 64, rejectedSession: 65, elapsedMs: performance.now() - start,
      usage: await files.usage() });
    await store.maintenance("releasePin", { id: pins[0].id });
    await store.maintenance("clock", { nowMs: TIME + 1001 });
    await assert.rejects(store.maintenance("readPin", { id: pins[1].id }), { code: "STALE_CURSOR" });
    await store.commit(command([{ ...next, revision: 3, title: "expires released" }], 3, 2), actor(3), await epoch(store));
    assert.equal((await store.diagnostics()).lifecycle.pins.sessions, 0);
  } else {
    // Direct production pin bound with disposable files. This creates no Store
    // authority and is separate from the documented Document/backup stress.
    const pins = new ReaderPins(files, {}), paths = [], sessions = [];
    const chunk = Buffer.alloc(4 * 1024**2);
    const start = performance.now();
    for (let index = 0; index < 16; index++) {
      chunk.fill(index + 1);
      const path = "member-" + index;
      const fd = await open(join(root, path), "wx", 0o600);
      try {
        for (let i = 0; i < 16; i++) await fd.writeFile(chunk);
        await fd.sync();
      } finally { await fd.close(); }
      paths.push(path);
      sessions.push(await pins.acquire({}, [path], TIME));
    }
    assert.equal(pins.bytes, 1024**3);
    const shared = await pins.acquire({}, [paths[0]], TIME);
    const extra = await open(join(root, "overflow"), "wx", 0o600);
    try { await extra.writeFile("x"); await extra.sync(); } finally { await extra.close(); }
    await assert.rejects(pins.acquire({}, ["overflow"], TIME), { code: "LIMIT" });
    emit("physical-union", { ...pins.status(), elapsedMs: performance.now() - start, overflowRejected: true,
      usage: await files.usage() });
    for (const item of [...sessions, shared]) await pins.release(item.id);
    assert.equal(pins.bytes, 0);
  }
  passed = true;
} finally {
  if (store) { store.kill(); await store.waitForExit(); }
  if (passed) await rm(root, { recursive: true });
  else emit("preserved", { root });
}
