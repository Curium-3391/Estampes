# Reproduce without overwriting committed evidence

Run from the repository with Node 22 and dependencies installed. The archived `qualify.sh` records the executed fixed-name sequence; do not rerun its fixed names over existing evidence. Use new names as below. All storage fixtures create and clean their own owned disposable stores. Do not point them at user storage.

```sh
pr1d_node=$(npm exec --yes --package=node@22 -- node -p process.execPath)
pr1d_tag=replay-$(date -u +%Y%m%dT%H%M%SZ)
pr1d_scratch=$(mktemp -d /tmp/estampes-hardening-replay-XXXXXX)
pr1d_evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-integrity-hardening
python3 "$pr1d_evidence/prepare-baseline.py" "$PWD" "$pr1d_scratch/baseline"
python3 "$pr1d_evidence/prepare-replay.py" "$PWD" "$pr1d_scratch/replay" > "$pr1d_scratch/replay-hashes.json"
python3 "$pr1d_evidence/run.py" "$pr1d_tag-round2" "$pr1d_node" --test --test-concurrency=1 "$pr1d_scratch/replay/docs/rfc/unified-visual-architecture/evidence/pr1d-native-round2/cache-ack-race.mjs" "$pr1d_scratch/replay/docs/rfc/unified-visual-architecture/evidence/pr1d-native-round2/cache-integrity.mjs" "$pr1d_scratch/replay/docs/rfc/unified-visual-architecture/evidence/pr1d-native-round2/storage-faults.mjs"
```

For causal comparisons, finish other tests first. Run one benchmark worker at a time with the same count, payload, Node version and filesystem. Use distinct labels for every artifact:

```sh
PR1D_CODE_ROOT="$pr1d_scratch/baseline" python3 "$pr1d_evidence/run.py" "$pr1d_tag-before100" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 100 0 "$pr1d_tag-before100"
python3 "$pr1d_evidence/run.py" "$pr1d_tag-after100" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 100 0 "$pr1d_tag-after100"
PR1D_CODE_ROOT="$pr1d_scratch/baseline" python3 "$pr1d_evidence/run.py" "$pr1d_tag-before8m" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 "$pr1d_tag-before8m"
python3 "$pr1d_evidence/run.py" "$pr1d_tag-after8m" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 "$pr1d_tag-after8m"
```

For an optional warm allocation/CPU profile, set `PR1D_PROFILE_WARM_ONLY=1`, a unique `PR1D_PROFILE_LABEL`, and the two absolute `--import` paths from `qualify.sh`. Use the same instrumentation for both baseline and candidate. Profiling has overhead; warm-only output deliberately has no cold/retry result. The uninstrumented benchmark independently verifies normal cold startup, all historical versions and exact Ledger replay. Never increase the 30-second client timeout.

For final validation:

```sh
CHROME_BIN=/usr/bin/chromium CHROMIUM_BIN=/usr/bin/chromium python3 "$pr1d_evidence/run.py" "$pr1d_tag-full" "$pr1d_node" --test --test-concurrency=1
```

These commands are process-crash replays. Independent native acceptance must run the original unmodified evidence scripts against the new source on an approved owned disposable ext4/XFS mount. It must not transform the platform guard or call tmpfs/overlay native. Reuse the independent original native harness instructions for its paired durable-profile fixtures. Revision-1000, capacity and hardware power-loss gates remain open.
