# Frozen investigation limits

Baseline 616c73c6c4571cd9ebf9eea9e60e21882428b612; production ancestor
29d097833688ddb649a88cb2a09f22ba5fadda8e. User separately authorized push.
Only diagnostics, disposable tests and reports. No optimization or durable changes.

This runner: Node 22.23.4, Linux, UID 1000, 2 CPU cgroup quota, 8 GiB memory.
/workspace is overlayfs; /tmp is tmpfs. No approved native ext4 mount is available.
Use /tmp private owned 0700 scratch and existing process-crash profile, real flock
and fsync calls. These measurements cannot certify ext4 latency/durability.

Serial workloads: history 25/50/100, each plain and instrumented, 900 s per run.
150 only if both 100 runs finish below 450 s, cold clients below 15 s, worker
RSS below 768 MiB; otherwise NOT RUN. No 200/1000. Documents use the same
extension-string structure: 1/8/16/32 MiB, plain and profiled, 180 s per run.
Near-64 MiB (64 MiB minus 32 KiB envelope headroom) only if 32 MiB cold client
<15 s, RSS <768 MiB and run <90 s. Stop after first near-boundary failure.
The production 30 s startup timeout is unchanged. Separate direct leased cold
coordinator probe bounded at 60 s; always label separately from client readiness.

Supervisor: 1.5 GiB per process, 3 GiB descendant RSS, >=2 GiB MemAvailable,
>=1 GiB cgroup headroom, >=1 GiB scratch free, <=512 MiB case allocation,
<=32 MiB individual logs, <=2 GiB retained scratch. Kill descendant process
group on limits; retain case Store. Sampling every 0.5 s, disk every 5 s.
No user/production Stores. Snapshot copies reject symlinks/hardlinks/device
crossings and require owned direct-child disposable Store under scratch.

G2: exact original before-rename test and assertions; opt-in evidence-only
preload plus fixture teardown preservation. Maximum four attempts total, stop
at first unexpected post-grace nonterminal result. Record result before reading
or preservation. Snapshot stopped Store before at most one cold restart and one
same-plan step on original (copied inodes cannot inherit GC authority). All
before/after snapshots retained, never repair or weaken oracle. No native claim.

Profiling: external opt-in preload/hooks only, 10 ms CPU samples, 1 MiB V8 heap
sampling, phase timings and operation counts. Inclusive nested method durations
are not additive. Plain runs have no hooks. Instrumentation overhead reported
using matching workload timing, with environment/run-order confounding explicit.
