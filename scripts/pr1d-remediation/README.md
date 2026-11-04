# PR-1D performance remediation

Use Node 22.23.4, one workload/worker at a time, fresh owned tmpfs scratch and
linux-process-crash-test. No native qualification, activation, migration or PR-1B.
The user separately authorized push after completion.

run.py derives from the frozen investigation supervisor, selecting PR1D_SOURCE
and writing only the new remediation evidence directory. Original benchmark,
cold-probe, profile and G2 preservation tools remain unchanged. Source/fixture
and harness input hashes, command, exits, CPU/IO profiles and resource receipts
are retained. Runtime/cache/client limits stay frozen: 900 s/history,
180 s/document, 1.5 GiB/process, 3 GiB/tree, 24 MiB record/4 MiB proof caches,
30 s client startup. No kernel-cache drop. Inclusive method timers overlap.
Heap samples are retained allocations, not cumulative or transient allocation.

The first exploratory 25-history pair overlapped for about two seconds and is
excluded. Environment disconnection interrupted a-history-50-1. Neither it nor
its pre-disconnection baseline supplies a completed paired comparison. Preserve
all these raw files. Resume with fresh names and sequential pairs; reverse-order
repetitions expose order effects. Never overwrite completed or failed evidence.

A removes a duplicate metadata preflight in bytes(), using the existing info()
result without caching across reads or verification boundaries. Retain FD/path,
length/hash, ownership/link/device checks and post-read ancestry validation.
Keep only after repeatable benefit and integrity regressions; otherwise archive
its patch and restore production source byte-for-byte.

B changes only jsonSchema: invoke the original guarding canonicalJson within
one synchronous transform, retaining its exact encoder/copy and error mapping.
No encoder or validation bypass is introduced. `parity.mjs BASELINE_SOURCE`
asserts raw canonical/stored-record bytes and hashes at 1/8/16/32 MiB and 512
Unicode cases. `json-cost.mjs BASELINE CANDIDATE FIRST` measures exactly the affected 8 MiB
schema operation. Each fresh process warms both once, then runs five alternating
pairs. Two independent processes reverse the initial order. Both source hashes
are emitted. This design was fixed before observing any CPU-probe result. It isolates guard cost and is not commit/startup latency.
The bounded CPU probe was admitted after mixed end-to-end observations, before
its results, to test the specific already-identified repeated traversal cost.

Typical sequence (fresh case names required): run A integrity and matrix.py a;
reject/restore A if benefit is inconclusive; otherwise admit a-long 50/100.
Run the B baseline 1 MiB case before editing, then B negative/parity checks,
matrix.py b (the baseline 1 MiB case already exists), and matrix.py b-cpu.
Run checks.py suite, historical and contracts after the retention decision.
The one original G2 before-rename case is run once with the existing opt-in
preservation tooling and excluded from the remaining serial discovery command.
This avoids duplicate attempts while preserving complete final-source coverage.
Native skips and the explicitly separately executed case are reported as such.
The frozen architecture checker runs on its exact production ancestor with a
separate Git index; verify-preservation.py independently checks this current
fixed scope and every historical byte. Historical checker scope is not widened.

The first historical H-01 replay exposes an old helper omission: assignment
`d.persistence="durable"` becomes an invalid Document enum after a generic ACK
durability replacement. Keep that raw failure. `checks.py historical-h01-corrected`
uses this directory's prepare-replay.py, which handles that one assignment as
memory before the frozen substitutions. It changes only disposable copies;
original tests/old helper remain immutable. Copied old benchmark files are not
measurement entrypoints and are not executed.

The recorded STARTUP-CONTROL-PLAN permits only two exact case controls and one
complete serial retest for the initial discovery startup timeout. It never
changes production/test deadlines or repeats the separately qualified G2 case.
`preserve-timeout.py` losslessly archives the stopped owned 32 MiB timeout tree,
checks physical metadata and all byte hashes, and never opens/recover/GCs a Store.
Archive copies cannot inherit deletion or writable-continuation authority.

Driver completion is not a per-case pass: matrix.py preserves and continues the
finite comparison after a 32 MiB cold-client deadline failure; historical mode
also retains old-oracle failures while completing independent cases. Inspect
individual runs.jsonl exitCode/stop and regression-results.json. Do not infer
all-green from the outer orchestration process exit.
