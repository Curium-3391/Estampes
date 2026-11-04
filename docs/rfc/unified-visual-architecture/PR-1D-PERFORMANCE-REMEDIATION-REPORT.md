# PR-1D Evidence-Guided Performance Remediation

2026-11-05 (Asia/Taipei). Isolated implementation branch. **PR-1D ENGINEERING
EXIT BLOCKED; PRODUCTION NOT QUALIFIED; NATIVE REACCEPTANCE BLOCKED.**

**IMPLEMENTED — PRE-MERGE VALIDATED for supported tmpfs correctness only.**
A is reverted; B is retained; C is not admitted. No
Unified Writer activation, PR-1B, data migration, legacy writer change, main
merge, timeout increase, format change or cache-budget increase is authorized.

## Baseline and authority

APPROVED: the uploaded remediation handoff permits the bounded A/B optimization
sequence and independent commits. The separate user instruction `完成後push`
authorizes pushing this implementation branch. It does not authorize deployment.
CURRENT implementation defines existing semantics; the frozen filesystem trust
and lifecycle contracts define NORMATIVE invariants; benchmarks are OBSERVED
results, not platform/profile approval. See [SAFETY](evidence/pr1d-performance-remediation/SAFETY.md).

Fetched the source branch `investigate/pr1d-performance-and-g2-evidence`, verified
its exact remote HEAD `d9aaa49f27d195ed53baeb12e95e434f1a7b10b0`, and confirmed
`29d097833688ddb649a88cb2a09f22ba5fadda8e` is an ancestor. Initial checkout
`work` at `7fb9b73442401fc32a7034888deaf49303e582a6` was clean. Created
`fix/unified-visual-architecture-pr1d-performance-remediation` directly at the
required baseline, without merging, resetting or rebasing any prior branch.
A detached baseline worktree supports paired measurements. Production `src`
is byte-identical between the production ancestor and investigation baseline;
the only existing test fixture change there is the opt-in G2 preservation hook.

[Baseline SHA-256](evidence/pr1d-performance-remediation/baseline-sha256.json)
seals original implementation, tests and investigation scripts before editing.
Final source preservation checks compare every original tracked file against
its baseline Git blob, allowing only the explicitly retained runtime changes.
Every previous report, raw failure, original test assertion, G2 tool and source
seal stays unchanged. New evidence never edits the historical run indexes.

Required investigation/cost/results/summary, frozen lifecycle qualification,
state-machine hardening, trust, storage lifecycle and final architecture gate
were read against actual coordinator/filesystem/records/lifecycle/archive/pages/
ownership and Document validation/cache/session implementations. Counters are
inclusive; their durations are not independent CPU costs.

## Environment, execution limits and interruptions

See [environment](evidence/pr1d-performance-remediation/environment.json),
[runner methodology](../../../scripts/pr1d-remediation/README.md),
[runs](evidence/pr1d-performance-remediation/runs.jsonl), and per-case input hashes.
Explicit Node 22.23.4, Linux, same UID, 2-CPU cgroup, 8 GiB cgroup memory,
overlayfs source checkout and fresh private 0700 tmpfs Stores. One workload at
a time, one writer, `autoMaintenance:false`, same extension-string payloads,
original 30-second client deadline and existing resource/cache budgets.
Real flock, file/directory fsync, rename and FD/path/content verification run.
No native profile spoof, mount, fsync bypass or kernel cache drop is used.

Plain and profiled measurements run separately. Profile CPU/heap and inclusive
JSON/schema/hash/FD counters are explanatory; plain paired latency determines
performance retention. RSS HWM, operation-end heap/external and 1 MiB sampled
retained allocations measure different things. Logical FD read bytes are not
uncached device IO. Cold means a new JS worker/cache. The separate 60-second
direct leased recovery publishes an epoch; the following cold client opens a
successor Store, so they are not interchangeable repeat samples.

The first exploratory 25-history pair overlapped for approximately two seconds
and is excluded. The environment then disconnected during `a-history-50-1`;
there is no terminal receipt for that case. Its raw data and prior baseline are
preserved and excluded from completed paired conclusions. Resumed runs use
fresh names and reverse-order repetitions. See
[interruption](evidence/pr1d-performance-remediation/interruption.json).

