# PR-1D Integrity Hardening Report

2026-11-03 (Asia/Taipei). **Integrity Remediation Candidate Ready. PR-1D Overall BLOCKED.** All three independently reproduced Round 2 defects pass the available process-crash regressions. Independent native reacceptance, capacity qualification, stable large-document memory budgets and revision-1000 checkpoint qualification remain open. This report does not authorize production storage or PR-1B.

## 1. Exact baseline, ancestry and authorization

Required source branch `codex/pr1d-native-reacceptance-round2` was explicitly fetched and resolved to **`a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0`**. The initially clean checkout was on `work` at main `7fb9b73442401fc32a7034888deaf49303e582a6`; the requested source was selected before any implementation. The remote refspec initially tracked main only, so an explicit remote-tracking ref was fetched. No baseline discrepancy, merge, rebase or overwrite occurred.

Independent branch: `fix/unified-visual-architecture-pr1d-integrity-hardening`. Ancestry checks include `322038b4`, `c090d93`, `05913e9`, `88d8928`, `58f7789` and `26a51e6`. The main-to-source difference contains the prior UVA implementation and evidence; main itself was not treated as containing UVA. `88d8928..a33fe41` changes no `src/`, `server.js` or `public/` bytes: Round 2 was validation/evidence only.

The uploaded task authorizes isolated integrity repairs and performance remediation. The separate chat instruction **“完成後push”** authorizes branch push. See [authorization](evidence/pr1d-integrity-hardening/AUTHORIZATION.md). Historical authorizations and reports remain unchanged. The consistency checker now recognizes this separate, fixed 11-path source/test scope and verifies old native seals against their original commits rather than requiring remediated files to remain frozen forever.

The [baseline SHA-256 manifest](evidence/pr1d-integrity-hardening/baseline-sha256.json) seals **697 preexisting files** before modification. The [source seal](evidence/pr1d-integrity-hardening/source-seal.json) independently compares those hashes to Git objects and the final tree. Existing tests, historical reports, original failing regressions, deployment/package files and the platform guard remain unchanged. All runtime changes are confined to eight isolated persistence modules.

## 2. Fresh-session map and preserved invariants

The concise [handoff map](evidence/pr1d-integrity-hardening/HANDOFF-MAP.md) records source functions, evidence, environment and authorization. The lifecycle contracts, Final Architecture Gate, authority cutover contract, implementation/native/remediation reports, Round 2 logs/scripts, relevant RFC/ADRs and test/risk/traceability entries were inspected.

Preserved: sole CURRENT and six-root publication; complete logical history and canonical historical bindings; permanent Ledger identity/tombstones and exact ACK replay; real OS flock; file/directory fsync barriers; fixed-root reader/backup dependencies; G1/G2 separation, 24-hour G2 grace and clock rollback protection; bounded proof accounting and eviction. No timeout, platform allowlist, document schema or existing expectation was relaxed.

## 3. Original red reproductions

An exact baseline source copy, separate from the working tree, used real persistence code and owned disposable stores. Because native ext4/XFS is unavailable, only the test fixture profile and paired persistence/durability expectations were adapted to `linux-process-crash-test` / `memory` / `process-crash-test`. Original repository scripts and assertions were preserved.

| Baseline reproduction | Observed result | Exit / evidence |
| --- | --- | --- |
| Original `cache-ack-race-v2` sequence and required injection marker | False process-crash ACK; CURRENT advanced; cold validation found corruption | 1; [red-cache.log](evidence/pr1d-integrity-hardening/red-cache.log) |
| Round 2 forged/unpublished prepared Root | Writer incorrectly reopened ready | 1; [red-storage.log](evidence/pr1d-integrity-hardening/red-storage.log) |
| Round 2 warm missing quarantine | GC incorrectly reached complete without preexisting unlink intent | 1; same log; two selected cases, two failures |

These reproduce the integrity decisions without claiming a durable-profile ACK on tmpfs. Historical WSL2/ext4 red evidence remains the independent native evidence, unchanged.

## 4. R2-H03: coherent verification observations

Root cause: verified content and a later pathname stat were unrelated observations. An intervening rewrite could make the cache associate old valid bytes with a new corrupt file's fingerprint.

