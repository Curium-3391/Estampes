// #90: a G2 candidate whose content-addressed path becomes reachable again after
// the plan's mark. Index pages and generation files are named by their content,
// so a later commit, or the plan's own publication, can write the same path
// again. The plan used to keep such a candidate forever (it could never be
// moved), so after the grace it returned "quarantining" and never terminated.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, chmod, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {ManagedFiles} from "../src/persistence/filesystem.js";
import {loadCommitted} from "../src/persistence/records.js";
import {readGcPlan} from "../src/persistence/gc.js";
import {PageStore} from "../src/persistence/pages.js";
import {parseCommitRoot} from "../src/persistence/commit-root-schema.js";
import {hashJson} from "../src/documents/validation.js";
import {lifecycleFixture, document, command, actor, epoch, TIME, DAY} from "./fixtures/uva-lifecycle.mjs";

const ready = f => assert.equal(f.store.status.state, "ready", JSON.stringify(f.store.status.problem));

async function stopCommit(f, point, cmd) {
  await f.store.injectFault({point, mode: "pause"});
  let listener, timer;
  const reached = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Did not reach " + point)), 20000);
    listener = e => { if (e.name === point) resolve(); };
    f.store.events.on("stage", listener);
  });
  const pending = epoch(f.store).then(e => f.store.commit(cmd, actor(), e)).catch(e => e);
  try { await reached; } finally { clearTimeout(timer); f.store.events.off("stage", listener); f.store.kill("SIGKILL"); await f.store.waitForExit(); }
  assert.equal((await pending).code, "RECOVERY_REQUIRED");
}

// An interrupted first commit leaves its staged pages and generation file as
// G2 candidates; committing the same document again writes the same paths.
async function abandoned(t) {
  const f = await lifecycleFixture(t), files = new ManagedFiles(f.root), cmd = command([document()]);
  await stopCommit(f, "current.before-rename", cmd);
  await f.reopen(); ready(f);
  const job = await f.store.maintenance("gcPlan", {classes: ["G2"]});
  assert.equal(job.planned, true);
  const plan = await readGcPlan(files, (await loadCommitted(files)).indices.retention.get("gc:" + job.id));
  return {f, files, cmd, job, plan};
}
const digests = async (files, paths) => Promise.all(paths.map(async p => (await files.exists(p)) ? (await files.digest(p)).hash : null));

test("a candidate re-adopted before quarantine is released; grace still holds the rest and the plan terminates", async t => {
  const {f, files, cmd, job, plan} = await abandoned(t);
  await f.store.commit(cmd, actor(2), await epoch(f.store));
  const live = new Set((await loadCommitted(files)).files);
  const readopted = plan.candidates.map((c, i) => live.has(c.path) ? i : -1).filter(i => i >= 0);
  assert.ok(readopted.some(i => plan.candidates[i].path.startsWith("visual-documents/")), "the generation file is written again");
  const before = await digests(files, readopted.map(i => plan.candidates[i].path));

  const first = await f.store.maintenance("gcStep", {id: job.id});
  assert.equal(first.state, "waiting-grace");
  assert.equal(first.deleted, 0, "nothing is unlinked before the G2 grace");
  assert.equal(first.released, readopted.length);
  assert.equal(first.moved + first.released, plan.candidates.length);
  // Released candidates are never quarantined: their live objects stay in place.
  assert.deepEqual(await digests(files, readopted.map(i => plan.candidates[i].path)), before);
  for (const i of readopted) assert.equal(await files.exists(plan.candidates[i].quarantine), false);

  await f.store.maintenance("clock", {nowMs: TIME + DAY});
  const second = await f.store.maintenance("gcStep", {id: job.id});
  assert.equal(second.state, "complete");
  assert.equal(second.deleted, first.moved);
  assert.deepEqual(await digests(files, readopted.map(i => plan.candidates[i].path)), before);
  const documents = (await f.store.snapshot()).documents;
  await f.reopen({testClockMs: TIME + DAY}); ready(f);
  assert.deepEqual((await f.store.snapshot()).documents, documents);
  assert.equal((await f.store.diagnostics()).contentCommits, 1);
  assert.equal((await f.store.maintenance("gcStep", {id: job.id})).state, "complete");
});