## Optimization A

Candidate diff: reuse the existing `info()` pre-open result in `bytes()` rather
than performing an identical ownership/link/device/ancestry walk immediately
before it. No directory trust cache is introduced. Both independent sides of
the read still check ancestry and path identity; O_NOFOLLOW, opened-file
ownership/links/size, FD/path fingerprints, exact length, content hash and all
candidate/pre-rename/pre-ACK boundary verification remain.

[Safety argument](evidence/pr1d-performance-remediation/SAFETY.md) and controlled
parent/symlink/hardlink/mode replacement tests cover the shortened preflight.
The A-specific integrity run passed 60/60, zero failures/skips. This includes
coherent reads, metadata aliases, shared dependency invalidation, cold reopen,
writer fencing and reader/backup cases. It is process-crash evidence only.

**REVERT.** [Decision](evidence/pr1d-performance-remediation/decision-a.json)
and [candidate patch](evidence/pr1d-performance-remediation/candidate-a.patch)
remain archived. Plain paired commit totals were 42.988→23.456 s (45.4% faster)
and, in reverse execution order, 27.575→29.806 s (8.1% slower). The substantial
variance and opposite signs do not establish a repeatable end-to-end benefit.
A separate profile's last-commit lstat count fell 12,669→11,621 (8.3%), with all
three observation boundaries retained; independently generated metadata buckets
also vary FD/hash counts slightly. Count reduction is not a latency conclusion.

The runtime file was restored byte-for-byte to the exact baseline. The six new
boundary/ownership tests also pass on that restored source. Later 50/100-history
extensions were NOT RUN after this candidate failed retention, following the
bounded keep/revert stop rule. No retained history speedup is claimed. The
pre-disconnection 50-history case lacks a terminal receipt and is excluded.
The separate A decision/regression commit is
`b9f3fd1a93c7acff631811fc770e864650717dc1`.

## Optimization B

Candidate: call the original `canonicalJson` once inside a synchronous JSON
schema transform, mapping its `DocumentValidationError` into the same Zod issue.
The original outer guard would otherwise scan the same value a second time.
The public guard, original encoder body, JSON parse copy, strict Document
schema and all limits remain. No retained mutable identity, private unchecked
encoder, skip-validation flag or cross-transaction cache is needed.

**KEEP for the repeatable local schema-operation benefit, with final
supported correctness qualification complete.** No general commit/startup acceleration
is claimed. [Decision and all paired values](evidence/pr1d-performance-remediation/decision-b.json),
[plain latency/RSS](evidence/pr1d-performance-remediation/PLAIN-MEMORY.md),
[all measurements](evidence/pr1d-performance-remediation/RESULTS.md),
[CPU/IO/JSON/hash/memory tables](evidence/pr1d-performance-remediation/COUNTERS.md)
and [raw operation data](evidence/pr1d-performance-remediation/counters-memory.json)
retain gains, losses and missing observations.

Two fresh processes each warmed both source modules once, then executed five
alternating pairs of the identical 8 MiB schema operation, reversing initial
order in the second process. Exact encoded hashes were checked outside every
measured interval. Baseline/candidate source hashes are in each raw result.
This bounded probe was specified after mixed end-to-end data and before any
probe results; it tests the repeated traversal identified by the investigation.

| Independent process | Schema wall median ms, baseline → candidate | Process CPU median ms | Observed reduction wall / CPU |
| --- | --- | --- | --- |
| 1 | 343.917 → 232.503 | 344.186 → 245.525 | 32.4% / 28.7% |
| 2 | 543.659 → 220.585 | 582.653 → 220.757 | 59.4% / 62.1% |

These are five-call medians within each process, not production p95 or a
throughput SLA. CPU is whole-process CPU during the operation, including GC.

| Plain workload | Commit s, baseline → candidate | Cold client s | Change commit / cold |
| --- | --- | --- | --- |
| 1 MiB / pair 1 | 0.910 → 1.268 | 1.330 → 1.458 | +39.4% / +9.6% |
| 8 MiB / pair 1 | 7.232 → 8.017 | 7.482 → 5.179 | +10.9% / -30.8% |
| 8 MiB / pair 2 | 5.205 → 9.650 | 4.107 → 3.792 | +85.4% / -7.7% |
| 16 MiB / pair 1 | 12.644 → 11.930 | 8.950 → 9.601 | -5.7% / +7.3% |
| 32 MiB / pair 1 | 29.593 → 20.452 | 26.742 → 17.502 | -30.9% / -34.6% |