Managed reads now open with `O_NOFOLLOW`, compare pre-open pathname identity with the opened FD, read from that FD, then compare FD and pathname identity/size/timestamps after reading. Cryptographic hashes and canonical JSON/schema checks still verify the actual bytes. Streaming digest uses the same coherent identity protocol. A scoped observation records the fingerprint belonging to those bytes; cache proof creation must use that observation, rather than inventing one from a later stat.

Every complete verification operation has fresh observation, metadata and prefix caches. Reused fingerprints are checked within that operation; all observed dependencies receive fresh checks at its end and around CURRENT publication/ACK. A changed observation fences the writer. No active-tampering retry loop was introduced. Shared fingerprint changes invalidate all dependent proofs. The persistent in-memory proof budget remains 4 MiB; it is not a process-memory budget.

Coverage includes the original post-JSON-read injection with a required marker; replacement before/after open; same-inode rewrite; inode replacement; size, mtime and ctime changes; failed proof insertion; previously cached and shared dependency invalidation; cold corruption; repeated valid commits; eviction; and isolation from a previous operation's metadata cache.

Evidence boundary: hashes establish content identity and FD/path comparisons establish the observed physical relationship. `fstat` alone is not an immutability guarantee. This remains a private managed-tree, single-writer design using trusted kernel metadata; it does not claim resistance to a privileged attacker rewriting authority records or suppressing filesystem change evidence, nor certify a global atomic snapshot against an indefinitely hostile external writer. Native filesystem timing and durability remain independent gates.

## 5. R2-H01: historical selection evidence

Root cause: internally valid prepared Root + matching membership fields proved preparation, not selection. The forged Root was never referenced by authoritative CURRENT, yet the old check accepted it.

A compatible optional `estampes.selected-current-proof/1` is now stored in the existing `TemporaryRecovery` descriptor under the sole CURRENT retention root. It is first established only when the candidate's exact envelope is the selected CURRENT. The descriptor binds original claim ID, owner, exact final/temporary paths, hash and byte length. A later supersession must match that previously selected descriptor and exact envelope, as well as authoritative membership and the original prepared Root. Prepared existence alone has no authority.

Required prepared/root evidence is included in the verified/protected closure while the live classification needs it. GC subsequently owns the exact descriptor through its selected hashed disposition plan. Neither mechanism republishes old CURRENT or changes original Ledger/ACK identity.

Old stores are not assigned fictional publication history: a superseded classification lacking the new proof is rejected. Ordinary old stores without unresolved superseded claims still read normally. This conservative compatibility boundary is tested explicitly and requires compatible inspection/repair when old evidence is absent. A self-consistent alternate Root, missing/corrupt prepared evidence and forged paired claim/prepared data all fail closed. Genuine publication followed by supersession, repeated recovery epochs, subsequent content ACK and exact retry remain green.

## 6. R2-H02: deletion authorization precedes absence

Root cause: quarantine/missing-source paths could directly become deleted, or a fresh unlink intent could retroactively justify a file already missing.

GC now validates the **old selected progress** and every exact candidate location/hash/length before changing progress. Missing source or quarantine is rejected unless the previous selected record already contains matching unlink authorization or terminal deletion. Before a new intent, candidate presence/hash/length and live dependencies are checked again. The intent becomes durable through CURRENT, live dependencies are re-marked, then exact unlink runs with ENOENT disallowed for a newly authorized deletion. Directory fsync precedes terminal progress. A recovered prior unlink can resync directory metadata and complete without retroactive authorization.

A terminal plan describes its old copy; it does not reserve a content-addressed pathname forever. Later transactions may recreate the same source before or after terminal GC. Both copies are hash/length checked when present, live-root re-marking protects the new source, and the old plan never acquires deletion authority over that new source. Two additional positive regressions verify reopen, exact ACK replay and GC after quarantined/terminal path reuse. While a later source remains live, the old quarantined duplicate can conservatively wait; reclaiming that duplicate is not a newly qualified drain guarantee.

Cold recovery applies the same generic location checks, in addition to temporary-disposition ownership checks. Warm integrity failures now return `RECOVERY_REQUIRED` and fence the writer. Tests cover missing source before quarantine, missing quarantine before intent, crash before/after intent and after unlink, repeated restart/terminal GC, tampering, old H-02 cases, grace/clock rollback, reader/backup pins and serialized content/GC activity.

