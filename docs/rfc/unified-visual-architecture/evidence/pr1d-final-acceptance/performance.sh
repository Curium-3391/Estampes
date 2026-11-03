#!/usr/bin/env bash
set -eu
scratch=$1
evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-final-acceptance
test "$(id -u)" = 1001
test "$(stat -f -c %t "$scratch")" = ef53
test "$(stat -c %a "$scratch")" = 700
test "$(stat -c %u "$scratch")" = "$(id -u)"
run() { /usr/bin/python3 "$scratch/run.py" "$@"; }
for name in full-serial native-persistence r3-controls hardening-standalone lease-failures; do
 until rg -q "/$name.log" "$evidence/runs.jsonl"; do sleep 5; done
done
run perf-8mib node "$evidence/benchmark.mjs" 8mib || true
run perf-8mib-repeat env PR1D_METRICS_RUN=repeat node "$evidence/benchmark.mjs" 8mib || true
for n in 25 50 100; do
 run "perf-history-$n" node "$evidence/benchmark.mjs" history "$n" || true
done
if test -s "$evidence/metrics-history-100.json"; then
 run perf-history-100-repeat env PR1D_METRICS_RUN=repeat node "$evidence/benchmark.mjs" history 100 || true
fi
