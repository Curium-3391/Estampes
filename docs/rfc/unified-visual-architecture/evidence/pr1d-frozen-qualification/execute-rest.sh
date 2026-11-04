#!/usr/bin/env bash
# Continue the frozen serial qualification after the A1 history preflights.
set -euo pipefail
scratch=$1
repo=$PWD
dir=docs/rfc/unified-visual-architecture/evidence
harness=$dir/pr1d-frozen-qualification
prior=$dir/pr1d-final-acceptance
native=$scratch/native
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
run() {
  python3 "$harness/run.py" "$scratch" "$@" || printf 'Recorded %s exit %d\n' "$1" "$?"
}
raw() {
  python3 "$harness/run.py" "$scratch" "$@"
}

if [[ -f "$scratch/evidence/archive-32mib.log" ]] && grep -q '"event":"preserved"' "$scratch/evidence/archive-32mib.log" &&
  grep -q 'assert.ok(entry)' "$scratch/evidence/archive-32mib.log"; then
  # Continue the original Store only after the recorded diagnostic lookup
  # error, within the unused portion of the original workload wall budget.
  remaining=$(python3 - "$scratch/evidence/runs.jsonl" <<'PY'
import json, sys
row = next(r for r in map(json.loads, open(sys.argv[1])) if r["name"] == "archive-32mib")
print(int(row["timeoutSeconds"] - row["durationSeconds"]))
PY
)
  run archive-observation "$remaining" 512 node "$harness/archive-observation.mjs"
fi

run prepare-native 60 512 python3 "$prior/prepare-native.py" "$repo" "$native"
test -d "$native/tests"
for file in observe.mjs worker-observer.mjs; do
  cp "$dir/pr1d-g2-adjudication/$file" "$native/tests/$file"
done
run maintenance-drain 300 512 node "$harness/drain.mjs" "$native/tests/worker-observer.mjs"

if raw quota-control 90 512 node --test --test-concurrency=1 "$native/tests/persistence-capacity.test.js"; then
  run quota-10gib 240 11264 node "$harness/quota.mjs"
fi

if raw reader-control 120 512 node --test --test-concurrency=1 --test-name-pattern   'reader limits count|multiple concurrent readers|backup preserves rich history|SIGKILL before backup completion'   "$native/tests/persistence-lifecycle.test.js" "$native/tests/persistence-backup.test.js"; then
  run reader-64-sessions 180 512 node "$harness/readers.mjs" sessions
  run reader-union 300 2048 node "$harness/readers.mjs" union
  run reader-size-preflight 180 512 node "$harness/reader-size-preflight.mjs"
fi