## 7. Files and commits

Implementation commits remain separated:

- `6fc40c5`: coherent FD/content/fingerprint observations and original cache-race regression.
- `b716875`: selected CURRENT proof and normal-discovery Round 2 regression adaptation.
- `6b5f77c`: warm/cold GC authorization ordering, presence/hash/length validation and fail-stop classification; also narrows storage-observation error fencing so ordinary invalid revision input keeps its original behavior.
- `c09d9e7`: bounded verified-prefix reuse, canonical identities and strict-schema-preserving allocation reductions.
- A separate follow-up GC commit, recorded as `implementationHead` in [source-seal.json](evidence/pr1d-integrity-hardening/source-seal.json), preserves legitimate later pathname reuse. Final audit reproduced an overstrict new location check rejecting a later valid commit; the follow-up includes both quarantined and terminal positive regressions. This extra commit keeps that correction independently reviewable.
- Final evidence/report commit follows; its SHA is provided by Git, avoiding self-reference here.

Runtime files: `filesystem.js`, `records.js`, `temporary-attribution.js`, `gc.js`, `lifecycle.js`, `archive.js`, `pages.js`, `coordinator.js`. New tests: `persistence-integrity-hardening.test.js`, `persistence-verification-race.test.js` and its root-scoped preload fixture. Existing test files are byte-identical to baseline. Documentation changes are this report, the evidence directory and the narrowly extended consistency checker.

## 8. Performance implementation and profiling

Profiling confirmed repeated full-string canonicalization, strict-schema JSON transforms and historical delta-prefix replay. The fixes preserve the same hashes, schemas and barriers:

- A single complete verification operation shares already hash-checked prefixes for one fixed Locator. A 24 MiB record budget and 4 MiB path-reference budget evict reusable work safely. Warm seeding uses only records whose existing proofs were validated in that operation.
- Every reconstructed transition checks payload from/to identity, target hash and exact byte length. Independent reconstruction remains available without the operation cache.
- Hash-verified metadata sharing is bounded to 4 MiB per operation. A new operation cannot inherit prior metadata trust.
- Full generation JSON is read once; its verified canonical hash/length can be reused. Transaction staging reuses the same encoded stored representation for hash, length and serialization.
- Equality on already validated finite JSON avoids serializing unchanged multi-MiB strings. Complete closure validation still performs the strict Document schema checks; its returned parsed copies replace a redundant pre-closure parse. A self-consistent stored envelope containing an invalid Document remains rejected.

The measurements use performance commit `c09d9e7`; the later GC-reuse correction affects existing GC plans, which these autoMaintenance=false workloads do not create. The [isolated paired runs](evidence/pr1d-integrity-hardening/qualify.sh) used Node 22.23.4, identical one-worker workloads, tmpfs disposable stores, no concurrent test suite, autoMaintenance=false, and the unchanged 30-second client deadline. OS page cache was not dropped. CPU counters are worker `/proc` user/system time at 100 ticks/second, including the selected worker's startup/commit activity. These are single-run observations, not approved production budgets.

| Workload | Baseline | Candidate |
| --- | ---: | ---: |
| 100 commits: cold client startup | 8.365 s | 2.804 s |
| 100 commits: cold worker user / system CPU | 5.250 / 3.080 s | 2.210 / 0.980 s |
| 100 commits: total commit latency | 77.533 s | 72.312 s |
| 100 commits: maximum commit latency | 1.850 s | 1.632 s |
| 8 MiB, four commits: maximum latency | 7.811 s | 3.248 s |
| 8 MiB: total commit latency | 27.754 s | 12.716 s |
| 8 MiB: cold client startup | 14.228 s | 7.486 s |
| 8 MiB: warm worker user / system CPU | 26.740 / 1.250 s | 12.260 / 0.530 s |
| 8 MiB: uninstrumented worker peak RSS | 588,188 KiB | 432,884 KiB |

