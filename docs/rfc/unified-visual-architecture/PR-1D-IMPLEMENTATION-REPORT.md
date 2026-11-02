# PR-1D — Isolated Storage Lifecycle Implementation Report

Status: **IMPLEMENTATION BLOCKED**. Implementation is preserved for engineering review; production activation, migration, push, merge and PR-1B are not authorized. Current new-code native acceptance and full capacity/performance qualification remain open. This is not Architecture Approval and does not replace earlier reports.

## 1. Git baseline and exact implementation commits

| Item | Observed value |
| --- | --- |
| Required fetched base branch | `codex/pr1c-native-ext4-acceptance` |
| Exact base / native acceptance HEAD | `58f7789414130085543560147df87e85a62123ea` |
| Original PR-1C ancestor | `5549f10586dc17e0a802c42dd6c37ebaa70ad80a` |
| Native regression ancestor | `1684335e7e463a0ea5bb1a560ed6565ef42299ae` |
| Original PR-1A remediation | `75a30febee1f60e18981ec54e3c76b225c515bb1` |
| Main at fetch / version | `7fb9b73442401fc32a7034888deaf49303e582a6` / `0.20.0` |
| Working branch | `feat/unified-visual-architecture-pr1d` |
| Implementation commit | `eef2f5c13580fa0acd41af84796b09ee8021238b` |

`git fetch origin`, explicit native branch fetch, `ls-remote`, exact HEAD and `merge-base --is-ancestor` checks were performed before changing the initially clean checkout. No main drift, reset, rebase, force or user-work overwrite occurred. [Baseline](evidence/pr1d-baseline.json) and [limited authorization](PR-1D-AUTHORIZATION.md) record the instruction boundary. The evidence/report commit follows the implementation commit; its SHA is available from `git log --oneline` and the final delivery message, avoiding a self-referential commit hash inside its own file.

Changes: isolated persistence code and new disposable tests, documentation and evidence only. Existing server/MCP tools, `saveCanvas`, legacy storage, modules, CAS, Graph, Workbench, Host authentication and user data are unchanged. The checker preserves all 95 original production/config hashes, every pre-PR-1D test, the native guard and historical native evidence byte for byte.

## 2. Implemented components and internal interfaces

| File | Responsibility / boundary |
| --- | --- |
| `src/persistence/archive.js` | Closed full/delta locator schemas, canonical forward patches, chunk manifests, hash-checked reconstruction and physical closure discovery |
| `lifecycle-state.js` | Versioned policy, recovery, checkpoint, GC job, backup job and permanent journal proof records under retention root |
| `lifecycle.js` | Retention/pin/checkpoint operations, bounded compaction steps, seven-day ACK compaction, capacity admission, fixed source conflicts and serialized maintenance dispatch |
| `pins.js` | Server-owned actual file handles, fixed Registry/Locator snapshots, physical hash union accounting, active read quiescence |
| `gc.js` | Live reachability verification, durable allowlisted G1/G2 plans, quarantine, grace, unlink, restart repair and progress |
| `capacity.js` | Allocated-block/free-space admission and outstanding reservations with recovery reserve |
| `backup.js`, `restore-worker.js` | Fixed-root file index, bounded stream copy, complete manifest last, token-bound destination, OS-leased new-volume RO restore |
| Existing coordinator/filesystem/pages/records/journal/lease/worker | Same sole Root publication path; delta-aware closure, mixed retention records, fsync barriers, compacted journal proof and internal IPC |

These are internal server-side isolated interfaces, **not registered MCP APIs**. `openIsolatedStore(root,{profile,purpose:'isolated-pr1c-testing',lifecycle:{enabled:true,autoMaintenance:true},quotaBytes})` enables a new disposable lifecycle store. Options are strict; defaults are 64 pin sessions, 1 GiB physical hash union and 10 GiB quota. PR-1C stores without opt-in keep the old content-commit budget. Explicit opt-in on a legacy isolated fixture persists policy in the same Root; its original immutable quota/profile remain unchanged. A restart cannot disable an already persisted lifecycle by omitting options.

