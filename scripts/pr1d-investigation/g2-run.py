from run import run,NODE,HERE,REPO
import os,pathlib
extra={'PR1D_G2_PRESERVE':'1','NODE_OPTIONS':'--import='+str(HERE/'g2-preload.mjs')}
for n in range(1,5):
 r=run(f'g2-attempt-{n}',120,[NODE,'--test','--test-concurrency=1','--test-name-pattern=R3-B1 / four interrupted recovery epochs preserve exact claims and retry / current.before-rename$','tests/persistence-state-machine.test.js'],extra=extra)
 if r['exitCode'] or r['stop']:break
