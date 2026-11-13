import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaths, classifyDiff } from '../scripts/ci-change-scope.mjs';

test('documentation and issue forms skip costly runtime tests', () => {
  assert.equal(classifyPaths(['README.md', 'docs/ARCHITECTURE.md']), 'docs');
  assert.equal(classifyPaths(['.github/ISSUE_TEMPLATE/bug_report.yml']), 'docs');
});
test('visual-only changes receive the quick regression suite', () => {
  assert.equal(classifyPaths(['src/image/transform.js', 'public/visual-surface.html']), 'fast');
  assert.equal(classifyPaths(['src/scene/ops.js', 'docs/IMAGE-PIPELINE.md']), 'fast');
});
test('storage, security, tests, build, workflows, and unknown paths require full verification', () => {
  for (const path of [
    'server.js', 'src/uva/canvas-store.js', 'src/persistence/coordinator.js',
    'src/workspace.js', 'src/security.js', 'src/modules/runtime.js',
    'cas-service/estampes_cas/server.py', 'tests/geometry.test.js',
    'package-lock.json', 'compose.yaml', '.github/workflows/pr-baseline.yml',
    'scripts/ci-change-scope.mjs', 'brand-new-component.js',
  ]) assert.equal(classifyPaths([path]), 'full', path);
});
test('mixed changes fail closed and an empty change set is not considered docs-only', () => {
  assert.equal(classifyPaths(['docs/README.md', 'src/uva/foo.js']), 'full');
  assert.equal(classifyPaths([]), 'full');
});
test('non-PR and missing revisions always trigger full validation', () => {
  assert.equal(classifyDiff('merge_group', null, null).mode, 'full');
  assert.equal(classifyDiff('workflow_dispatch', null, null).mode, 'full');
  assert.equal(classifyDiff('pull_request', 'invalid', 'invalid').mode, 'full');
});