`commit(command,trustedActorContext,expectedEpoch)` is unchanged. Internal `maintenance(action,args)` accepts `compact`, `ledger`, `pin`, `readPin`, `history`, `renewPin`, `releasePin`, `checkpoint`, `dropCheckpoint`, `gcPlan`, `gcStep`, `backupStart`, `backupStep`, `backupCancel`, `backupRenew`, `verify`, `usage`, plus the isolated test `clock` control. Mutations use the existing FIFO coordinator queue and owned `flock` worker. `readPin` can run concurrently through held FDs; content commits cannot pass it a different camera, actor or authority. There are no Manifest/module or browser routes to these methods. Domain authorization must precede commit in a future authorized adapter; snapshot validation is not a Host authentication implementation.

## 3. Retention root rules

The six existing Root components remain registry, locator, ledger, commitIndex, retention and authority; `visual-registry/CURRENT.json` is the sole authority pointer. Root remains bounded to 64 KiB, COW pages to 4 MiB. All added policy/GC/backup metadata are hash-addressed dependencies of that Root.

- Current logical documents, every acknowledged historical logical version and archived documents remain reachable. No age-based user history deletion exists.
- Recovery keeps the current and at least one predecessor, plus recovery metadata observed within 24 hours. Clock rollback prevents aging. Old Registry catalogs remain permanently retained conservatively, with their own canonical historical Bindings.
- Each retained Registry/checkpoint resolver is atomically repointed to the new verified Locator root. Logical hashes are unchanged. A compacted historical view must use the retained Registry plus its current resolver, not arbitrarily republish an obsolete literal CURRENT whose old full locators have been replaced.
- Named checkpoints require explicit release. Releasing one does not delete logical history or an archived user document.
- Active reader sessions pin a consistent Registry/Locator pair, Root metadata and required physical files before read. Optional bounded `historyRefs` add explicit historical physical closure. A budget failure occurs before adding the session; physical hashes shared by sessions count once. Actual file handles prevent replacement/rename from invalidating an already active read.
- Paging expiry rejects new reads, but never closes an active server read. Release waits for quiescence. Runtime pins disappear only when that worker dies; restart does not treat stale runtime IDs as live. Durable checkpoint/backup roots remain protected across restart.
- No content transaction and destructive maintenance run concurrently through this single writer. Interrupted transactions are classified by committed membership during restart before GC can use terminal intent inventories.

Conservative boundary: all historic Registry/COW binding metadata and terminal GC/backup descriptors are retained; growth is accounted and admission can stop. Unattributed legacy PR-1C orphan files and atomic crash-temporary files without an exact durable inventory are retained rather than guessed to be garbage. Current intents inventory final staged paths; random per-file atomic temporary names are not automatically attributed by suffix. This safe but incomplete reclamation boundary needs a durable temporary-file inventory and fault qualification before a complete orphan-drain claim.

## 4. History archive and reconstruction invariants

A logical reference remains `{storeInstanceId,entityId,revision,contentHash}`. The hash is over canonical `StoredDocument`; bindings are materialized from the historical Registry's own canonical binding table. A document version is never rewritten to pretend it was created by another actor. Provenance, evidence, finding, verification, interaction intent, geometry and persisted undo entries remain ordinary losslessly preserved content.

New edits normally stage a small `estampes.lossless-patch/1` with exact from/to refs and `put/remove/splice` operations, then `estampes.history-delta/1` with chunk hashes, payload hash and length. Chunks are at most 4 MiB. A delta Locator links its base by stable logical reference, not by an obsolete physical filename. Reconstruction follows strictly earlier revisions of the same document/store, rejects cycles/missing bases and checks full anchor and every reconstructed target hash. It never retains an N×S map of full document versions.

Before/after history is reconstructable from the anchor plus ordered lossless deltas; it is distinct from the document's bounded fast-Undo entries and from recovery root retention. No TTL truncates logical history. `history` returns an internal StoredDocument for a ref explicitly included in that pin. Full historical documents with bindings are read with `pin({registryRootHash})` followed by `readPin`, using the selected Registry's own bindings.

