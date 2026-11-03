import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashJson } from "../src/documents/validation.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { readGcPlan } from "../src/persistence/gc.js";
import { loadCommitted } from "../src/persistence/records.js";
import { lifecycleFixture, destination, document, command, actor, epoch, titleEdit, TIME, DAY } from "./fixtures/uva-lifecycle.mjs";

// Process-crash adaptation of the preserved Round 2 harness; assertions unchanged.
const native = {profile: "linux-process-crash-test"};
const durable = () => ({...document(), persistence: "memory"});
const current = "visual-registry/CURRENT.json";
const claimDir = "visual-temporaries/claims";
const ready = f => assert.equal(f.store.status.state, "ready", JSON.stringify(f.store.status.problem));

async function killAt(f, point, operation, nth = 1) {
  await f.store.injectFault({point, nth, mode: "pause"});
  let timer, listener;
  const reached = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Fault point not reached: " + point)), 20000);
    listener = event => { if (event.name === point) resolve(); };
    f.store.events.on("stage", listener);
  });
  const pending = Promise.resolve().then(operation).catch(error => error);
  try { await reached; }
  finally {
    clearTimeout(timer);
    f.store.events.off("stage", listener);
    f.store.kill("SIGKILL");
    await f.store.waitForExit();
  }
  assert.equal((await pending).code, "RECOVERY_REQUIRED");
}

async function onlyClaim(files) {
  const [name, ...extra] = await readdir(files.path(claimDir));
  assert.ok(name);
  assert.deepEqual(extra, []);
  const path = claimDir + "/" + name;
  return {path, value: await files.json(path)};
}

for (const profile of ["linux-process-crash-test"]) {
  test("H-01 / three reopens retain exact ACK and reject different payload / " + profile, async t => {
    const f = await lifecycleFixture(t, {profile});
    const d = profile === native.profile ? durable() : document();
    const cmd = command([d]);
    const files = new ManagedFiles(f.root);
    await killAt(f, "current.after-dir-fsync", async () => f.store.commit(cmd, actor(), await epoch(f.store)));
    const selected = await loadCommitted(files);
    const original = [...selected.indices.ledger.values()][0].ack;
    const next = titleEdit(d);
    for (let n = 0; n < 3; n++) {
      await f.reopen();
      ready(f);
      const replay = await f.store.commit(cmd, actor(3 + n), await epoch(f.store));
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.ack, original);
      await assert.rejects(f.store.commit(command([{...d, title: "different"}]), actor(9), await epoch(f.store)),
        error => error.code === "IDEMPOTENCY_MISMATCH");
      const snapshot = await loadCommitted(files);
      assert.ok(snapshot.root.generation > selected.root.generation);
      assert.deepEqual(snapshot.documents, [n === 0 ? d : next]);
      assert.equal(snapshot.indices.ledger.size, n === 0 ? 1 : 2);
      if (n === 0) await f.store.commit(command([next], 2, 1), actor(2), await epoch(f.store));
    }
  });
}

test("H-01 / SIGKILL during exact CURRENT claim cleanup still replays the durable ACK", async t => {
  const f = await lifecycleFixture(t, native);
  const d = durable(), cmd = command([d]), files = new ManagedFiles(f.root);
  // Stop just before unlink of the CURRENT claim. Earlier atomic writes have
  // their own claims. The real pause is armed from an observed dry run below.
  const dry = await lifecycleFixture(t, native);
  t.diagnostic("Both disposable lease workers are ready");
  const previous = (await dry.store.diagnostics()).trace.length;
  await dry.store.commit(cmd, actor(), await epoch(dry.store));
  const trace = (await dry.store.diagnostics()).trace.slice(previous);
  await dry.store.close();
  const barrier = trace.indexOf("current.after-dir-fsync");
  assert.ok(barrier >= 0);
  const cleanup = trace.indexOf("temporary-claim.before-unlink", barrier);
  assert.ok(cleanup > barrier);
  const nth = trace.slice(0, cleanup + 1).filter(name => name === "temporary-claim.before-unlink").length;
  assert.ok(nth > 0);
  t.diagnostic("CURRENT cleanup is temporary-claim.before-unlink occurrence " + nth);
  await killAt(f, "temporary-claim.before-unlink", async () => f.store.commit(cmd, actor(), await epoch(f.store)), nth);
  assert.equal((await onlyClaim(files)).value.finalPath, current);
  t.diagnostic("SIGKILL left only the durable CURRENT claim");
  const before = await loadCommitted(files);
  const original = [...before.indices.ledger.values()][0].ack;
  for (let n = 0; n < 3; n++) {
    await f.reopen();
    ready(f);
    t.diagnostic("Cleanup recovery reopen " + (n + 1) + " ready");
    assert.deepEqual(await f.store.commit(cmd, actor(n+2), await epoch(f.store)), {ack: original, replayed: true});
    assert.deepEqual((await f.store.snapshot()).documents, [d]);
  }
});

