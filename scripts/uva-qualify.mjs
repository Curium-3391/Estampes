#!/usr/bin/env node
// Durability qualification for the UVA canvas mirror, runnable in any Linux
// container. It produces raw evidence (JSON) and a pass/fail per scenario.
//
//   node scripts/uva-qualify.mjs [--out report.json] [--history 200] [--crashes 25] [--store 1] [--edit one] [--progress 250] [--day-every 100] [--think-ms 1000] [--idle-ms 500]
//
// --store 1 opens the store the way ESTAMPES_CANVAS_STORE=uva does (residual, no sidecar).
// What it can prove:  process-crash safety (SIGKILL), no false ACK, long-history
// cost, restart/recovery, export round-trip, clean ENOSPC behaviour on a real
// size-limited filesystem (needs root for `mount -t tmpfs`; skipped otherwise).
// What it cannot prove: host power-loss or real ext4/XFS fsync behaviour. Those
// remain open under issue #91 and are reported as such, never as passed.
import { mkdtemp, rm, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createUvaService } from '../src/uva/service.js';

const HERE = fileURLToPath(import.meta.url);
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const PROFILE = arg('profile', 'linux-process-crash-test');
const sha = b => createHash('sha256').update(b).digest('hex');
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; };
const mb = n => Math.round(n / 1048576 * 100) / 100;

async function dirBytes(p) {
  let n = 0;
  for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
    const f = join(p, e.name);
    n += e.isDirectory() ? await dirBytes(f) : (await stat(f)).size;
  }
  return n;
}
async function fileCount(p) {
  let n = 0;
  for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) n += e.isDirectory() ? await fileCount(join(p, e.name)) : 1;
  return n;
}
async function image(seed = 1) {
  const bytes = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: seed % 255, g: 90, b: 160 } } }).png().toBuffer();
  return { bytes, imageId: 'img:' + sha(bytes).slice(0, 16) };
}
// A canvas with `n` marks, growing the way a real session does.
// --edit one: every commit changes a single mark (what a real edit does); by default
// every mark's label changes, which is the worst case for history size.
let edits = 0;
const EDIT_ONE = arg('edit') === 'one', edited = new Map();
function canvas(img, n, tag = '') {
  const marks = [];
  if (EDIT_ONE) edited.set(edits++ % n, tag);
  for (let i = 0; i < n; i++) marks.push({ id: 'm' + i, author: i % 3 ? 'user' : 'gpt', type: 'rect', x: (i % 10) / 12, y: (Math.floor(i / 10) % 10) / 12, x2: (i % 10) / 12 + .05, y2: (Math.floor(i / 10) % 10) / 12 + .05, label: 'mark ' + i + (EDIT_ONE ? (edited.get(i) ?? '') : tag) });
  return { version: 1, imageId: img.imageId, width: 640, height: 400, marks, layers: [], savedAt: new Date().toISOString() };
}
const open = (dir, extra = {}) => createUvaService({ enabled: true, directory: dir, profile: PROFILE, mirror: true, mirrorMaxCommits: 1e9, ...(arg('store') ? { canvasStore: true } : {}), ...(arg('idle-ms') !== undefined ? { compactionIdleMs: +arg('idle-ms') } : {}), ...extra });
const fresh = async () => { const d = await mkdtemp(join(tmpdir(), 'uva-qual-')); return d; };
const rss = () => mb(process.memoryUsage().rss);

