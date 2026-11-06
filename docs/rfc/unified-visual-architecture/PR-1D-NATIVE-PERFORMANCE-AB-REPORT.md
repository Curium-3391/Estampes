# PR-1D Native ext4 Performance A/B Adjudication

2026-11-06 (Asia/Taipei). **INCONCLUSIVE — DEFAULT TO BASELINE.**

**PR-1D ENGINEERING EXIT BLOCKED. PRODUCTION NOT QUALIFIED.**

This is a recommendation. Candidate B remains intact on its original branch and in the ancestry of this independent evidence branch. No production implementation, assertion, timeout, cache limit, main branch, PR-1B or Unified Writer activation changed.

## Verified comparison and immutable protocol

- Baseline: `d9aaa49f27d195ed53baeb12e95e434f1a7b10b0`.
- Candidate: `4814daf2378e9619f171c02a65792062957a8e99`.
- Candidate descends from baseline. All 1,806 pre-existing paths match except `src/documents/validation.js`: the intended synchronous jsonSchema Optimization B. A is absent, C unimplemented, original G2 hook/tools, negative assertions, reports and failure evidence are unchanged.
- Evidence branch: `codex/pr1d-native-performance-ab-adjudication`. Separate clean detached baseline/candidate worktrees, each with independent offline `npm ci --ignore-scripts --offline` (exit 0). No Store or generated cache copied between variants.

The [protocol](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/PROTOCOL.md) was committed before any workload in `88f9c37b021731a779bbbb02cc24d7e67e9bf212`; [execution start](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/execution-start.json) records its SHA-256. Delivery integrity checks require byte-for-byte equality. No acceptance threshold, count, sample exclusion or deadline was revised after seeing timings.

The twelve plain attempts use the frozen benchmark bytes. Static review identified a direct-helper argv incompatibility with the original profiling preload. Only after all plain attempts, the idle supervisor was paused and the direct-helper argument order corrected for the separately declared profiles. [Adapter note](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/PROFILE-ADAPTER-NOTE.md) and per-case harness hashes retain this boundary; no plain sample was rerun.

## Exact native environment and safety

Ubuntu 24.04.1 LTS; kernel `6.6.87.2-microsoft-standard-WSL2`; explicit Node `v22.23.4`; `estampes` UID/GID 1001; util-linux flock 2.39.3. Worktrees and independently created private 0700 Stores are on `/dev/sdd`, ext4, device 8:48, `rw,relatime,discard,errors=remount-ro,data=ordered`, statfs magic `0xef53`. findmnt, mountinfo and statfs agree. Native `linux-local-durable` executes actual lifetime flock, regular-file and directory fsync; ACKs are `durable`. Process-crash evidence does not establish host/VM/device power-loss qualification.

Intel CC150 @ 3.50 GHz, 16 logical CPUs; about 7.72 GiB RAM and 2 GiB swap. Actual `/init.scope` cgroup is CPU `max 100000`, memory/swap `max`, pids 9475; there is no imposed two-CPU quota. Initial available RAM about 7 GiB and ext4 available about 951 GiB. Supplemental Windows free space: C 63,471,886,336 bytes, D 722,763,522,048, E 111,390,863,360, G 60,298,289,152. This differs from the earlier tmpfs runner and prevents treating its latency as native acceptance.

The frozen supervisor permits one workload at a time, 1.5 GiB per-process HWM, 3 GiB concurrent tree RSS, >=2 GiB available RAM, >=48 GiB free ext4, <=512 MiB allocated scratch per benchmark, <=4 GiB total scratch, <=256 host processes and <=24 case descendants. Polling is 200 ms, allocation 5 s; these are sampled guardrails. Document cap 180 s, history 900 s, unchanged cold-client deadline 30 s, direct recovery cap 60 s, total execution cap 7,200 s. Native regression cap is 2,400 s. See [environment](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/environment.json), [resource supplement](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/resource-supplement.json) and [exact commands/environments/exits](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/runs.jsonl). Concurrent process snapshots include Codex and OS services; there were no concurrent baseline/candidate workloads.

## Workload controls and native latency

