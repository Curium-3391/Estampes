"""Bounded final qualification; historical sources/assertions remain immutable."""
from run import run,NODE,REPO
from pathlib import Path
import json,os,sys,tempfile,subprocess
PATTERN='R3-B1 / four interrupted recovery epochs preserve exact claims and retry / current.before-rename$'
EVIDENCE=REPO/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
mode=sys.argv[1]
if mode=='suite':
 # One instrumented original case; do not rerun it in the complete coverage run.
 g2=run('g2-final-bounded',420,[NODE,'--test','--test-concurrency=1','--test-name-pattern='+PATTERN,'tests/persistence-state-machine.test.js'],extra={'PR1D_G2_PRESERVE':'1','NODE_OPTIONS':'--import='+str(REPO/'scripts/pr1d-investigation/g2-preload.mjs')})
 full=run('complete-node22-serial',1800,[NODE,'--test','--test-concurrency=1','--test-skip-pattern='+PATTERN],extra={'CHROME_BIN':'/usr/bin/chromium','CHROMIUM_BIN':'/usr/bin/chromium'})
 print(json.dumps({'g2Exit':g2['exitCode'],'suiteExit':full['exitCode'],'excludedCase':'Separately executed with original preservation instrumentation, once only'}))
 sys.exit(full['exitCode'] or g2['exitCode'] or bool(full['stop']) or bool(g2['stop']))
elif mode=='historical':
 parent=Path(tempfile.mkdtemp(prefix='pr1d-remediation-replay-',dir='/tmp'));target=parent/'tree'
 manifest=subprocess.check_output(['python3',str(REPO/'docs/rfc/unified-visual-architecture/evidence/pr1d-state-machine-hardening/prepare-replay.py'),str(REPO),str(target)],text=True)
 (EVIDENCE/'historical-replay-hashes.json').write_text(manifest)
 root=target/'docs/rfc/unified-visual-architecture/evidence'
 accept=Path(tempfile.mkdtemp(prefix='pr1d-remediation-accept-',dir='/tmp'))
 cases=[('r1-h01','pr1d-native-logs/superseded-current-regression.mjs'),('r1-independent','pr1d-native-logs/independent-cases.mjs'),('r2-storage','pr1d-native-round2/storage-faults.mjs'),('r2-cache','pr1d-native-round2/cache-integrity.mjs'),('r2-ack','pr1d-native-round2/cache-ack-race.mjs'),('r3-adversarial','pr1d-native-round3/adversarial.mjs'),('r3-metadata','pr1d-native-round3/metadata-boundary.mjs'),('r3-publication','pr1d-native-round3/publication-controls.mjs'),('r3-backup','pr1d-native-round3/backup-gc.mjs')]
 receipts=[]
 for name,path in cases:receipts.append(run(name,600,[NODE,'--test','--test-concurrency=1',str(root/path)],extra={'PR1D_ACCEPT_ROOT':str(accept)}))
 (EVIDENCE/'historical-outcomes.json').write_text(json.dumps([{'name':r['name'],'exitCode':r['exitCode'],'stop':r['stop']} for r in receipts],indent=2)+'\n')
elif mode=='contracts':
 cases=[('contracts',[NODE,'--test','docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs']),('formal-examples',[NODE,'docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs']),('cas-python',['python3','-m','unittest','discover','-s','cas-service/tests','-v']),('docs',[NODE,'scripts/check-docs.mjs']),('release',[NODE,'scripts/check-release.mjs']),('architecture',['bash','scripts/pr1d-remediation/architecture.sh']),('syntax',['python3','scripts/pr1d-remediation/syntax.py']),('whitespace',['git','diff','--check','d9aaa49f27d195ed53baeb12e95e434f1a7b10b0'])]
 for name,argv in cases:
  r=run(name,180,argv)
  if r['exitCode'] or r['stop']:sys.exit(1)
elif mode=='historical-h01-corrected':
 parent=Path(tempfile.mkdtemp(prefix='pr1d-remediation-h01-corrected-',dir='/tmp'));target=parent/'tree'
 manifest=subprocess.check_output(['python3',str(REPO/'scripts/pr1d-remediation/prepare-replay.py'),str(REPO),str(target)],text=True)
 (EVIDENCE/'historical-replay-hashes-corrected.json').write_text(manifest)
 argv=[NODE,'--test','--test-concurrency=1',str(target/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-logs/superseded-current-regression.mjs')]
 r=run('r1-h01-corrected-fixture',180,argv)
 sys.exit(r['exitCode'] or bool(r['stop']))
elif mode=='suite-retest':
 receipts={r['name']:r for r in map(json.loads,(EVIDENCE/'runs.jsonl').read_text().splitlines())}
 assert all(receipts[n]['exitCode']==0 and receipts[n]['stop'] is None for n in ['startup-fault-baseline-control','startup-fault-candidate-control'])
 original=(EVIDENCE/'complete-node22-serial/raw.log').read_text()
 assert sum(l.startswith('not ok ') for l in original.splitlines())==1 and 'Writer startup timed out' in original
 r=run('complete-node22-serial-retest',1800,[NODE,'--test','--test-concurrency=1','--test-skip-pattern='+PATTERN],extra={'CHROME_BIN':'/usr/bin/chromium','CHROMIUM_BIN':'/usr/bin/chromium'})
 sys.exit(r['exitCode'] or bool(r['stop']))