Positive percentages are regressions. End-to-end results are mixed: both 8 MiB
cold comparisons improve, while both commits regress, and the 16 MiB cold
comparison regresses. Unchanged SHA primitives also vary materially: the 8 MiB
profile hashes exactly 134,330,139 bytes in both versions, yet SHA update time
is 173.9→271.9 ms. This is evidence of confounding, not permission to normalize
away losses or attribute the entire 32 MiB gain to this patch.

The 8 MiB warm profile has 312→307 guard calls, exactly equal canonical
calls/output bytes (256 / 100,748,288), schema entries (197) and hash calls/bytes
(326 / 134,330,139). The removed work is redundant validation, not serialization
or hashing. Inclusive guard/canonical/schema timings overlap. Counters for all
sizes and cold operations are retained separately; the failed 32 MiB cold open
has no completed operation profile and is not represented by zero.

**Preserved performance failure:** `b-document-32-profile` returned
`RECOVERY_REQUIRED / Writer startup timed out` after 31.594 s; direct leased
cold recovery had completed in 18.266 s. Its Store remains under
`/tmp/pr1d-investigation-mwz_4mq_`; raw failure and source hashes are retained.
One bounded fresh plain diagnostic then exited 0: commit 21.362 s, cold client
28.958 s, all-version verification and exact ACK replay pass. The earlier plain
candidate cold was 17.502 s. The original 30-second client deadline remains
unchanged. This variance and instrumented failure are unresolved performance
qualification gaps, not evidence of detected corruption or resolved startup.
No further retries were performed.

Peak single-process HWM in the plain 32 MiB pair is 727,552→919,604 KiB, a 26.4%
increase; the bounded candidate retest reaches 871,424 KiB. These peaks may occur
in the parent, warm worker or after exact replay, and are not startup-only RSS.
The tables separate warm worker HWM, cold-ready HWM and aggregate per-process
peak. Operation-end heap/external/arrayBuffer samples and sampled retained
allocation sites remain in COUNTERS/summary; neither proves cumulative
allocation or a universal RSS ceiling. All measured cases stay inside the
existing 1.5 GiB/process and 3 GiB/tree caps. No record/proof/registry/prefix
budget was increased. The oversized 32 MiB record still exceeds the 24 MiB
record cache; reconstruction and eviction behavior remain exercised. Near-64
MiB was NOT RUN: 32 MiB cold/RSS already fail the frozen near-boundary admission
thresholds. This is an admission limit, not an invented production SLA.

Baseline new negative tests pass 18/18; candidate foundation/review/negative
checks pass 60/60. The separate oracle compares original and candidate raw
canonical/stored-record bytes at 1/8/16/32 MiB and 512 Unicode cases, all equal.
The tests retain finite numeric, byte/depth/node, prototype/accessor/proxy,
cycle/array, Unicode/lone surrogate, negative-zero, strict Document and mutable
async-entry rejection/copy contracts. No public bypass flag or immutable-object
assumption is introduced. Complete persistence/Full/Delta/binding/cache/ACK
qualification is reported below.


## Optional C admission

No C implementation is admitted. A was rejected for inconclusive benefit; B is
a bounded Document-only optimization, with no new 100-history profile that would
satisfy C's remaining-cost admission requirement.
Historical logical proof visits alone do not establish a material exclusive CPU
cost; the frozen investigation measured only about 98 ms inclusive registry
lookup time at commit 100. Final admission decision follows retained results.

## Regression and evidence boundaries

[Regression results](evidence/pr1d-performance-remediation/regression-results.json)
and the immutable per-case logs/receipts record every invocation. Node is
22.23.4; real Chromium 154.0.8037.57 runs the browser assertions with
CHROME_BIN/CHROMIUM_BIN set. Python is 3.12.14, SymPy 1.14.0/mpmath 1.3.0.
Real Chromium integration is not live ChatGPT Host acceptance.

