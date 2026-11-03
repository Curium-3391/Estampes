#!/usr/bin/env bash
set -eu
PR1D_ACCEPT_ROOT=$(mktemp -d /tmp/estampes-pr1d-replay-XXXXXX)
export PR1D_ACCEPT_ROOT
trap 'rm -rf -- "$PR1D_ACCEPT_ROOT"' EXIT
pr1d_node=$1
pr1d_replay=$2/docs/rfc/unified-visual-architecture/evidence
pr1d_evidence=docs/rfc/unified-visual-architecture/evidence/pr1d-state-machine-hardening
python3 "$pr1d_evidence/run.py" original-h01-configured-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-logs/independent-cases.mjs"
python3 "$pr1d_evidence/run.py" original-faults-owner-bound "$pr1d_node" --test --test-concurrency=1 tests/persistence-faults.test.js
python3 "$pr1d_evidence/run.py" round2-storage-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round2/storage-faults.mjs"
python3 "$pr1d_evidence/run.py" round2-cache-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round2/cache-integrity.mjs"
python3 "$pr1d_evidence/run.py" round2-ack-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round2/cache-ack-race.mjs"
# Keep the original post-publication rollback expectation visible as a failure.
if python3 "$pr1d_evidence/run.py" round3-original-adversarial-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round3/adversarial.mjs"; then
 echo 'Original adversarial expectations unexpectedly all passed; inspect rollback behavior.'; exit 1
else
 pr1d_exit=$?; test "$pr1d_exit" -eq 1
fi
python3 "$pr1d_evidence/run.py" round3-original-metadata-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round3/metadata-boundary.mjs"
python3 "$pr1d_evidence/run.py" round3-controls-backup-owner-bound "$pr1d_node" --test --test-concurrency=1 "$pr1d_replay/pr1d-native-round3/publication-controls.mjs" "$pr1d_replay/pr1d-native-round3/backup-gc.mjs"
python3 "$pr1d_evidence/run.py" contracts-owner-bound "$pr1d_node" --test docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs
python3 "$pr1d_evidence/run.py" formal-examples-owner-bound "$pr1d_node" docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs
python3 "$pr1d_evidence/run.py" cas-python-owner-bound python3 -m unittest discover -s cas-service/tests -v
python3 "$pr1d_evidence/run.py" environment-owner-bound python3 "$pr1d_evidence/environment.py"
python3 "$pr1d_evidence/run.py" docs-final-owner-bound "$pr1d_node" scripts/check-docs.mjs
python3 "$pr1d_evidence/run.py" release-final-owner-bound "$pr1d_node" scripts/check-release.mjs
python3 "$pr1d_evidence/run.py" consistency-final-owner-bound "$pr1d_node" docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs
python3 "$pr1d_evidence/run.py" preservation-owner-bound python3 "$pr1d_evidence/verify-preservation.py"
python3 "$pr1d_evidence/run.py" whitespace-owner-bound git diff --check 31dae29f1cf7d1e8caf6c670124eed7c7ed91e11
