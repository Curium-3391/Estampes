# PR-1D performance and G2 evidence tools

Read BUDGET.md. Run from repository root with Node 22.23.4. Tools touch only
fresh owned scratch; no production writer activation or source optimization.

- `python3 scripts/pr1d-investigation/run.py history-25-plain 900 plain /path/to/node scripts/pr1d-investigation/benchmark.mjs history 25`
- Same command with a fresh name and `profile` enables function-entry counters,
  CPU Inspector and heap sampling. `NODE` in run.py identifies the pinned runner
  executable; adjust for another machine, recording its exact version.
- `python3 scripts/pr1d-investigation/matrix.py history` runs 50/100 and conditionally
  150; 25 plain/profile are the two initial independent harness checks.
- `python3 scripts/pr1d-investigation/matrix.py documents` runs the size matrix
  with conditional near-boundary admission. No entrypoint permits 200/1000.
- `python3 scripts/pr1d-investigation/g2-run.py` runs the unchanged before-rename
  assertion at most four times and stops on the first failure. It sets the two
  explicit environment controls and preload. Never run it on user Stores.
- `python3 scripts/pr1d-investigation/summarize.py` derives summary.json from raw
  JSONL and compressed Inspector profiles; no source mutation.

Output names must be fresh; existing runs are not overwritten. `runs.jsonl`
records exact commands, safe environment selectors, exits, budgets and hashes.
Successful scratch is removed; failed scratch and captured Stores remain.
Profiled workers save counters per open/commit and CPU/heap on SIGUSR2. A direct
cold probe owns real flock but has its own 60 s cap, separate from the unchanged
30 s client. It publishes a recovery epoch; the following cold client therefore
opens a successor Store, explicitly visible in its generation/verification data.

Counters/timers are inclusive and overlap. `canonicalJson` includes its JSON
preflight, `parse` includes schema transforms/guards, and method I/O times include
async waits. Do not sum nested times or treat CPU samples labelled idle as CPU.
Heap sampling at 1 MiB estimates sampled retained allocations; it does not
measure cumulative allocation, transient peak or every string clone. RSS is
sampled/HWM. No dropping kernel caches: cold means a fresh JS worker/cache.

G2 logs record real returned result, selected progress, clock, runtime pins and
last completed stages before diagnostic reads. Unexpected post-grace results
write a failure marker before full read-only inspection. The fixture kills the
writer and waits, validates scratch/device/ownership and inventories every file,
then copies the bytes and records original inode identities and SHA-256. The copy
is never opened for GC: copied inode identities do not carry deletion authority.
After before/ is sealed, a single cold restart and same-plan step may execute
on the original disposable Store, bounded at 60 s. Both snapshots and retry exit
or error are retained. Inspection errors retain the original Store without retry.
No observer calls recovery or GC while inspecting selected state.

The fixture has only an opt-in teardown hook. Original assertions are unchanged.
The preservation test independently exercises ownership and alias rejection plus
an explicitly synthetic preservation trigger on a real G2 plan. That control is
not a reproduced intermittent failure.

Native ext4 re-run: use a fresh approved owned ext4 scratch, transform only the
existing test-profile / Document persistence literals in a disposable harness,
retain source/transformation SHA-256, and link its scripts to this repository's
scripts. The old sealed prepare-native.py intentionally rejects a changed fixture
hash; do not edit its manifest or sealed evidence to bypass it. A native execution
and profile approval remain necessary.