// ---------------------------------------------------------------- scenarios
async function history(n) {
  const dir = await fresh(), img = await image(), svc = await open(dir), lat = [], disk = [];
  const t0 = performance.now();
  let revision = 0, failure = null, clock = null;
  for (let i = 1; i <= n; i++) {
    const s = performance.now();
    try { const r = await svc.syncCanvas({ canvas: canvas(img, EDIT_ONE ? 120 : Math.min(i, 120), ' #' + i), bytes: img.bytes }); revision = r.revision; }
    catch (e) { failure = { at: i, code: e.code, message: e.message }; break; }
    lat.push(performance.now() - s);
    // --think-ms N: the user pauses N ms between saves (idle compaction runs then).
    const think = +arg('think-ms', 0);
    if (think) await new Promise(r => setTimeout(r, think));
    // --day-every N (test profile): one simulated day passes every N commits, so
    // the 7-day replay window and the 1-day G2 grace elapse within the run.
    const dayEvery = +arg('day-every', 0);
    if (dayEvery && i % dayEvery === 0) { clock = (clock ?? Date.now()) + 864e5; await svc.store.maintenance('clock', { nowMs: clock }); }
    if (i % 25 === 0) disk.push({ commit: i, mb: mb(await dirBytes(dir)), rssMb: rss() });
    const every = +arg('progress', 0);
    if (every && i % every === 0) {
      const w = lat.slice(-every);
      console.error(`# commit ${i}: window p50 ${pct(w, .5)} ms p95 ${pct(w, .95)} ms, disk ${mb(await dirBytes(dir))} MB, files ${await fileCount(dir)}, rss ${rss()} MB, dir ${dir}`);
    }
  }
  const diag = await svc.diagnostics(), storeDiag = await svc.store.diagnostics();
  await svc.close();
  // restart and re-verify
  const t1 = performance.now(), svc2 = await open(dir), coldOpenMs = Math.round(performance.now() - t1);
  const listed = await svc2.dispatch({ action: 'list' }, 'user');
  const reopened = listed.workspaces[0]?.revision ?? 0;
  await svc2.close();
  const result = {
    commits: lat.length, requested: n, failure, finalRevision: revision, revisionAfterRestart: reopened,
    latencyMs: { p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), max: pct(lat, 1) },
    totalSeconds: Math.round((performance.now() - t0) / 100) / 10, diskMb: mb(await dirBytes(dir)), diskSamples: disk,
    maintenance: diag.maintenance, state: diag.state, problem: diag.problem, compaction: storeDiag.compaction ?? null, reclaim: storeDiag.reclaim ?? null, coldOpenMs, peakRssMb: rss(),
  };
  result.pass = !failure && reopened === revision && diag.state === 'ready';
  if (arg('keep')) { result.keptAt = dir; } else await rm(dir, { recursive: true, force: true });
  return result;
}

// Child process: sync forever, print every ACKed revision to stdout.
async function crashChild(dir) {
  const img = await image(), svc = await open(dir);
  for (let i = 1; ; i++) {
    const r = await svc.syncCanvas({ canvas: canvas(img, Math.min(i, 60), ' #' + i), bytes: img.bytes });
    process.stdout.write(`ACK ${r.revision}\n`);
  }
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(what + ' did not finish in ' + ms + ' ms'), { code: 'TIMEOUT' })), ms))]);
// One store, killed repeatedly with SIGKILL while a child commits continuously.
// Outcomes per round: ok | wedged (store opens read-only-recovery, data intact) |
// FALSE-ACK (an acknowledged revision is missing) | error (cannot open).
async function crashTrial(rounds, trial, bundleBase) {
  const dir = await fresh(), img = await image(), rows = [];
  let verdict = 'survived', bundle = null;
  for (let r = 0; r < rounds; r++) {
    const child = spawn(process.execPath, [HERE, '--child', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let acked = 0, buf = '';
    child.stdout.on('data', d => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const m = /^ACK (\d+)/.exec(buf.slice(0, k)); if (m) acked = +m[1]; buf = buf.slice(k + 1); } });
    await new Promise(res => setTimeout(res, 800 + Math.random() * 2500));
    child.kill('SIGKILL');
    await new Promise(res => child.on('exit', res));
    let revision = null, state = 'unknown', problem = null, error = null, reopenMs = null, svc;
    try {
      // The OS lease is held by a helper process that exits shortly after its parent
      // is killed. Retry while it does, and record how long that took.
      const t0 = performance.now();
      for (;;) {
        try { svc = await withTimeout(open(dir), 90000, 'reopen'); break; }
        catch (e) { if (!/Second writer rejected/.test(e.message) || performance.now() - t0 > 15000) throw e; await new Promise(res => setTimeout(res, 50)); }
      }
      reopenMs = Math.round(performance.now() - t0);
      const diag = await withTimeout(svc.diagnostics(), 30000, 'diagnostics');
      state = diag.state; problem = diag.problem && { cause: diag.problem.cause, message: diag.problem.message };
      // Reads still work in read-only-recovery, so check for lost data either way.
      revision = (await withTimeout(svc.dispatch({ action: 'list' }, 'user'), 60000, 'list')).workspaces[0]?.revision ?? 0;
    } catch (e) { error = { code: e.code, message: String(e.message).slice(0, 300) }; }
    const row = { round: r, acked, revisionAfterKill: revision, state, problem, error, reopenMs };
    rows.push(row);
    process.stderr.write(`  trial ${trial} round ${r}: acked ${acked} -> ${state}${error ? ' ERROR ' + error.code : ''}\n`);
    const lost = revision !== null && revision < acked;
    if (lost || error || state !== 'ready') {
      verdict = lost ? 'FALSE-ACK' : error ? 'error' : 'wedged';
      try { await svc?.close(); } catch {}
      bundle = join(bundleBase, 'trial-' + trial); await mkdir(bundleBase, { recursive: true }); execFileSync('cp', ['-a', dir, bundle]);
      break;
    }
    await svc.close();
  }
  let writableAfter = null;
  if (verdict === 'survived') {
    try { const svc = await open(dir); await svc.syncCanvas({ canvas: canvas(img, 5, 'final'), bytes: img.bytes }); writableAfter = true; await svc.close(); } catch { writableAfter = false; }
  }
  await rm(dir, { recursive: true, force: true });
  return { trial, verdict, roundsRun: rows.length, writableAfter, bundle, last: rows[rows.length - 1], reopenMs: rows.map(x => x.reopenMs).filter(x => x !== null) };
}
async function crash(rounds) {
  const trials = +arg('trials', 6), bundleBase = arg('bundle-dir', join(tmpdir(), 'uva-qualify-failures-' + Date.now()));
  const results = [];
  for (let i = 0; i < trials; i++) results.push(await crashTrial(rounds, i, bundleBase));
  const count = v => results.filter(r => r.verdict === v).length;
  const reopen = results.flatMap(r => r.reopenMs);
  const out = { trials, roundsPerTrial: rounds, survived: count('survived'), wedged: count('wedged'), falseAck: count('FALSE-ACK'), openErrors: count('error'),
    roundsBeforeWedge: results.filter(r => r.verdict !== 'survived').map(r => r.roundsRun), reopenMs: { p50: pct(reopen, .5), max: pct(reopen, 1) },
    wedgeReasons: [...new Set(results.filter(r => r.verdict === 'wedged').map(r => r.last.problem?.message))], trialsDetail: results };
  // Hard requirement: an acknowledged revision is never lost, and every store can be opened.
  out.dataSafe = out.falseAck === 0 && out.openErrors === 0;
  // Full pass additionally requires that no crash leaves the writer unavailable.
  out.pass = out.dataSafe && out.wedged === 0;
  return out;
}

