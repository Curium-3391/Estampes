#!/usr/bin/env bash
set -eu
pr1d_node=$1
for pr1d_path in src/persistence/{backup,coordinator,filesystem,gc,lease,ownership,records,temporary-attribution}.js tests/persistence-{state-machine,filesystem-trust}.test.js tests/fixtures/round3-boundary-preload.mjs docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs; do
 "$pr1d_node" --check "$pr1d_path"
done
git fsck --strict --no-reflogs
git merge-base --is-ancestor b2f853c5e7473a008552ff70c838de3faff07c20 31dae29f1cf7d1e8caf6c670124eed7c7ed91e11
git merge-base --is-ancestor 94f3b59f1b5eabe6ce8dabfc33362ddb35a27bc4 31dae29f1cf7d1e8caf6c670124eed7c7ed91e11
test -z "$(git diff --name-only b2f853c5e7473a008552ff70c838de3faff07c20 31dae29f1cf7d1e8caf6c670124eed7c7ed91e11 -- src tests scripts server.js package.json package-lock.json)"