# Provision local dependencies using only disposable directories.
browserHome=$scratch/tmp/browser-setup
browser=$browserHome/browsers/chromium-1194/chrome-linux/chrome
libs=$browserHome/extracted/usr/lib/x86_64-linux-gnu
browserEnv=()
if raw browser-setup 420 1024 bash -c '
  set -euo pipefail
  cd "$TMPDIR"
  apt-get download libnspr4 libnss3 libasound2t64
  mkdir extracted
  for package in ./*.deb; do sha256sum "$package"; dpkg-deb -x "$package" extracted; done
  cd "$1"
  PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/browsers" node node_modules/playwright-core/cli.js install chromium --no-shell
  export LD_LIBRARY_PATH="$2"
  "$3" --version
  printf "%s  %s\n" 85918a9937192b78da8edb51c38a7af4920ac6bd9ba19939ecb0bb724d5a1a95 "$3" | sha256sum --check
  ldd "$3"
  ! ldd "$3" | rg "not found"
' _ "$repo" "$libs" "$browser"; then
  browserEnv=("CHROME_BIN=$browser" "CHROMIUM_BIN=$browser" "LD_LIBRARY_PATH=$libs")
fi

python=$scratch/tmp/python-setup/venv/bin/python
pythonEnv=()
if raw python-setup 240 512 bash -c '
  set -euo pipefail
  python3 -m venv --without-pip "$TMPDIR/venv"
  python3 -m pip --python "$TMPDIR/venv/bin/python" install --no-cache-dir -r cas-service/requirements.lock
  python3 -m pip --python "$TMPDIR/venv/bin/python" freeze
'; then
  pythonEnv=("PYTHON=$python")
  run cas-python 120 512 "$python" -m unittest discover -s cas-service/tests -v
fi

run full-serial 1800 2048 env "${browserEnv[@]}" "${pythonEnv[@]}" node --test --test-concurrency=1
run native-persistence 1800 2048 node --test --test-concurrency=1 "$native"/tests/persistence-*.test.js
run r1-h01 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-logs/superseded-current-regression.mjs"
run r1-faults 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-logs/independent-cases.mjs"
run r2-storage 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-round2/storage-faults.mjs"
run r2-h03 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-round2/cache-ack-race.mjs"
run r2-cache 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-round2/cache-integrity.mjs"
run r3-adversarial 420 512 node --test --test-concurrency=1 "$dir/pr1d-native-round3/adversarial.mjs"
run r3-controls 420 512 node --test --test-concurrency=1 "$dir"/pr1d-native-round3/{metadata-boundary,backup-gc,publication-controls}.mjs
run publication-ruling 120 512 node --test --test-concurrency=1 "$prior/publication-ruling.mjs"
run g2-existing 180 512 node --test --test-concurrency=1 --test-name-pattern 'four interrupted recovery epochs.*current.before-rename|G2 requires terminal proof'   "$native/tests/persistence-state-machine.test.js" "$native/tests/persistence-lifecycle-faults.test.js"

# Preserve the historical lease script bytes. Copy the scripts to the same
# relative depth so their generated JSON goes to scratch.
mkdir -p "$scratch/lease/docs/rfc/unified-visual-architecture/evidence/harness"
ln -s "$repo/src" "$scratch/lease/src"
lease=$scratch/lease/docs/rfc/unified-visual-architecture/evidence/harness
cp "$prior"/lease-{diagnostic,observer,failures}.mjs "$lease/"
observer="NODE_OPTIONS=--import=$lease/lease-observer.mjs"
trace="PR1D_LEASE_TRACE=$scratch/evidence/lease-events.jsonl"
run lease-normal 90 512 env "$observer" "$trace" node "$lease/lease-diagnostic.mjs"
run lease-delay 90 512 env "$observer" "$trace" PR1D_SPAWN_DELAY_MS=20 PR1D_DIAGNOSTIC_ATTEMPTS=20   PR1D_LEASE_TAG=lease-delayed-parent-results node "$lease/lease-diagnostic.mjs"
run lease-failures 120 512 env "$observer" "$trace" node --test --test-concurrency=1 "$lease/lease-failures.mjs"
run contracts 90 512 node --test "$dir/contract-validation.spec.mjs"
run formal-examples 90 512 node "$dir/validate-contract-examples.mjs"
run docs-check 90 512 npm run docs:check
run release-check 90 512 npm run release:check
run architecture-baseline 120 512 bash -c '
  set -euo pipefail
  root=$1
  mkdir "$TMPDIR/tree"
  git archive 29d097833688ddb649a88cb2a09f22ba5fadda8e | tar -x -C "$TMPDIR/tree"
  mkdir "$TMPDIR/tree/node_modules"
  ln -s "$root/node_modules/zod" "$TMPDIR/tree/node_modules/zod"
  export GIT_DIR="$root/.git" GIT_WORK_TREE="$TMPDIR/tree" GIT_INDEX_FILE="$TMPDIR/index"
  cd "$TMPDIR/tree"
  git read-tree 29d097833688ddb649a88cb2a09f22ba5fadda8e
  node "$2/evidence/check-consistency.mjs"
' _ "$repo" docs/rfc/unified-visual-architecture