| Qualification | Pass / fail / skip | Result |
| --- | --- | --- |
| A supported integrity subset | 60 / 0 / 0 | PASS before performance-based revert |
| B baseline new negatives | 18 / 0 / 0 | PASS |
| B candidate foundation/review/negative | 60 / 0 / 0 | PASS |
| Canonical/stored-record oracle | 1/8/16/32 MiB + 512 Unicode cases | Exact bytes and SHA-256 equal |
| Original G2 before-rename, bounded once | 1 / 0 / 0 | PASS; no failure trigger/retry |
| Complete Node 22 serial, first run | 542 / 1 / 2 | Preserved startup timeout; 959.850 s |
| Exact failed case baseline control | 1 / 0 / 0 | 1.320 s; original limits/assertions |
| Exact failed case candidate control | 1 / 0 / 0 | 1.351 s; original limits/assertions |
| Complete Node 22 serial, one retest | 543 / 0 / 2 | PASS; 980.253 s, identical runtime/test SHA-256 |
| Original independent H-01/H-02/fault cases | 22 / 0 / 0 | PASS, process-crash adaptation |
| H-01 old adapter, initial invocation | 0 / 4 / 0 | Setup defect retained; see below |
| H-01 corrected disposable fixture | 4 / 0 / 0 | PASS, original assertions preserved |
| Round 2 storage / cache / ACK race | 14 / 0 / 0; 8 / 0 / 0; 1 / 0 / 0 | PASS |
| Round 3 original adversarial | 7 / 1 / 0 | Preserved historical post-publication rollback oracle |
| Round 3 metadata / publication / backup | 2 / 0 / 0; 2 / 0 / 0; 1 / 0 / 0 | PASS |
| Contract validation | 22 / 0 / 0 | PASS |
| Formal examples | 9 valid; zero errors | PASS for proposed schema/example shape only |
| CAS Python | 17 / 0 / 0 | PASS |
| Docs / release / architecture / syntax / whitespace | exit 0 each | PASS; final report/source seal checked at delivery |

The first final-docs invocation found the manifest link before manifest.json
had been generated. That failure remains recorded as `docs-final`; after actual
manifest generation, `docs-final-sealed` passes all 120 Markdown files. Final
syntax covers 105 JS/MJS and 10 Python inputs. Raw logs are never edited to
remove these setup/qualification failures.

The initial staged whitespace check found two indentation-only lines in the
unmodified Round 3 TAP diff. Its exit-2 log is retained. The new evidence-local
.gitattributes exempts only `**/raw.log` from formatting whitespace checks so raw
bytes/hashes stay exact; source, tests, JSON and reports keep normal Git checks.
The final staged check passes with this explicit log-format exception.

The discovery command excludes exactly the separately instrumented original
G2 before-rename case; it is not attempted again during the one full retest.
Thus final-source discovery plus the independent G2 run cover 546 tests: 544
pass and two native-positive skips. The two native cases remain unexecuted and
are not counted as passes. All current supported assertions passed on final
source; the first complete failure and old historical oracle remain red records.

The initial complete run timed out starting the writer in the unchanged
`SIGKILL / after-intent-durable` case, before its post-recovery assertions.
Its original fixture removed the failed Store. No corruption was established.
The [finite control plan](evidence/pr1d-performance-remediation/STARTUP-CONTROL-PLAN.md)
was recorded before the two independent controls; both passed without changing
code, limits or assertions. Exactly one full retest then passed. No further
retests occurred. The resource snapshot shows no cgroup OOM and no extra live
benchmark, but pressure files are unavailable; the original cause is UNKNOWN.
A passing retest does not explain or erase the timeout.

The frozen historical prepare-replay helper did not handle
`d.persistence="durable"` assignments: its generic durability replacement made
those Document values `"process-crash-test"`, outside the Document enum. All four
H-01 cases consequently missed their CURRENT barrier. The new disposable
adapter handles that assignment as `"memory"` before applying the frozen
profile/durability substitutions. Original sources/assertions and the old helper
are unchanged. Both original/transformed SHA-256 manifests and the initial
0/4 failure remain; the corrected 4/4 are process-crash cases, never native
acceptance. Copied historical benchmark files are not executed; measurements
use the actual unchanged investigation benchmark entrypoints.