async function enospc() {
  // The engine refuses to start on a filesystem smaller than its 256 MiB quota
  // ("Capacity admission refused"), so use a 320 MiB tmpfs and then fill it until
  // only a few hundred KiB remain.
  let mount;
  try {
    mount = await mkdtemp(join(tmpdir(), 'uva-enospc-'));
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=320m,mode=700', 'tmpfs', mount], { stdio: 'pipe' });
  } catch (e) { return { skipped: true, reason: 'cannot mount a size-limited tmpfs here (' + String(e.message).split('\n')[0] + ')' }; }
  const dir = join(mount, 'beta'), filler = join(mount, 'filler.bin');
  await mkdir(dir, { mode: 0o700 });
  const img = await image(), out = { filesystem: 'tmpfs 320 MiB, filled to the brim' };
  const freeKb = () => +execFileSync('sh', ['-c', `df -k --output=avail ${mount} | tail -1`]).toString().trim();
  try {
    let svc = await open(dir), acked = 0, firstError = null;
    for (let i = 1; i <= 3; i++) acked = (await svc.syncCanvas({ canvas: canvas(img, 20 + i), bytes: img.bytes })).revision;
    const free = freeKb(), leave = +arg('leave-kb', 160);
    execFileSync('fallocate', ['-l', String((free - leave) * 1024), filler]);
    out.freeKbAfterFill = freeKb();
    for (let i = 4; i <= 400; i++) {
      try { acked = (await svc.syncCanvas({ canvas: canvas(img, Math.min(i, 100), ' #' + i), bytes: img.bytes })).revision; }
      catch (e) { firstError = { at: i, code: e.code, message: String(e.message).slice(0, 200) }; break; }
    }
    out.ackedBeforeFull = acked; out.firstError = firstError;
    out.diagnosticsAfterFull = await svc.diagnostics().then(d => ({ state: d.state, problem: d.problem })).catch(e => ({ error: e.message }));
    await svc.close().catch(() => {});
    let reopened = null;
    try { const s2 = await open(dir); reopened = (await s2.dispatch({ action: 'list' }, 'user')).workspaces[0]?.revision ?? 0; out.stateAfterRestartWhileFull = (await s2.diagnostics()).state; await s2.close(); }
    catch (e) { out.restartError = { code: e.code, message: String(e.message).slice(0, 200) }; }
    out.revisionAfterRestart = reopened;
    await rm(filler);
    try { const s3 = await open(dir); const r = await s3.syncCanvas({ canvas: canvas(img, 7, 'after-space'), bytes: img.bytes }); out.writableAfterSpaceFreed = true; out.revisionAfterSpace = r.revision; await s3.close(); }
    catch (e) { out.writableAfterSpaceFreed = false; out.afterSpaceError = { code: e.code, message: String(e.message).slice(0, 200) }; }
    // Pass: it failed cleanly, nothing ACKed was lost, no phantom extra state beyond one in-flight commit, and writes resume.
    out.pass = Boolean(firstError) && !out.restartError && reopened >= acked && reopened <= acked + 1 && out.writableAfterSpaceFreed === true;
    if (reopened === acked + 1) out.note = 'the commit that hit ENOSPC had in fact been published (ACK lost, state intact)';
  } finally {
    try { execFileSync('umount', ['-l', mount]); } catch {}
    await rm(mount, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

async function exportRoundTrip() {
  const dir = await fresh(), img = await image(), svc = await open(dir);
  await svc.syncCanvas({ canvas: canvas(img, 40), bytes: img.bytes });
  const id = (await svc.dispatch({ action: 'list' }, 'user')).workspaces[0].id;
  const exp = await svc.dispatch({ action: 'export', documentId: id }, 'user');
  const bytes = await svc.readExport(exp.exportId);
  await svc.close();
  const dir2 = await fresh(), svc2 = await open(dir2, { mirror: false });
  const staged = await svc2.stageRecovery(bytes);
  let imported = null, error = null;
  try {
    const prepared = await svc2.dispatch({ action: 'prepare', requestId: 'req:' + randomUUID(), operation: { type: 'recover', exportId: staged } }, 'user');
    imported = await svc2.dispatch({ action: 'commit', prepared: prepared.prepared }, 'user');
  } catch (e) { error = { code: e.code, message: String(e.message).slice(0, 200) }; }
  const listed = (await svc2.dispatch({ action: 'list' }, 'user')).workspaces;
  await svc2.close();
  await rm(dir, { recursive: true, force: true }); await rm(dir2, { recursive: true, force: true });
  return { exportBytes: bytes.length, exportHashMatchesId: sha(bytes) === exp.exportId, imported: Boolean(imported), error, workspacesAfterImport: listed.length, pass: sha(bytes) === exp.exportId && !error && listed.length >= 1 };
}

async function manyDocuments(count) {
  const dir = await fresh(), svc = await open(dir), lat = [];
  for (let i = 0; i < count; i++) {
    const img = await image(i + 1), s = performance.now();
    try { await svc.syncCanvas({ canvas: canvas(img, 10), bytes: img.bytes }); } catch (e) { await svc.close(); await rm(dir, { recursive: true, force: true }); return { count: i, failure: e.message, pass: false }; }
    lat.push(performance.now() - s);
    // --day-every N (test profile): one simulated day passes every N commits, so
    // the 7-day replay window and the 1-day G2 grace elapse within the run.
    const dayEvery = +arg('day-every', 0);
    if (dayEvery && i % dayEvery === 0) { clock = (clock ?? Date.now()) + 864e5; await svc.store.maintenance('clock', { nowMs: clock }); }
  }
  await svc.close();
  const t = performance.now(), svc2 = await open(dir), cold = Math.round(performance.now() - t);
  const listed = (await svc2.dispatch({ action: 'list' }, 'user')).workspaces.length;
  await svc2.close();
  const r = { documents: count, listedAfterRestart: listed, coldOpenMs: cold, diskMb: mb(await dirBytes(dir)), latencyMs: { p50: pct(lat, .5), p95: pct(lat, .95) }, rssMb: rss(), pass: listed === count };
  await rm(dir, { recursive: true, force: true });
  return r;
}

// ------------------------------------------------------------------- main
if (process.argv[2] === '--child') { await crashChild(process.argv[3]); }
else {
  const report = { generatedAt: new Date().toISOString(), node: process.version, profile: PROFILE, platform: process.platform + ' ' + execFileSync('uname', ['-r']).toString().trim(), rootFilesystem: execFileSync('sh', ['-c', "df -T / | tail -1 | awk '{print $2}'"]).toString().trim(), scenarios: {} };
  const only = arg('only'); const run = async (name, fn) => { if (only && only !== name) return; const s = performance.now(); process.stderr.write(`# ${name} ...\n`); try { report.scenarios[name] = await fn(); } catch (e) { report.scenarios[name] = { pass: false, error: e.stack || String(e) }; } report.scenarios[name].seconds = Math.round((performance.now() - s) / 100) / 10; process.stderr.write(`# ${name}: ${report.scenarios[name].pass === undefined ? 'skipped' : report.scenarios[name].pass ? 'PASS' : 'FAIL'}\n`); };
  await run('history', () => history(+arg('history', 200)));
  await run('crash-sigkill', () => crash(+arg('crashes', 25)));
  await run('enospc', enospc);
  await run('export-roundtrip', exportRoundTrip);
  await run('many-documents', () => manyDocuments(+arg('documents', 40)));
  report.notQualifiable = ['host power-loss / fsync ordering on real ext4 or XFS (issue #91)', 'physical-disk ENOSPC (tmpfs is used)', 'near-64 MiB cold open (issue #89)', 'native-profile mount trust (needs a local ext4/XFS host mount)'];
  report.allPassed = Object.values(report.scenarios).every(s => s.pass === true || s.skipped);
  const out = arg('out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPassed ? 0 : 1);
}