Deterministic original document(1) fixture IDs, ASCII x extension strings and original 100-command revision/title/request/actor sequence; durable Document persistence; autoMaintenance:false; no active readers or backup. Original 24 MiB record, 32 MiB registry and 4 MiB proof cache defaults. No warmup and no kernel cache drop. Cold denotes a fresh JS client/worker; Linux page cache remains warmable. The unchanged original sequence includes direct leased recovery before cold client; it publishes a recovery epoch, so these are different operations, not repetitions. Commands and Documents are hashed outside measured commit intervals, both variants must match exactly.

All 12/12 plain attempts have terminal receipts. Successful full workloads: 11/12; successful pairs: 5/6. A timeout remains a terminal failure, not a missing sample. No performance retries or exclusions.

| Workload / pair | Order | Commit s B → C | Change | Cold client s B → C | Change | Exit B / C |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| document-8-pair-1 | B -> C | 5.194 → 4.637 | -10.7% | 4.370 → 3.957 | -9.4% | 0 / 0 |
| document-8-pair-2 | C -> B | 5.054 → 5.205 | +3.0% | 4.182 → 3.500 | -16.3% | 0 / 0 |
| document-16-pair-1 | B -> C | 9.268 → 11.827 | +27.6% | 7.543 → 8.442 | +11.9% | 0 / 0 |
| document-32-pair-1 | B -> C | 20.811 → 17.205 | -17.3% | TIMEOUT 30.019 → 14.913 | n/a | 1 / 0 |
| document-32-pair-2 | C -> B | 19.310 → 17.178 | -11.0% | 17.218 → 14.938 | -13.2% | 0 / 0 |
| history-100-pair-1 | C -> B | 668.662 → 591.299 | -11.6% | 17.224 → 16.473 | -4.4% | 0 / 0 |

Positive changes mean regressions. All direct recovery, original client failures, ACKs, selected CURRENT identities, transaction diagnostics and verification outcomes are retained per case. Random Store UUIDs, commit IDs and timestamps make independent Root identities differ; exact logical Document/stored-record hashes and within-Store CURRENT consistency are the parity requirements.

## CPU, memory and capacity

| Workload / pair | Worker commit user/system s B → C | Cold ready worker user/system s B → C |
| --- | --- | --- |
| document-8-pair-1 | 4.64/0.62 → 4.00/0.69 | 3.92/0.56 → 3.61/0.54 |
| document-8-pair-2 | 4.56/0.59 → 4.02/0.60 | 3.99/0.53 → 3.39/0.41 |
| document-16-pair-1 | 8.57/0.97 → 8.17/1.04 | 7.20/1.01 → 7.99/1.11 |
| document-32-pair-1 | 19.49/2.35 → 15.45/2.28 | NOT READY → 14.47/1.86 |
| document-32-pair-2 | 18.32/2.02 → 15.98/2.00 | 17.01/1.90 → 14.53/1.85 |
| history-100-pair-1 | 225.55/256.21 → 230.28/267.32 | 9.48/9.09 → 8.87/8.53 |

Worker CPU is actual /proc user/system ticks, 100 Hz on this host. Commit rows are interval deltas; cold-ready rows are worker lifetime CPU including module bootstrap. Parent CPU deltas remain in raw commit events. These are not device I/O or exclusive substage CPU attributions.

| Workload / pair | Warm worker HWM MiB B → C | Cold-startup peak worker HWM MiB B → C | Peak worker HWM MiB B → C (change) | Peak process HWM MiB B → C (change) | Peak tree RSS MiB B → C (change) |
| --- | ---: | ---: | ---: | ---: | ---: |
| document-8-pair-1 | 271.6 → 327.3 | 284.4 → 192.2 | 284.4 → 327.3 (+15.1%) | 314.2 → 327.3 (+4.2%) | 455.8 → 510.5 (+12.0%) |
| document-8-pair-2 | 327.7 → 327.1 | 284.6 → 193.3 | 327.7 → 327.1 (-0.2%) | 327.7 → 327.1 (-0.2%) | 544.1 → 529.7 (-2.6%) |
| document-16-pair-1 | 433.0 → 433.2 | 428.4 → 424.6 | 433.0 → 479.7 (+10.8%) | 433.0 → 487.3 (+12.5%) | 742.2 → 645.4 (-13.0%) |
| document-32-pair-1 | 788.0 → 799.8 | 520.9 → 489.9 | 788.0 → 799.8 (+1.5%) | 788.0 → 799.8 (+1.5%) | 942.6 → 1110.0 (+17.8%) |
| document-32-pair-2 | 574.2 → 638.6 | 489.6 → 489.2 | 574.2 → 638.6 (+11.2%) | 762.6 → 638.6 (-16.3%) | 981.1 → 806.0 (-17.8%) |
| history-100-pair-1 | 127.1 → 129.1 | 114.2 → 116.7 | 127.1 → 129.1 (+1.6%) | 127.1 → 129.1 (+1.6%) | 196.0 → 200.2 (+2.1%) |