The original Round 3 before-ACK test still requires the old CURRENT after
publication. Its detection/no-ACK checks pass before its old-root equality
assertion fails. This is the same documented historical oracle conflict in
PR-1D-STATE-MACHINE-HARDENING-REPORT: the selected new CURRENT and committed
Ledger must be preserved while the writer fences. The current supported
publication tests and original publication controls pass. No rollback or
assertion weakening is introduced to make the historical test green.

The 32 MiB profiled timeout Store was stopped by the original client timeout.
Its entire owned tree is retained losslessly as
[timeout-store.tar.gz](evidence/pr1d-performance-remediation/timeout-store.tar.gz),
with [original inode/device/time/hash inventory](evidence/pr1d-performance-remediation/timeout-store-inventory.json).
Capture used only reads, verified owner/private directories, regular single-link
files, byte limits, stable physical identity and every archived SHA-256. No
coordinator open, recovery or GC ran on the failed Store or archive copy.
Copied inodes are byte evidence only and carry no source-tree deletion authority.

Native-positive skips must remain explicit and never count as passes. Original
H-01/H-02, Round 2 and Round 3 harnesses use disposable source-adapted copies
where native profiles are unavailable, preserving original assertions and
recording both source/transformed hashes. Historical stale rollback/metadata
oracles are reported separately from current contract outcomes.

The existing G2 preservation implementation and semantics remain byte-identical.
Run the original before-rename case with its existing opt-in instrumentation
under a finite bound, preserve any unexpected Store and perform at most the
existing one bounded safe retry. Green tmpfs runs cannot close the historical
native G2 intermittent.

## Remaining gates and exact native requirements

**PERFORMANCE BUDGET DECISION REQUIRED.** Only the 30-second client deadline is
an existing hard behavior limit. No new p95/RSS SLA is invented. These bounded
extension-string and tiny-document histories do not certify geometry-rich,
long-history, maintenance or simultaneous reader/backup production workloads.

Native reacceptance requires a fresh approved owned ext4/XFS Store on the exact
supported mount, matching Node/workload/resource/client/cache settings, real
lease and barrier evidence, the complete original/current integrity matrix,
metadata collisions and all three publication boundaries, all-version hashes,
Ledger/retry identity, GC ownership, pins and backup recovery. Repeat A/B
measurements there; tmpfs latency/durability cannot substitute for them.

PR-1D still requires finished 200/1000-command history/checkpoint qualification,
sustained maintenance/drain/capacity with 1/16 readers and backup pressure,
near-64 MiB admission only after safe resource preflight, actual bounded-device
ENOSPC/recovery, G2 intermittent diagnosis if reproduced, and maintainer-approved
measured workload/profile. Host/VM/block-device power-loss and flush behavior,
writer UID isolation, old-writer OS fencing and restore continuation remain
separate deployment/production gates. No PR-1B or writable cutover starts here.

## Delivery

- A decision/race regression commit: `b9f3fd1a93c7acff631811fc770e864650717dc1`.
  Candidate runtime reverted; archived patch and all excluded/paired results retained.
- B retained implementation/canonical regressions:
  `ddfeaa221ff3e5a6556ca6cc8f57048b6dd67b2b`.
- Final evidence/report commit: the containing delivery commit, resolved exactly
  by `git log -1 --format=%H -- docs/rfc/unified-visual-architecture/PR-1D-PERFORMANCE-REMEDIATION-REPORT.md`;
  final response records its full SHA. This avoids a self-referential commit hash.

[Delivery metadata](evidence/pr1d-performance-remediation/delivery.json),
[source preservation](evidence/pr1d-performance-remediation/source-preservation.json),
and [artifact manifest](evidence/pr1d-performance-remediation/manifest.json)
bind the final inputs, raw logs and this report. All 1,806 baseline files were
compared bytewise: 1,805 unchanged; only `src/documents/validation.js` differs.
Its guard prefix and public encoder/remaining-validation suffix are also
byte-identical. Original tests/reports/failure evidence, investigation/G2 tools,
legacy writer, package/lock and deployment are unchanged. No performance
conclusion is inferred from functional tests alone. The branch is pushed only
after these checks under the user's explicit authorization; no main merge or
activation is performed.