The default archive anchor occurs when accumulated delta payload would reach 32 MiB. The content path emits a full operational checkpoint at document revision multiples of 1000, optionally carrying a verified alternate delta. Old operational full files can later be thinned only after alternate reconstruction verifies. The actual 32 MiB decision helper is unit-tested without changing that threshold; an end-to-end 1000-command checkpoint workload has not been executed.

## 5. Locator compaction algorithm

1. Read a fixed verified Root; order locator rows by document/revision. A persisted cursor selects one full representation per step.
2. Keep the first anchor or a required full checkpoint when no suitable smaller archive exists. For a known prior logical version, reconstruct before/after and build a hash-checked delta.
3. Stage at most 28 MiB of delta chunks, leaving room for metadata in the 32 MiB Root transaction budget. A partial preparation stores expected source-row hash, manifest hash and written chunk hashes; current full locator remains authoritative.
4. Resume only if the expected row still matches; a mismatch records conflict and retries instead of rebasing stale content. Partial chunk hashes are Root-protected and checked on reload.
5. Before replacing the locator, verify replacement closure and all logical hashes. Update locator, retained resolver pairs, policy, membership and journal metadata through the same coordinator publication.
6. Only the later GC transaction can reclaim a redundant full file. Reader/backup pins can postpone it indefinitely. A failed preparation never removes the full source.

Every publication compares actual CURRENT with the fixed before envelope before intent work and again before pointer publication. External drift fences the writer; a feature flag is not an authority transition. CPU/verification reads still scan historical metadata and reconstruct versions; bounded staging does not mean bounded total validation time. This is a measured performance limitation, not permission to skip integrity checks.

## 6. G1/G2 garbage collection behavior

| Class | Required proof | Removal behavior |
| --- | --- | --- |
| G1 | Current committed delta independently reconstructs the same full generation's logical hash; full path absent from all live physical roots/pins | No mandatory 24-hour grace; durable plan, quarantine/fsync, durable progress and re-mark precede unlink |
| G2 | File came from an exact terminal transaction staged inventory, or is a terminal journal with durable compaction/mismatch proof; unreachable from all retained roots | Quarantine for at least 24 hours under a non-rolled-back clock; revalidate again before unlink |

Plans are canonical hashed `estampes.gc-plan/1`, maximum 128 candidates, containing source root/generation, root-set hash, pin epoch and per-file exact path/hash/class/quarantine name. A plan's recorded root hash is audit evidence, not permission to ignore the newer Root. Planning and every step verify the live logical closure; active pins are rechecked. Input paths are closed to managed generation/archive/COW/journal namespaces. Legacy originals, raw migration data and arbitrary unknown files cannot be candidates. Symlink/device/path checks remain in ManagedFiles; native allowlists are unchanged.

States are `planned → quarantining → waiting-grace / complete`, with durable moved/deleted indices. Destination and source directories are fsynced after quarantine rename; unlink fsyncs its directory. Restart reads plans only through hashed CURRENT metadata, verifies quarantine hashes, restores a quarantined file if a committed locator or active durable backup still requires it, then resumes idempotent progress. A corrupt plan/quarantine, missing replacement or unexpected CURRENT causes read-only recovery, not a best-effort sweep.

Each GC step uses bounded candidate work plus separate coordinator-committed progress batches. The per-Root staging guard is ≤128 staged files and ≤32 MiB; this is not a bound on the entire store-verification scan or the aggregate time of a multi-batch operation. No duplicate is removed merely because its name or age looks old.

## 7. Ledger compaction and idempotency evidence

Full successful ACKs remain retrievable for seven days from acceptedAt. An identical retry during that window returns the original ACK, including result/commit IDs. At or after seven days, up to 16 entries per maintenance transaction become permanent compact tombstones with original key, payload hash, commit/result hash and acceptance time. A retry then returns `RETRY_WINDOW_EXPIRED`; a different payload under the same authenticated-principal key always returns `IDEMPOTENCY_MISMATCH` before OCC. Namespace never rotates to forget commands.

The key still uses stable authenticated owner/principal lineage and normalized request ID, not ephemeral execution ID. A persisted wall-clock high-water mark and legacy acceptance floor prevent rollback from prematurely aging ACKs or G2 quarantine. All records and locators are committed in the same Root.

