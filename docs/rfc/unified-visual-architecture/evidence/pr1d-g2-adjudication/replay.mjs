import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openIsolatedStore } from "../src/persistence/lease.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted } from "../src/persistence/records.js";
import { lifecycleFixture, document, command, actor, epoch, TIME, DAY } from "./fixtures/uva-lifecycle.mjs";
import { emit, observe } from "./observe.mjs";

const mode = process.env.PR1D_G2_MODE;
assert.ok(["strict", "uninterrupted", "bounded-drain"].includes(mode));
const point = "current.before-rename";
const options = {
  profile: "linux-local-durable", purpose: "isolated-pr1c-testing", testClockMs: TIME,
  lifecycle: { enabled: true, autoMaintenance: false },
};

async function stopCommit(fixture, cmd) {
  await fixture.store.injectFault({ point, mode: "pause" });
  let timer, listener;
  const reached = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Did not reach " + point)), 20000);
    listener = event => { if (event.name === point) resolve(event); };
    fixture.store.events.on("stage", listener);
  });
  const pending = epoch(fixture.store).then(e => fixture.store.commit(cmd, actor(), e)).catch(error => error);
  try { emit("initial-fault", await reached); }
  finally {
    clearTimeout(timer);
    fixture.store.events.off("stage", listener);
    fixture.store.kill("SIGKILL");
    await fixture.store.waitForExit();
  }
  assert.equal((await pending).code, "RECOVERY_REQUIRED");
}

async function reopen(fixture, clockMs, instrument = false) {
  if (instrument) {
    assert.equal(process.env.NODE_OPTIONS, undefined);
    process.env.NODE_OPTIONS = "--import=" + fileURLToPath(new URL("./worker-observer.mjs", import.meta.url));
  }
  try { await fixture.reopen({ testClockMs: clockMs }); }
  finally { if (instrument) delete process.env.NODE_OPTIONS; }
  emit("writer-ready", { status: fixture.store.status.state, platform: fixture.store.status.platform,
    problem: fixture.store.status.problem, lifecycle: fixture.store.status.lifecycle });
  assert.equal(fixture.store.status.state, "ready", JSON.stringify(fixture.store.status.problem));
}

test("G2 " + mode, async t => {
  // The sealed prepare-native.py conversion also sets the fixture default
  // to linux-local-durable. Match the original call to lifecycleFixture(t).
  const f = await lifecycleFixture(t);
  const files = new ManagedFiles(f.root);
  const cmd = command([document()]);
  const capture = (name, clockMs = TIME, durability = "settled worker") =>
    observe(f.root, name, { clockMs, durability });
  await capture("bootstrap");
  await stopCommit(f, cmd);
  await capture("after-initial-kill", TIME, "old CURRENT; interrupted before rename");
  assert.equal((await loadCommitted(files)).indices.ledger.size, 0);

  const interruptions = mode === "uninterrupted" ? 0 : 4;
  for (let i = 0; i < interruptions; i++) {
    let boundary;
    await assert.rejects(openIsolatedStore(f.root, {
      ...options, fault: { point: "current.after-dir-fsync", mode: "pause" },
    }, event => {
      if (event.name === "current.after-dir-fsync") {
        boundary = event;
        process.kill(event.pid, "SIGKILL");
      }
    }), error => error.code === "RECOVERY_REQUIRED" && error.details?.signal === "SIGKILL");
    assert.ok(boundary);
    emit("recovery-fault", { attempt: i + 1, ...boundary, writerPid: boundary.pid, requestedProfile: options.profile });
    await capture("after-recovery-kill", TIME, "CURRENT directory fsync completed at observed kill boundary");
    assert.equal((await loadCommitted(files)).indices.ledger.size, 0);
  }
  assert.equal((await readdir(files.path("visual-temporaries/claims"))).length, interruptions + 1);

  await reopen(f, TIME);
  await capture("recovered");
  const committed = await f.store.commit(cmd, actor(2), await epoch(f.store));
  assert.equal(committed.replayed, false);
  await capture("request-committed");
  await assert.rejects(f.store.commit(command([{...document(), title: "different payload"}]), actor(3),
    await epoch(f.store)), error => error.code === "IDEMPOTENCY_MISMATCH");
  await reopen(f, TIME, true);
  const replay = await f.store.commit(cmd, actor(4), await epoch(f.store));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.ack, committed.ack);
  const ledger = (await loadCommitted(files)).indices.ledger;
  assert.equal(ledger.size, 1);
  assert.deepEqual([...ledger.values()][0].ack, committed.ack);
  emit("ack-identity", { committed, replay });

  const job = await f.store.maintenance("gcPlan", { classes: ["G2"] });
  assert.equal(job.planned, true);
  const step = () => f.store.maintenance("gcStep", { id: job.id });
  const beforeGrace = await step();
  assert.equal(beforeGrace.state, "waiting-grace");
  assert.equal(beforeGrace.deleted, 0);
  emit("clock", { nowMs: TIME + DAY, result: await f.store.maintenance("clock", { nowMs: TIME + DAY }) });
  const afterGrace = await step();
  const strict = mode !== "bounded-drain";
  let drained = afterGrace;
  if (afterGrace.state !== "complete") {
    // Keep the original result and oracle. Follow up only on the same selected
    // plan with the same clock, through at most two fresh writers.
    for (let i = 0; i < 2 && drained.state !== "complete"; i++) {
      await reopen(f, TIME + DAY, true);
      drained = await step();
    }
  }
  await reopen(f, TIME + DAY);
  await capture("final-restart", TIME + DAY);
  assert.equal((await f.store.diagnostics()).contentCommits, 1);
  const final = await loadCommitted(files);
  assert.deepEqual([...final.indices.ledger.values()][0].ack, committed.ack);
  const selected = final.indices.retention.get("gc:" + job.id);
  assert.equal(selected.state, drained.state);
  if (drained.state === "complete") assert.equal(selected.deleted.length, job.candidates);
  else assert.ok(["waiting-grace", "quarantining"].includes(drained.state));
  if (strict) assert.equal(afterGrace.state, "complete");
});
