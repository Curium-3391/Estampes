#!/usr/bin/env node
// PR smoke/regression suite. Expensive UVA durability and persistence stress
// tests remain mandatory for affected source changes, weekly, and on release.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'tests');
const files = readdirSync(testDir).filter((file) => file.endsWith('.test.js'));
const selected = files.filter((name) =>
  (!name.startsWith('persistence-') && !name.startsWith('uva-')) ||
  name === 'uva-default.test.js'
).sort().map((name) => join(testDir, name));

if (!selected.length) {
  console.error('No fast tests found; refusing to pass an empty suite.');
  process.exit(1);
}
if (process.argv.includes('--list')) {
  console.log(selected.map((path) => path.slice(testDir.length + 1)).join('\n'));
} else {
  console.log(`Running ${selected.length} test files (heavy persistence/UVA cases reserved for full checks).`);
  const child = spawn(process.execPath, ['--test', ...selected], { stdio: 'inherit', cwd: root });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  process.exitCode = code === null ? 1 : code;
}