Exact artifacts: `isolated-baseline-100.json`, `isolated-candidate-100.json`, `isolated-baseline-8mib.json`, `isolated-candidate-8mib.json` in the evidence directory. They include all phases, reconstruction counters, physical fingerprint checks, proof budgets, usage and exact replay results. Earlier exploratory series overlapped validation and are retained; they are not used for causal wall-time comparisons.

The separate identical 8 MiB Inspector pair estimated cumulative sampled allocation **3.775 GB → 1.518 GB** (about 60% lower), canonical calls **1,838 → 1,779**, hashJson calls **931 → 865**, and managed-byte reads **271 → 232**. Managed `info` calls increased **175 → 1,143** because the new integrity protocol deliberately performs stronger physical checks. Counters are profiling-only function-entry observations; actual parser/hash/filesystem/durability decisions remain production code.

Memory qualification stays open: instrumented peak RSS moved **426,328 → 486,364 KiB**, and sampled peak heapUsed **273,415,688 → 307,537,960 bytes**, despite lower cumulative allocation. V8 collection/heap expansion and sampling affect peaks. The uninstrumented pair's lower RSS is an observation, not proof of a stable memory ceiling. Raw lossless profiles, allocation sites, CPU samples, I/O counts and limitations are in [profile-summary.json](evidence/pr1d-integrity-hardening/profile-summary.json).

## 9. Controlled history and scale gates

| Candidate step | Cold startup | Peak worker RSS | Historical versions / exact replay |
| --- | ---: | ---: | --- |
| 25 commits | 1.100 s | 165,736 KiB | 25 / pass |
| 50 commits | 1.464 s | 170,708 KiB | 50 / pass |
| 100, exploratory concurrent-load run | 11.415 s | 182,044 KiB | 100 / pass |
| 100, isolated paired run | 2.804 s | 184,612 KiB | 100 / pass |
| 200, controlled run | 5.990 s | 213,304 KiB | 200 / pass |

The 200-step run was admitted only after the 100-step recovery/memory measurements showed headroom. Its commits took 406.968 s with concurrent qualification activity; this is not an isolated throughput comparison. Automatic maintenance was intentionally disabled to measure retained history. The backlog was visible as scheduled maintenance, 200 content commits, zero drain steps. At 200, the proof budget stayed at **4,188,999 / 4,194,304 bytes** with safe evictions; cold verification used 270 delta applications after evictions rather than claiming every prefix would remain cached forever.

**1,000 commits and the revision-1000 operational checkpoint were not executed.** Smaller runs do not establish enough end-to-end resource/maintenance headroom to close that gate; the ten-minute controlled commit budget and 30-second startup deadline were not increased. Capacity/drain-rate qualification, default 64-reader/1 GiB stress, 10 GiB exhaustion, 100k strokes and full backup pressure remain BLOCKED. No numerical extrapolation is reported as a pass.

## 10. Verification results and failure handling

All exact argv, start times, source/test hashes, exits and raw-log hashes are in [runs.jsonl](evidence/pr1d-integrity-hardening/runs.jsonl). Final source/test preservation and log/artifact integrity are recorded separately in the source seal and manifest.

| Verification | Result |
| --- | --- |
| Final sealed Node 22 complete serial suite, Chromium enabled | 486 total: 484 pass, 0 fail, 2 native skips; Exit 0 |
| Persistence-only run before final allocation refinements | 146 total: 144 pass, 0 fail, 2 native skips; Exit 0; final refinements are covered by the sealed full suite |
| Original H-01 script, unchanged, supported profile | 2/2 pass; native variants remain unavailable |
| Preserved Round 2 scripts via profile-only replay harness | 23/23 pass, zero skips; original ACK-race injection marker required |
| Focused final strict-schema, scope, cache and binding run | 24 total: 23 pass, 0 fail, 1 native skip |
| Proposed contract validation | 22/22 pass; Exit 0 |
| Nine formal examples | 9 valid, zero errors; Exit 0 |
| CAS Python unittest | 17/17 pass; Exit 0 |
| Docs, release, architecture consistency, baseline preservation and whitespace | Exit 0; see final logs and manifest |

