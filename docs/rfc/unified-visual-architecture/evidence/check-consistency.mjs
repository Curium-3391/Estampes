// Phase 0 review-package checks. No production imports or mutations.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dir = join(root, 'docs/rfc/unified-visual-architecture');
const errors = [];
const requireCheck = (ok, message) => { if (!ok) errors.push(message); };
for (let i = 1; i <= 8; i++) {
  const id = String(i).padStart(3, '0');
  requireCheck(existsSync(join(dir, `RFC-${id}.md`)), `missing RFC-${id}`);
  const adr = join(dir, `adr/ADR-${id}.md`);
  requireCheck(existsSync(adr), `missing ADR-${id}`);
  if (existsSync(adr)) for (const heading of ['Context', 'Options Considered', 'Decision', 'Rationale', 'Consequences', 'Rejected Alternatives'])
    requireCheck(readFileSync(adr, 'utf8').includes(`## ${heading}`), `${adr} missing ${heading}`);
}
const matrix = readFileSync(join(dir, 'TEST-MATRIX.md'), 'utf8');
const caseIds = [...matrix.matchAll(/^\| (UVA-\d{2})\b/gm)].map(m => m[1]);
requireCheck(caseIds.length === 40 && new Set(caseIds).size === 40, 'test cases must be 40 unique IDs');
for (let i = 1; i <= 40; i++) requireCheck(caseIds.includes(`UVA-${String(i).padStart(2, '0')}`), `missing case ${i}`);
const inventory = JSON.parse(readFileSync(join(dir, 'evidence/source-index.json'), 'utf8'));
for (const f of inventory.files) {
  const hash = createHash('sha256').update(readFileSync(join(root, f.path))).digest('hex');
  requireCheck(hash === f.sha256, `baseline production/config source modified: ${f.path}`);
}
const roadmap = readFileSync(join(root, 'IMPLEMENTATION-ROADMAP.md'), 'utf8');
const prs = new Set([...roadmap.matchAll(/PR-([0-7][A-C])/g)].map(m => m[0]));
const collect = p => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? collect(join(p, e.name)) : e.name.endsWith('.md') ? [join(p, e.name)] : []);
const docs = collect(dir);
for (const p of docs) {
  const content = readFileSync(p, 'utf8');
  for (const m of content.matchAll(/PR-([0-7][A-C])/g)) requireCheck(prs.has(m[0]), `${p}: undefined ${m[0]}`);
  for (const m of content.matchAll(/\bUVA-\d{2}\b/g)) requireCheck(caseIds.includes(m[0]), `${p}: undefined ${m[0]}`);
  for (const m of content.matchAll(/\bOD-(\d{2})\b/g)) requireCheck(+m[1] >= 1 && +m[1] <= 6, `${p}: undefined ${m[0]}`);
}
const executions = JSON.parse(readFileSync(join(dir, 'evidence/execution-manifest.json'), 'utf8'));
for (const run of executions.runs) {
  const data = readFileSync(join(dir, 'evidence', run.log));
  requireCheck(createHash('sha256').update(data).digest('hex') === run.sha256 && data.length === run.bytes, `execution log integrity: ${run.log}`);
}
const changed = execFileSync('git', ['diff', '--name-only', inventory.commit], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const p of new Set([...changed, ...untracked])) requireCheck(p.startsWith('docs/rfc/unified-visual-architecture/') || ['IMPLEMENTATION-ROADMAP.md', 'docs/ARCHITECTURE.md', 'tests/uva-characterization.test.js'].includes(p), `outside Phase 0 scope: ${p}`);
if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(`Phase 0 consistency: 8 RFCs, 8 ADRs, 40 cases, ${prs.size} PR IDs, ${inventory.files.length} unchanged production/config files; scope and references checked.\n`);