Terminal journal GC requires matching intent namespace, authoritative CommitIndex membership, Ledger acceptance time/payload and outcome membership. Durable `journal-compacted` and `journal-key` records are published before old terminal files enter quarantine. Recovery accepts a missing committed intent only with a matching committed payload proof and rejects conflicting request proofs. Original missing-intent corruption tests remain unchanged. Ledger/key records survive backup/RO restore; writable stale continuation remains forbidden.

## 8. Quota/backpressure model

Default new lifecycle quota is 10 GiB, configurable within the existing isolated format's 128 MiB–10 GiB range; this is not an SLA. Admission uses actual `st_blocks×512`, deduplicated inode accounting, actual filesystem free blocks, estimated staged allocations/directories, intent/index overhead, outstanding reservations, active backup remaining bytes and a recovery reserve `max(64 MiB, ceil(1% quota))`. Ordinary content admission additionally leaves 32 MiB maintenance workspace. Pin-protected files are already counted in actual physical usage and are not double-counted as new copies.

Reservations are serialized inside the writer and released in `finally`. Backup destination also checks free-space reserve before start and copy steps. Backup progress uses bounded 4 MiB buffers, up to 28 MiB/64 completed files per step; source quota conservatively reserves remaining copy bytes even when destination is a different filesystem. Actual ENOSPC after preflight is still handled as an error, never as a complete manifest or content ACK.

Pressure/100 content commits/256 MiB full representations schedules maintenance before more content admission; active maintenance continues on subsequent FIFO writes. Repeated source conflicts backpressure content. Rejected commands keep their input draft and previous Root unchanged. Recovery/maintenance do not gain permission to delete unique history to make room. If recovery cannot publish safely it remains read-only.

Actual tests fill disposable files and exercise real coordinator admission; they do not fill a 10 GiB volume. Persistent tombstones, all historic registries and conservative descriptors consume quota permanently. Repeated history verification is CPU expensive; full quota/recovery-space worst cases remain unqualified.

## 9. Maintenance state machine

| State / condition | Allowed action | Observable outcome / recovery |
| --- | --- | --- |
| idle | content/pins/checkpoints/explicit maintenance | after threshold, policy schedules work |
| scheduled / compacting | one fixed-source compaction step, possibly pending chunks | committed cursor/hash inventory; resume after restart |
| source conflict | discard stale pending assumption, record conflict, retry current source | after repeated conflicts, reject more content until maintenance progresses |
| GC planned / quarantining | verify closure/pins, rename bounded candidates, commit progress | restart restores only required representations and resumes idempotently |
| waiting-grace | retain G2 or pinned candidates | no age advancement during rollback; owner can release pins |
| backup copying | fixed Root, hash inventory, bounded copy/progress | resume from committed offset; truncate uncommitted partial tail; renew or cancel |
| deadline/cancelled | wait active reader quiescence, release runtime pin and remaining reservation | partial artifact never becomes complete; source history remains |
| integrity/barrier failure | fail-stop coordinator in read-only-recovery | no content/maintenance mutation or ACK; inspect/fix/reopen verified volume |
| ENOSPC before publication | reject, preserve Root and draft; partial job stays resumable | space restoration/restart can retry; no unsafe automatic deletion |

The persisted policy uses idle/scheduled/compacting/conflicts/cursor/steps; GC/backup jobs carry their own progress. Failure diagnostics are fail-stop state, not a fabricated successful “failed-state commit” over corrupt metadata. If the Root cannot be trusted, no new Root is published just to mark a job failed. Runtime pin IDs are not durable job identities.

## 10. Backup and restore semantics

Supported scope is exactly `document-store`: full current/historical Document data, canonical historical bindings, evidence/provenance, logical locators/archives, recovery/checkpoint metadata, Ledger/tombstones, authority and terminal journal/key dependencies. `fullEstampes:false` and `binaryAssetsIncluded:false` are persisted in the complete manifest. Binary assets, notebooks, CAS, Surface/Workspace and legacy stores are not transactionally integrated; requests for full Estampes backup are explicitly rejected.

