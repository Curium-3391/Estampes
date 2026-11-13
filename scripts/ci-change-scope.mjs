#!/usr/bin/env node
// PR CI risk classification. Fail closed: missing refs, an unknown path, or
// a diff error selects the full integrity/browser/CAS suite.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const documentation = (path) => path.endsWith('.md') || path.startsWith('docs/') || path.startsWith('.github/ISSUE_TEMPLATE/');
const fastEligible = (path) =>
  path.startsWith('public/') ||
  path.startsWith('src/image/') ||
  path.startsWith('src/scene/') ||
  path.startsWith('src/visual/') ||
  path.startsWith('src/surface/') ||
  ['src/image-ops.js', 'src/mark-render.js', 'src/geometry.js', 'src/pixel-font.js'].includes(path);

export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 'full';
  if (paths.every(documentation)) return 'docs';
  return paths.every((path) => documentation(path) || fastEligible(path)) ? 'fast' : 'full';
}

export function classifyDiff(event, base, head) {
  // Release/merge queues or manually started workflows always run full tests.
  if (event !== 'pull_request' || !/^[0-9a-f]{40}$/i.test(base ?? '') || !/^[0-9a-f]{40}$/i.test(head ?? '')) {
    return { mode: 'full', reason: 'unrecognized event or revision' };
  }
  try {
    // NUL delimiters handle unusual names. The checked-out PR merge ref is
    // always fetched; using github.sha avoids relying on a fork's head ref.
    const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { maxBuffer: 8 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean);
    return { mode: classifyPaths(changed), reason: `${changed.length} changed path(s)` };
  } catch {
    return { mode: 'full', reason: 'Git diff unavailable' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = classifyDiff(process.env.GITHUB_EVENT_NAME, process.env.BASE_SHA, process.env.HEAD_SHA);
  console.log(`CI scope: ${result.mode} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`);
}