Kernel HWM is cumulative for a worker, and overall worker peaks can include exact replay after cold-ready. Tree RSS is simultaneous sampled resident memory and double-counts shared pages. Parent HWM includes deterministic input hashing and final verification, so it is not a production worker-only claim. All operation-end heap/external samples and sampled retained allocations are reported only for separate profiles, not as plain-run interval maxima.

| Workload / pair | Final allocated bytes B → C | Final files B → C |
| --- | ---: | ---: |
| document-8-pair-1 | 8671232 → 8671232 | 57 → 57 |
| document-8-pair-2 | 8671232 → 8671232 | 57 → 57 |
| document-16-pair-1 | 17059840 → 17059840 | 57 → 57 |
| document-32-pair-1 | not fully verified → 33837056 | not fully verified → 57 |
| document-32-pair-2 | 33837056 → 33837056 | 57 → 57 |
| history-100-pair-1 | 29409280 → 28798976 | 6392 → 6265 |

Warm capacity is also retained even when cold startup fails. Physical metadata bucket counts differ across independently randomized Stores; every logical version and exact Ledger cardinality remains verified. No cache/quota budget increased and no resource-stop sample is excluded.

## Correctness, native regressions and preserved failures

The direct oracle verifies identical canonical/stored-record bytes and SHA-256 at 1/8/16/32 MiB plus 512 Unicode cases. Both negative controls pass 59 functional assertions; each also retains one failure in the old 95-file seal test because its disposable test copy omitted server.js. The independent [delivery integrity verification](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/integrity-verification.json) checks all 95 original file hashes on each complete source checkout and every original candidate tracked path; it does not replace the original 59/1 receipts or rerun failed tests. Native fixture adaptation changes only existing profile/Document persistence/paired ACK literals; [source/transformed hashes](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/native-harness.json) and [complete adaptation diff](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/native-test-adaptation.diff) remain reviewable. Original assertions/manifests stay unchanged.

| Regression invocation | Pass / fail / skip | Exit / stop |
| --- | --- | --- |
| baseline-negatives | 59 / 1 / 0 | 1 / none |
| candidate-negatives | 59 / 1 / 0 | 1 / none |
| g2-native-once | 1 / 0 / 0 | 0 / none |
| candidate-native-integrity-crash | 187 / 0 / 0 | 0 / none |
| r1-h01 | 4 / 0 / 0 | 0 / none |
| r1-independent | 22 / 0 / 0 | 0 / none |
| r2-storage | 14 / 0 / 0 | 0 / none |
| r2-cache | 8 / 0 / 0 | 0 / none |
| r2-ack | 1 / 0 / 0 | 0 / none |
| r3-adversarial | 7 / 1 / 0 | 1 / none |
| r3-metadata | 1 / 1 / 0 | 1 / none |
| r3-publication | 2 / 0 / 0 | 0 / none |
| r3-backup | 1 / 0 / 0 | 0 / none |

Successful plain workloads assert durable ACK, exactly one Ledger effect per request, exact original ACK replay, selected CURRENT consistency, every required revision rebuilt and canonical SHA-256 equal. Full/Delta Locator kinds are recorded per version. Current native regressions cover invalid/valid Documents, immutable contents, physical dependency verification, cache limits/invalidation, publication boundaries, crash recovery, reader/backup protection and lifecycle ownership. Historical original groups can include both original process-crash and native profiles; the raw test names identify each rather than relabeling all of them native.