Start snapshots/verifies the source Root and pins its immutable physical closure. CURRENT bytes are captured from that snapshot, never reread from a later mutable CURRENT. The file index is hash-paged (≤1024 entries/page, ≤100 pages/100000 files). The destination must be owned, empty, outside the active store and match the platform profile. A destination owner token prevents accidental continuation into a different artifact. A read-only restriction marker is written before copied data can resemble an active namespace.

Copy uses a bounded buffer/byte budget, per-file checksum/file fsync/dir fsync, final complete-closure validation and **complete manifest last**. Later source commits cannot contaminate the captured snapshot. Durable source backup roots protect required representations even if a runtime pin expires; a renewed/resumed job reacquires handles from the durable file list. Deadline/cancellation release pins after active I/O quiescence. Partial artifacts stay explicitly incomplete.

Restore acquires an actual OS writer lease on a new explicitly empty target volume, checks all listed hashes and root/namespace/profile consistency, preserves namespace/Ledger, writes the restriction marker first and CURRENT last, and verifies the resulting snapshot. An active/nonempty target or corrupt/missing Ledger is rejected. No new writable namespace is invented.

All supported restores currently remain **read-only**: there is no approved proof that post-backup ACKs are absent or that the original Store has been fenced. A stale snapshot is useful for review/export, never advertised as current writable state. Writable continuation and full-system restore remain deferred prerequisites, not optional silent behavior.

## 11. Actual fault-injection and verification results

Final command/results are recorded in [execution manifest](evidence/pr1d-execution-manifest.json), with byte counts and SHA256 for verbatim logs (gzip storage; both decompressed-original and compressed-file hashes are verified). First failures are retained, not overwritten. Current results:

| Check | Command / result | Exit |
| --- | --- | --- |
| New lifecycle/fault/backup/capacity | Node 22 explicit four test files: **34 pass, 0 fail, 0 skip** | 0 |
| Complete sealed-source Node 22 suite | `CHROME_BIN=/usr/bin/chromium npm exec --yes --package=node@22 -- node --test --test-concurrency=1`: **438 total, 436 pass, 0 fail, 2 native skip** | 0 |
| Proposed contracts | `node --test .../contract-validation.spec.mjs`: **22 pass** | 0 |
| Formal examples | `node .../validate-contract-examples.mjs`: **9 valid, errors=[]** | 0 |
| CAS | `python -m unittest discover -s cas-service/tests -v`: **17 pass** | 0 |
| Docs / release | `npm run docs:check`; `npm run release:check` | 0 |
| Consistency / scope / historical hashes | `node .../check-consistency.mjs`; 95 hashes, old tests/native guard/evidence unchanged | 0 |
| New native prerequisite | explicit native probe: unsupported tmpfs, **BLOCKED**, no native run | **2** |
| Capacity/memory harness | real production store, four measured workloads; qualification remains blocked | 0 |
| Syntax / whitespace | Node 22 `--check` new/modified files; `git diff --check` / staged check | 0 |

New fault tests use actual production lifecycle code and disposable isolated stores. They cover process SIGKILL before/during quarantine and unlink, compaction before/after CURRENT publication, quarantine/plan corruption, changed CURRENT, missing replacement chunk, corrupt checkpoint Root, expired ACK/tombstone/journal compaction, clock rollback, checkpoint/GC/backup ENOSPC, incomplete backup process crash, missing restore Ledger, post-backup ACK and stale RO restore, concurrent readers/writer, maintenance progress and pin/deadline behavior.

First new-test failures included mixing G2 grace candidates into a G1 duplicate test; that fixture now explicitly selects G1 without changing G2 behavior. They also exposed (a) test setup that pinned only the current version while expecting an older candidate to be blocked, and (b) malformed persisted GC plan being reported as input validation without fencing. The former was corrected to explicitly pin historical closure and assert candidate exclusion; the latter was fixed in production to classify committed metadata corruption as integrity failure. No old test or expectation was changed. Terminal journal cross-check and renewed-backup pin reacquisition received additional regression tests. A documentation appendix initially reused the formal case-definition row prefix; consistency correctly rejected the duplicate case count. The appendix was relabeled as subsets, preserving all 67 original case definitions and the checker requirement. Two additional negative checks verify rejection of a forged source-seal hash and an unauthorized root file; temporary documentation fixtures were restored exactly. The first staged whitespace check rejected whitespace-only lines emitted by failed TAP assertions. Logs were losslessly gzip-encoded, retaining their exact original bytes/hashes, rather than normalized or exempted from checks. The full staged whitespace check then passed.

