#!/usr/bin/env bash
set -eu
scratch=$1
evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-native-round3
test "$(id -u)" = 1001
test "$(stat -f -c %t "$scratch")" = ef53
test "$(stat -c %a "$scratch")" = 700
test "$(stat -c %u "$scratch")" = "$(id -u)"
run() { /usr/bin/python3 "$scratch/run.py" "$@"; }
until rg -q 'full-serial-restart.log' "$evidence/runs.jsonl" && rg -q 'backup-gc.log' "$evidence/runs.jsonl"; do sleep 5; done
run candidate-8mib node "$evidence/benchmark.mjs" 8mib || true
run baseline-8mib node "$scratch/baseline/$evidence/benchmark.mjs" 8mib || true
if test -f "$scratch/baseline/$evidence/metrics-8mib.json"; then cp "$scratch/baseline/$evidence/metrics-8mib.json" "$evidence/baseline-metrics-8mib.json"; fi
run candidate-profile env PR1D_PROFILE_MODE=1 NODE_OPTIONS="--import=$PWD/$evidence/count-register.mjs --import=$PWD/$evidence/profile-preload.mjs" node "$evidence/benchmark.mjs" profile8 || true
run profile-summary python3 "$evidence/summarize-profiles.py" || true
for n in 25 50 100; do
 run "candidate-history-$n" node "$evidence/benchmark.mjs" history "$n" || break
 python3 - "$evidence/metrics-history-$n.json" <<'PY' || break
import json,sys
s=json.load(open(sys.argv[1]))["results"][0]["startup"]
assert s["status"] and s["status"]["state"]=="ready" and s["clientOpenMs"]<30000, s
PY
done
run baseline-history-100 node "$scratch/baseline/$evidence/benchmark.mjs" history 100 || true
if test -f "$scratch/baseline/$evidence/metrics-history-100.json"; then cp "$scratch/baseline/$evidence/metrics-history-100.json" "$evidence/baseline-metrics-history-100.json"; fi
