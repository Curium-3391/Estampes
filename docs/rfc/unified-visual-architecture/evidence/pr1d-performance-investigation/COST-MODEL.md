# Execution cost and invariant map

CURRENT source: 616c73c6c4571cd9ebf9eea9e60e21882428b612, identical production
src to 29d097833688ddb649a88cb2a09f22ba5fadda8e. Paths are repository-relative.
N = retained logical versions, S = current Document canonical bytes,
D = unique physical dependencies in a verification observation. These are cost
variables, not claimed asymptotic classes. Actual counts are in measure JSONL.

## Commit path

| Stage / function | Executions and volume | Required invariant / measurement |
| --- | --- | --- |
| RPC admission: lease.js call → worker.js commit → coordinator.commit | one request; strict JSON inspection at client, worker payload and schema | finite bounded input, actor and revision; outer wall time includes IPC; `parse`/`assertJson` counters and CPU samples |
| Ledger/idempotency: coordinator.commit run | one stable-principal, command-key and payload hash; one Map lookup | same command/payload exact ACK; changed payload refused; replay skips publication |
| Lifecycle admission: LifecycleManager.admit | one per new content commit; autoMaintenance=false in matrix | preserve pin expiry/admission; no hidden compaction or GC |
| Build/preflight: coordinator.#publish | one staging plan, six PageStore.update; schema closure, old/new Document comparison | same revision/owner/OCC, complete references; PageStore.read/update/hashed, canonicalJson/parse and existing buildAndPreflightMs |
| Full/delta: stageDelta → VersionReadSession/readVersion | new version, previous record, canonical full and optional delta/chunks | exact from/to logical hash/bytes; no archive replacement without lossless proof; version/delta counters |
| Content hash/encoding: canonicalJson/hashJson, Hash.update | per input/content/page/ref; serialized volume counted independently from digest bytes | same durable canonical bytes and SHA-256; counts include metadata and protocol hashes |
| Stage/prepare: IntentJournal.intent, StagingPlan.flush, journal.prepare | one intent and prepared; immutable files plus exact temporary claims | intent before effect, each file/rename/directory fsync; fd.sync counts and stageAndPrepareMs |
| Candidate closure: verifyPreparedClosure → loadSnapshot | one new observation; six roots, all retained locators/catalog, membership, Ledger and temporary proofs | no skipped history, matching Registry/Locator; read/hash/stat/canonical/schema counters; candidateVerificationMs |
| Physical/content revalidation: cache.valid/registry, files.proofIdentity/verifyObservations | every reused path is content-verified in current observation; logical proof visits may repeat paths | metadata hints never stand in for bytes; proof invalidation/eviction fences or reconstructs |
| CURRENT publication: files.atomic with beforeRename=prepared.verifyObservation | one CURRENT temporary; rehash every observed dependency before rename | sole selected root, no drift, CURRENT parent fsync; currentPublicationMs |
| Post-publication: selected CURRENT, plan inventory digest, journal.outcome | one selected CURRENT read; every staged record digested | selected prepared root and exact outcome, preserve uncertain CURRENT |
| ACK boundary: prepared.verifyObservation after before-ack | third full boundary pass per successful content commit (candidate end, before rename, before ACK) | bytes/identity unchanged at supported boundary; no false ACK; postPublicationMs |

`buildAndPreflightMs` starts inside #publish: admission/command parse/payload hash
precede it. `currentPublicationMs` includes a full dependency rehash, not merely
rename/fsync. `postPublicationMs` includes a full dependency rehash, not merely
ACK serialization. Treat these as disjoint coordinator phases. Method timers
are inclusive descendants and cannot be added to those phase totals.

## Cold path

| Stage / function | Executions / volume | Invariant / attribution |
| --- | --- | --- |
| Parent inspectPlatform/privateLeaseTree, flock spawn, worker inspectPlatform/assertOwnedWriterLease | parent and worker checks, one lifetime lease | reject unsupported profile / second writer before mutation; client wall minus coordinator open includes transport/setup |
| CommitCoordinator.open → auditBoundary/recoverBootstrapTemporary | owned ancestry + tree, bootstrap claim inventory | safe private tree and exact bootstrap ownership; filesystem counters |
| Format/CURRENT and physical recovery: LifecycleManager.recoverPhysical → recoverQuarantine | selected GC plan / locations, no active GC in benchmarks | previously selected deletion ownership, restore live dependencies before reading; not a diagnostic operation |
| loadCommitted → loadSnapshot | all current roots, historical locator versions/catalog, Ledger/membership, temporary proofs | full retained-history verification; performance.open.verifyCommittedMs is this first load only |
| VerificationCache/VersionReadSession initialization | empty process-local proof/record/registry/prefix caches | no disk cache authority; budgets unchanged; misses/reconstructions/dependency counters |
| resync current.files and format | selected dependency list, each file+parent-directory barrier | re-establish file/directory durability after interrupted publish; resync and fd.sync counters |
| IntentJournal.recover + classifyTemporaryClaims | all journal dirs, claims and relevant selected histories | committed effects match selected membership, prepared != selected; journal method timer; claim-specific time not independently separated in initial matrix |
| #publish recovery-epoch | full build/stage/candidate/publication/post sequence | new authority epoch, classifications under selected root; six-root transaction; existing phase timings |
| LifecycleManager.onOpen / worker ready response | install pins/capacity/GC/backup runtime state; no active pins in benchmarks | fresh reader state, restricted backup stays read-only, ready only after recovery |

Direct cold probe and cold client each execute real recovery and publish a new
epoch. They have separate observations/caches. Their stores differ by one recovery
epoch; they are not duplicate timing samples of identical bytes. Cold client
keeps 30 seconds; direct probe cap 60 seconds is an independent diagnostic limit.

## Metrics and limits of attribution

- `measure-PID.jsonl`: operation wall time, process user/system CPU, heapUsed,
  heapTotal/external/arrayBuffers, HWM RSS; method counts/time; hash update bytes;
  canonical calls/output bytes; schema entry counts. Builtin lstat, readdir,
  statfs, open and FD stat/read/readFile/sync counts count actual API calls.
- `fd.read` and `fd.readFile` count logical bytes returned, including re-reads.
  They are not uncached block-device bytes. No kernel cache drop is attempted.
- `cpu-PID.json.gz`: 10 ms V8 sampling. Native lstat/fstat/open/read, application
  validators and GC samples support rankings. Idle samples are excluded from CPU
  explanations; process CPU is separately measured.
- `heap-PID.json.gz`: 1 MiB sampling of retained objects at stop, with allocation
  sites. Not cumulative allocated bytes and not a transient peak. RSS HWM and
  operation memory samples bound different quantities.
- Individual guards and schema transforms overlap: canonicalJson contains its
  assertJson; schema.parse contains bounded/jsonSchema transforms. Counter bytes
  are repeated work volume, not unique store data. Per-stage CPU/syscalls and
  allocation are not independently resolved by initial matrix; no values are
  fabricated. Focused phase counters can be collected separately.
- `runs.jsonl` supervisor records aggregate process HWM (including parent/direct
  probe) and tree RSS. Worker rows contain per-worker HWM. Both are retained.
- Actual profiles rank this tmpfs workload. Native ext4 fsync/storage wait and
  the exact 171-ACK/1500 s failure remain a distinct measurement gap.
