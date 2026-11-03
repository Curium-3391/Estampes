#!/usr/bin/env bash
set -eu
pr1d_node=$1
pr1d_baseline=$2
pr1d_evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-integrity-hardening
# One benchmark worker at a time; no test suite runs during these pairs.
PR1D_CODE_ROOT="$pr1d_baseline" python3 "$pr1d_evidence/run.py" isolated-baseline-100 "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 100 0 isolated-baseline-100
python3 "$pr1d_evidence/run.py" isolated-candidate-100 "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 100 0 isolated-candidate-100
PR1D_CODE_ROOT="$pr1d_baseline" python3 "$pr1d_evidence/run.py" isolated-baseline-8mib "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 isolated-baseline-8mib
python3 "$pr1d_evidence/run.py" isolated-candidate-8mib "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 isolated-candidate-8mib
PR1D_CODE_ROOT="$pr1d_baseline" PR1D_PROFILE_WARM_ONLY=1 PR1D_PROFILE_LABEL=isolated-baseline-profile NODE_OPTIONS="--import=$PWD/$pr1d_evidence/count-register.mjs --import=$PWD/$pr1d_evidence/profile-preload.mjs" python3 "$pr1d_evidence/run.py" isolated-baseline-profile "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 isolated-baseline-profile
PR1D_PROFILE_WARM_ONLY=1 PR1D_PROFILE_LABEL=isolated-candidate-profile NODE_OPTIONS="--import=$PWD/$pr1d_evidence/count-register.mjs --import=$PWD/$pr1d_evidence/profile-preload.mjs" python3 "$pr1d_evidence/run.py" isolated-candidate-profile "$pr1d_node" "$pr1d_evidence/benchmark.mjs" 4 8388608 isolated-candidate-profile
CHROME_BIN=/usr/bin/chromium CHROMIUM_BIN=/usr/bin/chromium python3 "$pr1d_evidence/run.py" sealed-node22-serial "$pr1d_node" --test --test-concurrency=1