The first complete Node run had 436 tests: 427 pass, 7 fail, 2 native skip, exit 1. All seven failures were missing default Playwright browser executables. System Chromium 154 exists; the final run uses the existing `CHROME_BIN=/usr/bin/chromium` path without changing tests or package manifests. That first run overlapped source finalization and is not sealed final-source proof. The first attempted CAS pytest command failed because pytest is unavailable; the project's unittest command subsequently passed all 17. These are environment/command-selection failures, not erased test passes.

## 12. Native filesystem results and evidence limits

The current workspace is overlayfs; disposable temporary stores are tmpfs. The explicit native prerequisite probe returns `UNSUPPORTED_STORAGE`, exit **2**, status **IMPLEMENTATION BLOCKED**. The unchanged approved ext4/XFS guard was not bypassed or widened. Two pre-existing native-positive tests retain their explicit skip on this environment. Mandatory new-code native acceptance has **not been executed**.

Original WSL2 Ubuntu 24.04 `/dev/sdd` ext4 acceptance at base commit remains historical evidence of PR-1C functional behavior. The original serial 404-test result, native 61-case harness, earlier parallel failure logs and two binding regression tests are preserved byte for byte. They do not establish PR-1D native functional acceptance or physical power-loss safety. Application error injection, SIGKILL, VM/device fault injection and true host power loss are distinct; only the first two were run here.

## 13. Capacity and memory benchmarks

Reproducible harness: [pr1d-capacity-benchmark.mjs](evidence/pr1d-capacity-benchmark.mjs). Raw measurements: [capacity-benchmark-final.json](evidence/pr1d-logs/capacity-benchmark-final.json). Node 22.23.4, Linux tmpfs, actual isolated production coordinator, automatic maintenance enabled, disposable fixtures. Worker `/proc` VmHWM is sampled every 100 ms. The final run uses the sealed implementation commit after the complete suite finished. The earlier exploratory run overlapped verification/source hardening and remains separately preserved; no SLA or comparative speedup is inferred.

| Workload | Commands | Full / delta logical versions | Allocated bytes (all managed files) | Naive full-document sum bytes | Worker peak RSS MiB | p50 / max commit ms |
| --- | --- | --- | --- | --- | --- | --- |
| title-edits-128KiB | 12 | 1 / 11 | 1441792 | 1582465 | 126.7 | 2808.8 / 5009.3 |
| title-edits-1MiB | 8 | 1 / 7 | 1875968 | 8395003 | 181.7 | 9245.8 / 17760.4 |
| title-edits-8MiB | 4 | 1 / 3 | 8798208 | 33557627 | 527.8 | 40213.5 / 59633.3 |
| handwriting-64-points | 8 | 1 / 7 | 1019904 | 889867 | 154.1 | 5043.9 / 29092.3 |

The 8 MiB fixture retained one full anchor and three deltas with ~8.4 MiB allocated, rather than four ~8 MiB snapshots. Small handwriting has significant metadata/block overhead; its allocated usage exceeds the naive logical full-document byte sum. No universal compression ratio is claimed.

**Performance remains an exit blocker:** the 8 MiB fixture reached ~528 MiB worker RSS and ~59.6 seconds maximum commit time in the sealed-source run (the exploratory run was ~526 MiB / ~58 seconds) in this run. The loader avoids the old full-version N×S map, but repeatedly reconstructs and validates historical views; CPU/temporary canonical JSON allocation and permanent metadata growth remain expensive. These are real adverse measurements, not acceptable production budgets. Before exit, qualify/optimize the integrity-preserving verification path with focused profiling and rerun the full workloads. No integrity check was weakened to improve these figures.

Unexecuted: 10 GiB exhaustion/recovery, 100k strokes, default 64-reader/1 GiB stress, 1000-command operational checkpoint/thinning, long-history worst-case metadata and backup reservation pressure, native allocated-block growth/disk latency. Existing capacity/reader tests exercise smaller real limits and actual filesystem files; they cannot substitute for these gates.

