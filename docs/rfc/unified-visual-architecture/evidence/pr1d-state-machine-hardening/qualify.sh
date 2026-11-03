#!/usr/bin/env bash
set -eu
pr1d_node=$1
pr1d_baseline=$2
pr1d_evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-state-machine-hardening
# Serial paired workloads; no regression suites run alongside these measurements.
for pr1d_count in 50 100; do
 PR1D_CODE_ROOT="$pr1d_baseline" python3 "$pr1d_evidence/run.py" "paired-baseline-$pr1d_count" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" "$pr1d_count" 0 "paired-baseline-$pr1d_count"
 python3 "$pr1d_evidence/run.py" "paired-candidate-$pr1d_count" "$pr1d_node" "$pr1d_evidence/benchmark.mjs" "$pr1d_count" 0 "paired-candidate-$pr1d_count"
done
PR1D_CODE_ROOT="$pr1d_baseline" python3 "$pr1d_evidence/run.py" paired-baseline-8mib "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 paired-baseline-8mib
python3 "$pr1d_evidence/run.py" paired-candidate-8mib "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 paired-candidate-8mib
PR1D_AUTO_MAINTENANCE=1 python3 "$pr1d_evidence/run.py" qualification-auto-maintenance "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 qualification-auto-maintenance
CHROME_BIN=/usr/bin/chromium CHROMIUM_BIN=/usr/bin/chromium python3 "$pr1d_evidence/run.py" complete-node22-serial "$pr1d_node" --test --test-concurrency=1