Historical Round 3 retains two stale-oracle failures: before-ACK mutation returns no ACK and fences while preserving the already published generation 4, but the old assertion requires generation 3; the metadata timestamp-coalescing test expects a fingerprint despite a same-verification mutation, while current content verification correctly raises INTEGRITY_ERROR. Current native publication/metadata controls and original publication controls pass. These are separate from current contract regressions. No assertion is edited to obtain green. All observed failures, including setup omissions and performance timeouts, remain in raw logs. The stopped timeout Store is preserved in place and losslessly archived with original physical identities and content hashes in [failure inventories](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/failed-store-inventories.json). After archiving, one bounded read-only PageStore/readVersion inspection of the original stopped Store verifies Ledger 1, exact original ACK, one full representation and its SHA-256. No client/coordinator open, recovery, GC or performance retry runs; the original cold timeout and 11/12 success count remain unchanged. Integrity verification confirms original inodes, bytes, mtime and ctime still match the archive inventory. Copies are byte evidence and carry no GC deletion or writable-continuation authority.

## Separate profiles and G2

The two explanatory 8 MiB profiles use original operation counters, 10 ms Inspector CPU samples and 1 MiB retained-allocation samples. [Profile summaries](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/profile-summary.json) contain lstat/FD stat/read, hash logical bytes, JSON guards/schema parse, canonical calls/bytes, fsync and operation-end heap/external memory. Inclusive timers overlap and are never summed. Logical reads are not uncached device reads; sampled heap is not cumulative allocation. Profile timings never substitute for plain latency.

| Separate 8 MiB warm profile counter | Baseline calls / logical bytes | Candidate calls / logical bytes |
| --- | ---: | ---: |
| fs.lstat | 1309 / 0 | 1309 / 0 |
| fd.stat | 230 / 0 | 230 / 0 |
| fd.readFile | 34 / 8400472 | 34 / 8400472 |
| fd.read | 172 / 41977250 | 172 / 41977250 |
| sha256.update | 326 / 134329947 | 326 / 134329947 |
| assertJson | 312 / 0 | 307 / 0 |
| parse | 197 / 0 | 197 / 0 |
| canonicalJson | 256 / 100748162 | 256 / 100748162 |
| fd.sync | 103 / 0 | 103 / 0 |

Zero logical bytes for metadata/guard/sync counters denotes a non-byte counter, not absent work. These are real Node FD operations and logical hash/encoding bytes, not block-device read traffic. The complete open/replay/cold counters, traversal diagnostics, heap/external samples and GC/retained-allocation observations remain in profile-summary.json.

G2: exactly one original native before-rename invocation, with original opt-in preload and teardown preservation. No unrestricted reproduction campaign and no duplicate execution in the candidate native suite. The bounded invocation passed 1/1: waiting-grace with 12 moved / 0 deleted, then complete with 12 moved / 12 deleted. No failure marker, preserved failure Store or retry was triggered. The outcome remains **C — UNRESOLVED INTERMITTENT**. This passing invocation does not explain the earlier native quarantining failures. Preservation triggers/selected plans and any bounded retry remain in the G2 case directory.

## Variance and verdict

| Repeated workload | Metric | Baseline observed range | Candidate observed range |
| --- | --- | --- | --- |
| 8 MiB | commitSeconds | 5.054–5.194 s; range 0.140 | 4.637–5.205 s; range 0.568 |
| 8 MiB | coldSeconds | 4.182–4.370 s; range 0.187 | 3.500–3.957 s; range 0.457 |
| 8 MiB | peakWorkerHwmKiB | 284.391–327.715 MiB; range 43.324 | 327.102–327.266 MiB; range 0.164 |
| 32 MiB | commitSeconds | 19.310–20.811 s; range 1.501 | 17.178–17.205 s; range 0.027 |
| 32 MiB | coldSeconds | n=1; no repetition range (timeout retained separately) | 14.913–14.938 s; range 0.025 |
| 32 MiB | peakWorkerHwmKiB | 574.168–788.004 MiB; range 213.836 | 638.645–799.816 MiB; range 161.172 |

The 32 MiB paired commit savings (3.606 s and 2.132 s) exceed the observed baseline commit range (1.501 s) and candidate range (0.027 s). That is a repeatable material benefit in this bounded workload. The 8 MiB commit changes are smaller than its candidate repetition range and change direction. Cold 8 MiB gains are 0.412 s and 0.682 s against a candidate range 0.457 s; only the latter clears the frozen 10% threshold. 16 MiB and history lack repetition ranges. None of these descriptive ranges is a population significance estimate.