## 14. Unsupported environments/features and remaining limitations

- No current approved native ext4/XFS mount; overlay/tmpfs/test stores cannot emit a durable-profile ACK or be promoted later to durable stores. Network/FUSE/unsupported mounts retain native rejection.
- No hardware power-loss, Docker backing-device durability certification or production activation.
- No binary asset/other-store integration, writable backup continuation, authenticated Host routes, Authority Cutover, old-binary mount fencing or real migration.
- No user history deletion API or automatic deletion of genuine content. Unknown staging/crash temporaries remain conservatively retained; full temporary-file attribution and drain are not implemented or claimed. Repeated preparation failures can therefore consume quota and reject later drafts safely.
- All historical Registry/binding metadata and GC/backup descriptors remain conserved; permanent tombstone/metadata growth can reach quota. No claim of constant lifetime storage usage is made for lossless history.
- Per-Root staged bytes/files and copy chunks are bounded, but whole historical validation scan/time and aggregate index materialization are not qualified at scale. GC candidate count is capped at 128 while terminal journal inventory/proof discovery still scans the store; large proof/index updates can be refused by the staging guard. Eventual drain at large history sizes is not proven: a cursor and bounded proof publication need qualification before claiming starvation-free maintenance. A large restart can also encounter the existing 30-second worker startup timeout; do not deploy this profile until measured large-history startup/recovery succeeds.
- Incomplete restore artifacts are preserved for inspection but cannot be overwritten/resumed automatically as an active store. Select a new empty destination for a fresh restore attempt.
- Canonical schemas and closure are enforced; domain edit authorization, lock policy and module grants still belong to future authorized adapters. No claim that internal commit itself authenticates a browser action.

## 15. Deferred PR-1B requirements

PR-1B is **not started or authorized**. It still requires separate approval, native and capacity PR-1D exit, trusted user-action/operation-specific authorization, mediating all legacy and Unified writes, explicit A0–A7 Authority Cutover commit, old-binary OS read-only fencing, source hash/alias preconditions, post-write rollback/export contract and complete cross-store/binary dependency integration. The internal `isolated-testing` authority record and lifecycle opt-in do not implement production cutover. Turning a feature flag off cannot transfer authority back to a legacy Store.

## 16. Safe rollback procedure

1. Keep existing Estampes operations on unchanged legacy storage. Stop the disposable lifecycle worker and any source/destination maintenance jobs; retain their volumes and evidence.
2. Preserve the full lifecycle store, CURRENT, archives, all Ledger/tombstones and job metadata. For inspection take a complete supported read-only backup to a new destination; do not delete raw/legacy/history data.
3. Disable the caller's isolated experiment or revert the code on a separate checkout. This does not make a lifecycle-written volume readable/writable by the old PR-1C binary: new delta/retention schemas are unsupported there and its writer must not be resumed on that volume.
4. Resume lifecycle recovery only with compatible code and the correct owned OS lease. A prepared Root is never adopted by filename, and a prior CURRENT must not be manually republished to erase acknowledged effects.
5. Production downgrade/cutover rollback is still PR-1B work with archive/export and fencing preconditions. No such rollback or data migration occurred in this task.

## 17. Explicit exit recommendation

**IMPLEMENTATION BLOCKED — preserve for engineering review; do not enable or proceed to PR-1B.**

The isolated lifecycle, real fault tests and evidence are committed within the explicit scope. Exit cannot be declared complete because new-code native ext4/XFS acceptance is unavailable, the actual capacity/memory/latency measurements do not justify a production storage profile, and full attribution/drain of random atomic crash-temporary files remains incomplete. Required next work is native rerun of all lifecycle/fault tests, durable attribution and fault-tested drain of temporary artifacts, integrity-preserving profiling/optimization, full workload/capacity/recovery qualification, and independent storage review. These are PR-1D gates, not permission to integrate early.

Stop after this branch's implementation/evidence commits. No push, merge, release, user-data migration, production writer or PR-1B work has been performed.
