#!/usr/bin/env bash
set -euo pipefail
# The historical checker has a frozen historical scope. Run it on its exact
# production ancestor, then independently check this authorized diff/preservation.
pr1d_root=$(pwd)
pr1d_tree=$(mktemp -d "$TMPDIR/architecture-XXXXXX")
trap 'rm -rf -- "$pr1d_tree"' EXIT
mkdir "$pr1d_tree/tree"
git archive 29d097833688ddb649a88cb2a09f22ba5fadda8e | tar -x -C "$pr1d_tree/tree"
mkdir "$pr1d_tree/tree/node_modules"
ln -s "$pr1d_root/node_modules/zod" "$pr1d_tree/tree/node_modules/zod"
(
 export GIT_DIR="$pr1d_root/.git" GIT_WORK_TREE="$pr1d_tree/tree" GIT_INDEX_FILE="$pr1d_tree/index"
 cd "$pr1d_tree/tree"
 git read-tree 29d097833688ddb649a88cb2a09f22ba5fadda8e
 node docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs
)
python3 scripts/pr1d-remediation/verify-preservation.py