for (const fault of ["missing prepared", "corrupt prepared", "forged publication"]) {
  test("H-01 / " + fault + " fails closed for a superseded CURRENT", async t => {
    const f = await lifecycleFixture(t, native), files = new ManagedFiles(f.root), cmd = command([durable()]);
    await killAt(f, "current.after-dir-fsync", async () => f.store.commit(cmd, actor(), await epoch(f.store)));
    const claim = await onlyClaim(files);
    await f.reopen();
    ready(f);
    await f.store.close();
    const before = await readFile(files.path(current));
    const preparedPath = "visual-transactions/" + claim.value.owner.id + "/prepared.json";
    if (fault === "missing prepared") await unlink(files.path(preparedPath));
    if (fault === "corrupt prepared") await writeFile(files.path(preparedPath), "{}");
    if (fault === "forged publication") {
      // Keep real CommitIndex, intent, outcome, CURRENT and Ledger unchanged.
      // Re-hash a never-published root with matching membership fields, then
      // substitute only the two files that purport to prove old publication.
      const prepared = await files.json(preparedPath);
      const root = await files.json("visual-registry/roots/" + prepared.rootHash + ".json");
      root.parentCommitHash = "f".repeat(64);
      const rootHash = hashJson(root);
      const head = {generation: prepared.generation, rootHash, commitId: prepared.commitId};
      const bytes = Buffer.from(canonicalJson({...head, checksum: hashJson(head)}));
      await files.durableCreate("visual-registry/roots/" + rootHash + ".json", Buffer.from(canonicalJson(root)), "fixture");
      await writeFile(files.path(preparedPath), canonicalJson({...prepared, rootHash}));
      await writeFile(files.path(claim.path), canonicalJson({...claim.value, bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex")}));
    }
    await f.reopen();
    t.diagnostic(JSON.stringify({state: f.store.status.state, problem: f.store.status.problem, recovery: f.store.status.recovery}));
    assert.equal(f.store.status.state, "read-only-recovery");
    assert.deepEqual(await readFile(files.path(current)), before);
    await assert.rejects(f.store.commit(cmd, actor(2), 1), error => error.code === "RECOVERY_REQUIRED");
  });
}

async function g2Fixture(t) {
  const f = await lifecycleFixture(t, native), d = durable(), files = new ManagedFiles(f.root);
  await f.store.commit(command([d]), actor(), await epoch(f.store));
  await killAt(f, "staged.before-file-fsync", async () => f.store.commit(command([titleEdit(d)], 2, 1), actor(2), await epoch(f.store)));
  const claim = await onlyClaim(files);
  await f.reopen();
  ready(f);
  return {f, d, files, claim};
}

async function owned(files, claimId) {
  const snapshot = await loadCommitted(files);
  const rows = [...snapshot.indices.retention].filter(([key]) => key.startsWith("gc:"));
  assert.equal(rows.length, 1);
  const [key, record] = rows[0];
  const plan = await readGcPlan(files, record);
  assert.equal(plan.temporaryDispositions.length, 1);
  assert.equal(plan.temporaryDispositions[0].recovery.claimId, claimId);
  assert.equal(snapshot.indices.retention.has("temporary:" + claimId), false);
  return {id: key.slice(3), plan, record};
}

for (const phase of ["plan", "before intent", "after intent", "terminal"]) {
  test("H-02 / native SIGKILL across durable G2 " + phase, async t => {
    const {f, d, files, claim} = await g2Fixture(t);
    const planGc = () => f.store.maintenance("gcPlan", {classes: ["G2"]});
    let plan;
    if (phase === "plan") {
      await killAt(f, "after-publication-durable", planGc);
      await f.reopen();
      ready(f);
      plan = await owned(files, claim.value.claimId);
    } else plan = await planGc();
    const step = () => f.store.maintenance("gcStep", {id: plan.id});
    assert.equal((await step()).state, "waiting-grace");
    await f.store.maintenance("clock", {nowMs: TIME + DAY - 1});
    assert.equal((await step()).state, "waiting-grace");
    const quarantined = await owned(files, claim.value.claimId);
    const candidates = quarantined.plan.candidates;
    for (const candidate of candidates) assert.equal(await files.exists(candidate.quarantine), true);
    await f.store.maintenance("clock", {nowMs: TIME + DAY});
    if (phase === "before intent") await killAt(f, "gc.after-quarantine", step);
    if (phase === "after intent") await killAt(f, "after-publication-durable", step, 2);
    if (phase === "terminal") await killAt(f, "after-publication-durable", step, 3);
    const {record} = await owned(files, claim.value.claimId);
    if (phase === "before intent") assert.equal(record.unlinking, undefined);
    if (phase === "after intent") assert.ok(record.unlinking.length > 0);
    if (phase === "terminal") assert.equal(record.state, "complete");
    for (let i = 0; i < 2; i++) {
      await f.reopen({testClockMs: TIME + DAY});
      ready(f);
      assert.equal((await step()).state, "complete");
      assert.equal(await files.exists(claim.path), false);
      assert.equal(await files.exists(claim.value.temporaryPath), false);
      await owned(files, claim.value.claimId);

    }
    for (let i = 0; i < 2; i++) {
      const laterPlan = await planGc();
      if (!laterPlan.planned) continue;
      const snapshot = await loadCommitted(files);
      const newPlan = await readGcPlan(files, snapshot.indices.retention.get("gc:" + laterPlan.id));
      assert.deepEqual(newPlan.temporaryDispositions ?? [], []);
      assert.ok(newPlan.candidates.every(c => c.path !== claim.path && c.path !== claim.value.temporaryPath));
    }
    const dest = await destination(t);
    const job = await f.store.maintenance("backupStart", {destination: dest});
    let outcome;
    for (let i = 0; i < 100; i++) {
      outcome = await f.store.maintenance("backupStep", {id: job.id});
      if (outcome.state === "complete") break;
    }
    assert.equal(outcome.state, "complete");
    assert.deepEqual((await loadCommitted(new ManagedFiles(dest))).documents, [d]);
  });
}

for (const fault of ["corrupt plan", "tampered quarantine", "missing quarantine cold", "missing quarantine warm"]) {
  test("H-02 / " + fault + " lacks durable unlink intent and must fail closed", async t => {
    const {f, files, claim} = await g2Fixture(t);
    const {id} = await f.store.maintenance("gcPlan", {classes: ["G2"]});
    const step = () => f.store.maintenance("gcStep", {id});
    assert.equal((await step()).state, "waiting-grace");
    const {plan, record} = await owned(files, claim.value.claimId);
    const candidate = plan.candidates[plan.temporaryDispositions[0].temporaryCandidate];
    assert.equal(record.unlinking, undefined);
    const warm = fault.endsWith("warm");
    if (!warm) await f.store.close();
    if (fault === "corrupt plan") await writeFile(files.path("visual-maintenance/gc/" + record.planHash + ".json"), "{}");
    if (fault === "tampered quarantine") await writeFile(files.path(candidate.quarantine), "altered quarantine");
    if (fault.startsWith("missing")) await unlink(files.path(candidate.quarantine));
    const before = await readFile(files.path(current));
    if (warm) {
      await f.store.maintenance("clock", {nowMs: TIME + DAY});
      const result = await step().catch(error => ({code: error.code, message: error.message}));
      const selected = await loadCommitted(files);
      t.diagnostic(JSON.stringify({result, gcState: selected.indices.retention.get("gc:" + id), writerState: (await f.store.diagnostics()).state}));
      assert.equal(result.code, "RECOVERY_REQUIRED");
    } else {
      await f.reopen({testClockMs: TIME + DAY});
      assert.equal(f.store.status.state, "read-only-recovery");
      assert.deepEqual(await readFile(files.path(current)), before);
    }
  });
}
