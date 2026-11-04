#!/usr/bin/env bash
# Complete only dependency-skipped coverage using the already installed venv.
set -euo pipefail
scratch=$1
harness=docs/rfc/unified-visual-architecture/evidence/pr1d-frozen-qualification
python=$scratch/tmp/python-setup/venv/bin/python
browserHome=$scratch/tmp/browser-setup
browser=$browserHome/browsers/chromium-1194/chrome-linux/chrome
libs=$browserHome/extracted/usr/lib/x86_64-linux-gnu
run() {
  python3 "$harness/run.py" "$scratch" "$@" || printf 'Recorded %s exit %d\n' "$1" "$?"
}
run python-dependency-verification 90 512 python3 -m pip --python "$python" freeze
run cas-python 120 512 "$python" -m unittest discover -s cas-service/tests -v
# The names are the Node files that condition tests on the Python service.
run cas-node-followup 420 2048 env "PYTHON=$python" "CHROME_BIN=$browser" "CHROMIUM_BIN=$browser"   "LD_LIBRARY_PATH=$libs" node --test --test-concurrency=1   tests/{bundle-extras,cas-module,cards-e2e,layers-e2e,surface-open,surface-refresh,surface,upload-e2e,workbench-e2e,zoom-perf}.test.js
