# Immutable pre-execution protocol — PR-1D native A/B

Frozen 2026-11-06 (Asia/Taipei), before performance or correctness workload execution.
Baseline d9aaa49f27d195ed53baeb12e95e434f1a7b10b0.
Candidate 4814daf2378e9619f171c02a65792062957a8e99.
Evidence branch codex/pr1d-native-performance-ab-adjudication, based on candidate.

## Admission and limits

Require Ubuntu 24.04.1, WSL2, Node 22.23.4, UID/GID 1001 estampes,
findmnt ext4 /dev/sdd plus mountinfo and statfs 0xef53. Otherwise native NOT RUN.
Separate detached clean worktrees, independent npm ci dependencies, no Store/cache copying.
Native linux-local-durable, actual flock and file/directory fsync. All scratch 0700.
One workload at a time; no CPU pinning or kernel cache drop. No measured warmup.
Cold means new client/worker and empty JS caches; Linux page cache remains warmable.
Identical deterministic fixture from uva-persistence document(1), durable Document,
ASCII x extension payload of exactly 8/16/32 MiB; history uses original revision/title
sequence, request/actor sequence. SHA-256 each canonical Document and command before
measured commits. Same autoMaintenance:false, zero readers/backups, default caches
(24 MiB record, 32 MiB registry, 4 MiB proof); unchanged 30 s cold-client deadline.
Retain original separately leased direct recovery (60 s), which publishes an epoch
before the client; report its time separately, never as client replication.

Total execution budget 7,200 s from first case, documents 180 s/case, history 900 s,
native regression suite 2,400 s, G2 420 s, parity/negative 180 s each,
historical groups 600 s each. No retries of performance, suite, or G2.
Per-process HWM <=1.5 GiB; concurrent descendant RSS <=3 GiB; available RAM >=2 GiB;
per-case allocated scratch <=512 MiB (native regressions <=1 GiB); total scratch
<=4 GiB; free ext4 >=48 GiB; host processes <=256; case descendants <=24;
raw log <=32 MiB/case. Sample /proc at 200 ms and allocation at 5 s; these are
sampled guardrails, not hard kernel RSS enforcement. Stop and kill descendants
on cap/error. Admission failures NOT RUN, active timeout recorded as failure.
A contractual timeout is a performance blocker; preserve its stopped Store.
No 1,000-command, near-64 MiB, physical ENOSPC, or new optimization work.

## Fixed order and count

1. Native canonical/raw stored-record parity, including 1/8/16/32 MiB and
512 Unicode cases, plus exact workload fixture hashes (not latency data).
2. Baseline and candidate negative/Document validation controls, one invocation each.
3. Plain 8 MiB pair 1 B->C; 8 MiB pair 2 C->B.
4. Plain 16 MiB pair 1 B->C.
5. Plain 32 MiB pair 1 B->C; 32 MiB pair 2 C->B.
6. Plain history-100 pair 1 C->B.
Exactly six pairs / twelve plain runs; retain every attempted sample.
7. Separate explanatory profiles: document-8 B->C, one fresh Store each,
using original profile.mjs counters/CPU/heap hooks, never mixed with plain latency.
8. One bounded original native G2 before-rename case with existing opt-in
preservation preload; no further campaign. At most its existing safe retry.
9. Candidate native integrity/crash regression set: all current persistence tests
except G2 case already run, plus Document canonical/foundation/review controls.
Run disposable copies with only native profile/Document persistence/ACK literals
adapted, source and transformed hashes retained. No original assertion changes.
10. Preserved historical native Round 1/2/3 groups once each, with current
publication control; known stale oracle failures reported separately.

Global safety stops terminate further workloads only when global headroom is
unsafe; case failure alone does not erase or skip the remaining predeclared pairs.
There is no post-hoc exclusion of slow samples. Setup defects stay in raw evidence;
a fix may enable not-yet-started cases, never replace a failed timed sample.

## Measurements and integrity

Per commit: RPC wall, worker /proc user/system tick deltas and parent CPU delta,
ACK durability/ref/hash, default diagnostics including reconstructions, worker HWM.
Supervisor captures process/tree RSS, CPU/IO and exact commands/env selectors/exits.
Cold ready/error, wall and unchanged 30 s outcome, selected CURRENT before/after,
replay exact original ACK, final Ledger cardinality, all required versions rebuilt
with canonical hash equality. Root identities differ across independent random
Store UUIDs/commit IDs and timestamps; logical Document hashes must match.
Canonical byte/record oracle compares baseline/candidate directly outside timers.
Profiled counters (lstat/FD reads/hash/JSON/encoding/fsync), memory and allocation
are separate; inclusive timers overlap and are never summed. Heap is retained
allocation sampling, not cumulative allocation. Store allocation/file counts recorded.
Record commands, exits, full inputs/hash manifests and preserve original history.
Hash protocol and harness in first commit; verify protocol unchanged at delivery.

## Analysis and finite verdict

For each pair report absolute commit total, cold wall, peak worker/process/tree RSS,
relative change 100*(C/B-1), failures/timeouts. For two repetitions report min/max
and descriptive range only; no population significance, p95 or bootstrap claims.
Material latency threshold: 10%; material memory regression: 20% AND >=64 MiB.
Repeatable benefit requires both reverse-order pairs of a material workload improve
by >=10% in commit or cold, with neither endpoint materially worse in that workload,
and effect direction must exceed the baseline/candidate observed repetition ranges.
A repeated >=10% slowdown by the analogous rule supports REVERT. Single-pair
16/history observations cannot establish repeatability; a >=10% loss there blocks
KEEP pending replication outside this finite assignment. Exceeding observed ranges
is a conservative descriptive rule, not a statistical significance claim.
Correctness regression or exceeded existing hard memory cap supports REVERT;
a new timeout supports REVERT only if reproduced in the predeclared runs and absent
in its matched baseline runs. Any timeout prevents KEEP even if not reproducible.
KEEP only if native correctness/canonical parity pass, repeatable end-to-end
benefit, no material workload regression, no deadline/capacity/memory failure.
Otherwise INCONCLUSIVE — DEFAULT TO BASELINE. Recommend only; never edit runtime
or switch implementation branches in response. Preserve B and its correctness evidence.
G2 absent recurrence remains C — UNRESOLVED INTERMITTENT; a reproduced anomaly
is adjudicated from preserved actual state, never silently retried to green.
Engineering exit remains BLOCKED and production NOT QUALIFIED regardless of verdict.
