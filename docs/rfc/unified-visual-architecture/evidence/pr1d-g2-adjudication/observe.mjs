import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted, ledgerRecord } from "../src/persistence/records.js";
import { gcOwnership, protectedPaths, readGcPlan } from "../src/persistence/gc.js";
import { readBackupList } from "../src/persistence/backup.js";
import { assertCurrentEnvelope, parseCommitRoot } from "../src/persistence/commit-root-schema.js";
import { policyOf } from "../src/persistence/lifecycle-state.js";
import { PageStore } from "../src/persistence/pages.js";

export function emit(event, data) {
  appendFileSync(process.env.PR1D_G2_TRACE, JSON.stringify({ ...data, event, pid: process.pid }) + "\n");
}

async function inventory(files, directory, read) {
  if (!await files.exists(directory)) return [];
  const names = await readdir(files.path(directory));
  return Promise.all(names.sort().map(name => read(directory + "/" + name)));
}

async function digest(files, path) {
  return await files.exists(path) ? await files.digest(path) : null;
}

async function fixedRoot(files, key, value) {
  const pages = new PageStore(files);
  const root = parseCommitRoot(await pages.hashed(value.envelope.rootHash, "visual-registry/roots", 65536));
  assertCurrentEnvelope(root, value.envelope);
  for (const [kind, hash] of Object.entries(root.roots)) await pages.read(hash, kind);
  return { key, ...value, paths: [...pages.track].sort() };
}

export async function observe(rootPath, event, boundary, manager) {
  // A separate reader keeps verification observations out of the writer's cache.
  const files = new ManagedFiles(rootPath);
  const usage = await files.usage();
  if (usage.allocatedBytes > 64 * 1024 ** 2 || usage.files > 1024) {
    emit("resource-stop", { usage });
    throw new Error("Diagnostic Store exceeded its resource bound");
  }
  const snapshot = await loadCommitted(files);
  const { envelope, root, indices, authority } = snapshot;
  const stat = await lstat(rootPath);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.uid, process.getuid());

  const retention = [...indices.retention];
  const policy = policyOf(indices.retention);
  const selectedTemporary = retention.filter(([key]) => key.startsWith("temporary:"));
  const selectedJournalProofs = retention.filter(([key]) => key.startsWith("journal-"));
  const fixedRoots = await Promise.all(retention
    .filter(([key, value]) => /^(recovery|checkpoint):/.test(key) && value.envelope)
    .map(([key, value]) => fixedRoot(files, key, value)));
  const backups = await Promise.all(retention.filter(([key]) => key.startsWith("backup:"))
    .map(async ([key, value]) => ({ key, value, list: await readBackupList(files, value.filesHash) })));
  const pins = manager ? {
    epoch: manager.pins.epoch,
    sessions: [...manager.pins.sessions.values()].map(pin => ({
      id: pin.id, kind: pin.kind, snapshot: pin.snapshot, paths: [...pin.files.keys()],
      expiresAt: pin.expiresAt, active: pin.active, closing: pin.closing,
    })),
  } : null;
  const mark = manager ? await protectedPaths({ files, current: snapshot, lifecycle: manager }, { verify: false }) : null;
  const legacyClockFloor = manager?.legacyClockFloor ?? null;
  const clockMs = manager?.now() ?? boundary.clockMs;
  const plans = [];
  const ownership = await gcOwnership(files, snapshot);
  for (const [key, progress] of retention.filter(([key]) => key.startsWith("gc:"))) {
    const plan = await readGcPlan(files, progress);
    const graceDeadlineMs = progress.quarantinedAtMs === null ? null : progress.quarantinedAtMs + 86400000;
    const candidates = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      const { path, quarantine, physical } = candidate;
      candidates.push({
        index, ...candidate,
        selectedOwner: !progress.deleted.includes(index) && ownership.objects.has(physical.dev + ":" + physical.ino),
        sourceFile: await digest(files, path), quarantineFile: await digest(files, quarantine),
        marked: mark?.paths.has(path) ?? null,
        liveRoot: snapshot.files.includes(path),
        fixedRoots: fixedRoots.filter(fixed => fixed.paths.includes(path)).map(fixed => fixed.key),
        readerPins: pins?.sessions.filter(pin => pin.paths.includes(path)).map(pin => pin.id) ?? null,
        backupPins: backups.filter(backup => backup.value.state === "copying" &&
          backup.list.files.some(file => file.path === path)).map(backup => backup.key),
      });
    }
    plans.push({
      key, revision: { planHash: progress.planHash, selectedGeneration: root.generation },
      ...plan, progress, graceDeadlineMs,
      pending: candidates.filter(c => !progress.deleted.includes(c.index)).map(c => c.index),
      candidates,
    });
  }

  const claims = await inventory(files, "visual-temporaries/claims", path => files.json(path));
  const journal = await inventory(files, "visual-transactions", async path => {
    const entries = {};
    for (const name of ["intent", "prepared", "outcome"]) {
      const record = path + "/" + name + ".json";
      if (await files.exists(record)) entries[name] = await files.json(record);
    }
    return { path, ...entries };
  });
  emit(event, {
    boundary, store: { rootPath, device: stat.dev, mode: "0700", uid: stat.uid, usage, profile: authority.profile },
    envelope, roots: root.roots, selectedCommitId: root.commitId,
    activePlanIds: plans.filter(p => p.progress.state !== "complete").map(p => p.id),
    plans, livePaths: [...snapshot.files].sort(), fixedRoots, pins, backups,
    logicalAndPhysical: [...indices.locator.values()],
    clock: { clockMs, highWaterMs: policy?.highWaterMs, legacyClockFloor, canAge: manager?.canAge() ?? null },
    budget: { candidatesPerPlan: 128, activeCandidates: 4096, temporaryDispositions: 64, gcStepOperationCap: null },
    selectedTemporary, claims, selectedJournalProofs, journal,
    membership: [...indices.commitIndex.values()],
    ledger: [...indices.ledger].map(([key, value]) => ({ key, kind: value.kind, ...ledgerRecord(value) })),
  });
}