The [clock-domain observation](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/clock-domain-observation.json) records UTC elapsed 3,560 s versus monotonic execution 3,266.268 s, a 293.732 s divergence. The cause is UNKNOWN. All latency/resource timers use performance.now/time.monotonic; no sample is excluded or rescaled. Both durations remain below the frozen 7,200 s budget. This is an additional environmental limitation, not evidence that B caused a timing change.

The predeclared 10% material latency criterion and two reverse-order pairs supply descriptive direction only. Two samples do not establish a statistically significant population estimate, p95 or general throughput SLA. 16 MiB and history each have one pair and cannot establish repeatability. Changes in unchanged filesystem/hash primitives, random metadata bucket distribution, GC scheduling, background OS activity, CPU scheduling and Linux page-cache state remain confounders; not all observed differences can be attributed to B.

The 8 MiB commit direction changes between pairs; cold improves but the first gain is below the frozen 10% material threshold. Both 32 MiB candidate runs are faster, while one baseline cold-client times out and its reverse-order repetition succeeds. 16 MiB candidate commit and cold startup regress by more than 10%, contradicting an unqualified KEEP conclusion. These mixed results and limited repeats do not establish the repeatable cross-workload slowdown needed for REVERT either. The schema micro-operation improvement remains background evidence only.

**INCONCLUSIVE — DEFAULT TO BASELINE.** Recommend the simpler baseline for subsequent engineering. Preserve B and its independent correctness evidence; no production source is silently reverted. Any new candidate-only correctness failure, reproduced deadline failure or hard resource breach would require revisiting this conclusion from the preserved actual evidence.

## Remaining finite blockers and production status

1. Complete admitted 200/1,000-command history, revision-1000 checkpoint, crash/recovery and verified thinning; none executed in this assignment.
2. Resolve supported large-Document cold startup within the existing 30 s deadline; near-64 MiB is not admitted here.
3. Complete sustained maintenance drain, full capacity/quota and 1/16 reader plus backup pressure; obtain separately approved bounded-device physical ENOSPC evidence.
4. G2 remains C unless actual preserved recurrence evidence establishes a cause; no unrestricted campaign is authorized.
5. Maintainer approval of a measured performance/RSS/workload/platform profile remains required. Native SIGKILL/fsync evidence does not qualify host/VM/device power loss, writer UID/code isolation, old-binary OS fencing, restore continuation, live Host/authentication or writable cutover.

**PR-1D ENGINEERING EXIT BLOCKED; PRODUCTION NOT QUALIFIED.** No main merge, PR-1B or Unified Writer activation.

## Delivery and reproduction

The initial staged whitespace check found ten blank-context markers in the unedited native adaptation diff; exit 2 is retained in delivery-checks/whitespace-initial/raw.log. Evidence-local .gitattributes exempts only raw.log files and native-test-adaptation.diff from whitespace checks to preserve their exact bytes. Scripts, JSON, protocol and reports retain normal checks.

Delivery checks pass: docs:check (123 Markdown files, 55 tools, 22 config variables), release:check (0.20.0), seven Python AST checks, three Node syntax checks, and final staged whitespace. [Exact delivery commands/exits](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/delivery-checks.json) retain the initial raw-diff whitespace failure separately.

The frozen protocol commit precedes workloads; the final report/evidence commit follows execution. The report-containing delivery commit is resolved by `git log -1 --format=%H -- docs/rfc/unified-visual-architecture/PR-1D-NATIVE-PERFORMANCE-AB-REPORT.md`; the final user response gives the verified full remote HEAD and working-tree state without a self-referential hash.

[Runner and reproduction](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/scripts/pr1d-native-ab/README.md) · [Raw runs/exits](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/runs.jsonl) · [Paired machine-readable results](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/paired-results.json) · [Source verification](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/source-verification.json) · [Integrity verification](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/integrity-verification.json) · [Artifact manifest](https://github.com/Curium-3391/Estampes/blob/63ced9de6d7562ecc66a19728be2f2cf164f4b37/docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/manifest.json)
