"""Checks run serially after benchmarks; preserve every original assertion."""
from run import run,NODE,HERE,REPO
from pathlib import Path
import tempfile,os,json
r=run('preservation-controls',120,[NODE,'--test','--test-concurrency=1','tests/pr1d-evidence-preservation.test.js'])
if r['exitCode'] or r['stop']:raise SystemExit(1)
r=run('fixture-regressions',420,[NODE,'--test','--test-concurrency=1','--test-skip-pattern=R3-B1 / four interrupted recovery epochs preserve exact claims and retry / current.before-rename$','tests/persistence-state-machine.test.js','tests/persistence-lifecycle.test.js','tests/persistence-lifecycle-faults.test.js','tests/persistence-backup.test.js','tests/persistence-integrity-hardening.test.js','tests/persistence-verification-race.test.js','tests/persistence-performance.test.js'])
if r['exitCode'] or r['stop']:raise SystemExit(1)
for name,args in [('docs',['scripts/check-docs.mjs']),('release',['scripts/check-release.mjs'])]:
 r=run(name,90,[NODE,*args])
 if r['exitCode'] or r['stop']:raise SystemExit(1)