// Unchanged by #90 (and asserted by H-02 in persistence-integrity-hardening):
// once a candidate is quarantined, a path that is reachable again keeps the
// plan's copy and the plan waits; the new live object is never touched.
test("a candidate re-created after quarantine keeps its quarantined copy; the live object stays", async t => {
  const {f, files, cmd, job, plan} = await abandoned(t);
  const first = await f.store.maintenance("gcStep", {id: job.id});
  assert.equal(first.state, "waiting-grace");
  assert.equal(first.moved, plan.candidates.length);
  await f.store.commit(cmd, actor(2), await epoch(f.store));
  const live = new Set((await loadCommitted(files)).files);
  const recreated = plan.candidates.map((c, i) => live.has(c.path) ? i : -1).filter(i => i >= 0);
  assert.ok(recreated.length > 0);
  await f.store.maintenance("clock", {nowMs: TIME + DAY});
  const after = await f.store.maintenance("gcStep", {id: job.id});
  assert.equal(after.state, "waiting-grace");
  assert.equal(after.deleted, plan.candidates.length - recreated.length);
  for (const i of recreated) {
    const c = plan.candidates[i];
    assert.equal(await files.exists(c.quarantine), true);
    assert.equal((await files.digest(c.path)).hash, c.hash);
  }
  const documents = (await f.store.snapshot()).documents;
  await f.reopen({testClockMs: TIME + DAY}); ready(f);
  assert.deepEqual((await f.store.snapshot()).documents, documents);
});

test("a clock rollback keeps the grace closed for a plan with released candidates", async t => {
  const {f, cmd, job} = await abandoned(t);
  await f.store.commit(cmd, actor(2), await epoch(f.store));
  assert.equal((await f.store.maintenance("gcStep", {id: job.id})).state, "waiting-grace");
  await f.store.maintenance("clock", {nowMs: TIME + DAY});
  await f.store.maintenance("clock", {nowMs: TIME - DAY});
  const rolledBack = await f.store.maintenance("gcStep", {id: job.id});
  assert.equal(rolledBack.state, "waiting-grace"); assert.equal(rolledBack.deleted, 0);
  await f.reopen({testClockMs: TIME + DAY}); ready(f);
  assert.equal((await f.store.maintenance("gcStep", {id: job.id})).state, "complete");
});

// The store captured from the intermittent R3-B1 failure (see
// docs/rfc/unified-visual-architecture/PR-1D-G2-ROOT-CAUSE.md). It is read, not
// opened: the plan records each candidate's inode, which a copy cannot keep.
test("the captured R3-B1 store: the plan's own publication re-adopted a retention page", async t => {
  const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-g2-capture-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bundle = fileURLToPath(new URL("../docs/rfc/unified-visual-architecture/evidence/g2-resolution/captured-store.tar.gz", import.meta.url));
  execFileSync("tar", ["-xzf", bundle, "-C", root]); await chmod(root, 0o700);
  const files = new ManagedFiles(root), snapshot = await loadCommitted(files);
  const [[key, record]] = [...snapshot.indices.retention].filter(([k]) => k.startsWith("gc:"));
  const plan = await readGcPlan(files, record);
  // What the old step returned after the grace: every moved candidate deleted, one never moved.
  assert.equal(record.state, "quarantining");
  assert.deepEqual([...record.deleted].sort(), [...record.moved].sort());
  const stuck = plan.candidates.map((_, i) => i).filter(i => !record.moved.includes(i));
  assert.equal(stuck.length, 1);
  const candidate = plan.candidates[stuck[0]];
  // The plan's publication (generation sourceGeneration + 1) reaches the
  // candidate's path; it stays a recovery root, so every later mark protects it.
  const recovery = snapshot.indices.retention.get("recovery:" + (plan.sourceGeneration + 1));
  const pages = new PageStore(files), published = parseCommitRoot(await pages.hashed(recovery.envelope.rootHash, "visual-registry/roots", 64 * 1024));
  await pages.read(published.roots.retention, "retention");
  assert.ok(pages.track.has(candidate.path), "the plan's own publication reaches the candidate's path");
  const atPlan = parseCommitRoot(await new PageStore(files).hashed(plan.sourceRootHash, "visual-registry/roots", 64 * 1024)), planPages = new PageStore(files);
  await planPages.read(atPlan.roots.retention, "retention");
  assert.equal(planPages.track.has(candidate.path), false, "the marked root did not");
  const page = await files.json(candidate.path);
  assert.equal(page.kind, "retention");
  assert.deepEqual(page.entries.map(e => e.key), ["lifecycle"]);
  // At planning time a temporary claim shared that bucket, so the live page had
  // other bytes; the plan's publication removed the claim's record and the
  // bucket returned to the interrupted commit's exact page.
  const sharing = plan.temporaryDispositions.filter(d => hashJson("temporary:" + d.recovery.claimId).slice(0, 2) === page.bucket);
  assert.equal(sharing.length, 1);
  assert.equal(hashJson("lifecycle").slice(0, 2), page.bucket);
  assert.equal(key, "gc:" + plan.id);
  assert.ok((await readdir(join(root, "gc-quarantine", plan.id))).length === 0);
});