Commands include `node --test --test-concurrency=1` (final log: `delivery-node22-serial.log`), the original H-01 evidence script, `prepare-replay.py` plus the three Round 2 scripts, `contract-validation.spec.mjs`, `validate-contract-examples.mjs`, `python3 -m unittest discover -s cas-service/tests -v`, `npm run docs:check`, `npm run release:check`, `check-consistency.mjs`, `verify-preservation.py` and Git whitespace checks. Node test execution explicitly uses Node 22 rather than the default Node 24.

Chromium 154 and Playwright Core 1.56.1 were available for actual fake-host browser assertions; no browser case is represented as passed merely because its dependency was missing. Playwright Core was added only as a node_modules symlink to an npm-cache installation; package and lock files remain unchanged. CAS used existing locked SymPy 1.14.0/mpmath 1.3.0. Browser tests are not live ChatGPT Host acceptance.

Development failures are retained: the first after-open boundary fixture hid its mutation behind its own saved stat and was corrected to inject before the real pathname observation; an initial GC run returned INTEGRITY_ERROR instead of the required RECOVERY_REQUIRED and prompted explicit maintenance fencing; an early profiler used a file-URL string as a pathname; another instrumented baseline cold reopen hit the unchanged 30-second deadline under concurrent load. The corrected isolated profiles measure warm work only, and independent uninstrumented cold startup is measured separately. These failed runs are not converted into passes. Final audit also reproduced an overstrict terminal-GC source-reuse rejection (`terminal-reuse-red.log`), then validated both reuse phases. Earlier green full runs are preserved with their exact inputs; `delivery-node22-serial.log` is the final-source result.

## 11. Remaining integrity and native gates

- Native ext4/XFS reacceptance of all original H-01/H-02/Round 2 fault cases remains required. Checkout is overlayfs and stores are tmpfs; neither can emit native durable-profile ACKs. Two native-positive tests explicitly skip.
- No VM/block-device/physical power-loss or host flush certification was performed. SIGKILL and injected EIO/ENOSPC/EXDEV retain their narrower evidence boundaries.
- Old unresolved superseded claims without trustworthy selected proof fail closed; missing evidence must be inspected, not invented or bypassed by deleting claims.
- Large-document transient allocation is improved, but stable peak memory, long-history checkpoint/maintenance and full capacity gates remain unqualified.
- The store remains Document-only, with existing backup read-only continuation restrictions. Host authentication, cross-store/binary integration and old-binary deployment fencing are outside this task.

## 12. Reproduction and evidence integrity

Use a new output directory or unique run names: `run.py` refuses existing log names. Reconstruct the baseline with `prepare-baseline.py <repo> <new-directory>`. Use `prepare-replay.py <repo> <new-directory>` for a source-linked process-crash replay; [replay-hashes.json](evidence/pr1d-integrity-hardening/replay-hashes.json) records the precise fixture transformations. Real native reacceptance must instead run the unchanged original scripts on an approved owned disposable ext4/XFS mount.

`qualify.sh <Node-22-executable> <baseline-directory>` documents the isolated paired workload and sealed serial suite. Profile counters are explicitly opt-in and root/source scoped. Profiled warm-only results do not claim cold recovery or retry qualification. Raw profiles are losslessly gzip-compressed with both raw and stored hashes. Verbatim logs preserve TAP whitespace through directory-scoped attributes; source/report whitespace checks remain enabled. Original evidence directories are untouched.

## 13. Safe rollback

Keep production on the unchanged legacy writer. Stop disposable workers and preserve their complete stores, CURRENT, claims, GC plans, quarantine, history and Ledger. Revert the GC-reuse follow-up, performance, GC, publication-proof and coherent-read commits in reverse order on a separate checkout if needed. Do not run an older strict-format writer on a store containing new proof descriptors, delete evidence to unblock startup, republish an old CURRENT or reset the request namespace. Use compatible read-only inspection/export, or retain the entire store for repair. No user-data rollback/migration is involved in this isolated task.

## 14. Recommendation

**Integrity Remediation Candidate Ready** for independent native reacceptance: the three Round 2 integrity failures are repaired and all supported regressions pass, with no observed existing-test regression.

**PR-1D Overall BLOCKED** pending native reacceptance, stable performance/memory and capacity profiles, revision-1000 checkpoint/recovery, and the remaining deployment/safety gates. Push this independent branch for review as explicitly requested; do not merge main, enable production storage, migrate data or begin PR-1B.
