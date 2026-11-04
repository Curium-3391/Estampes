"""Bind final report/new artifacts; never rewrite baseline evidence or raw logs."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
BASE='d9aaa49f27d195ed53baeb12e95e434f1a7b10b0'
seal=OUT/'manifest.json'
runs=[json.loads(l) for l in (OUT/'runs.jsonl').read_text().splitlines()]
for r in runs:
 p=OUT/r['log'];assert hashlib.sha256(p.read_bytes()).hexdigest()==r['sha256'],f'Raw log changed: {r["name"]}'
required=['g2-final-bounded','complete-node22-serial-retest','r1-h01-corrected-fixture','r1-independent','r2-storage','r2-cache','r2-ack','r3-publication','r3-backup','contracts','formal-examples','cas-python','docs','release','architecture','syntax','whitespace']
byName={r['name']:r for r in runs}
required+=['r3-metadata','docs-delivery','syntax-final','timeout-store-preservation','whitespace-delivery','startup-fault-baseline-control','startup-fault-candidate-control','b-negative-baseline','b-negative-candidate','b-canonical-parity']
for name in required:
 assert name in byName and byName[name]['exitCode']==0 and byName[name]['stop'] is None,f'Unqualified required check: {name}'
current=hashlib.sha256((ROOT/'src/documents/validation.js').read_bytes()).hexdigest()
for name in ['g2-final-bounded','complete-node22-serial','complete-node22-serial-retest']:
 inputs=json.loads((OUT/name/'input-sha256.json').read_text());assert inputs['src/documents/validation.js']==current,'Qualified source differs from final source'
# Create the path before preservation inventory to avoid a self-inventory cycle.
if not seal.exists():seal.write_text('{}\n')
subprocess.run(['python3',str(ROOT/'scripts/pr1d-remediation/verify-preservation.py')],cwd=ROOT,check=True)
paths=set(subprocess.check_output(['git','diff','--name-only',BASE],cwd=ROOT,text=True).splitlines()+subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=ROOT,text=True).splitlines())
files={}
for name in sorted(paths):
 p=ROOT/name
 if p.is_file() and p!=seal:
  data=p.read_bytes();files[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
result={'baseline':BASE,'productionAncestor':'29d097833688ddb649a88cb2a09f22ba5fadda8e','branch':subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip(),'candidateValidationSha256':current,'files':files,'runCount':len(runs),'nonzeroRuns':[{'name':r['name'],'exitCode':r['exitCode'],'stop':r['stop']} for r in runs if r['exitCode'] or r['stop']],'excludedInterrupted':'a-history-50-1 has no terminal receipt; raw evidence retained','nativeReacceptance':'BLOCKED','production':'NOT QUALIFIED','selfExcluded':'manifest.json excludes itself; final delivery commit resolved by git log -1 -- report path'}
seal.write_text(json.dumps(result,indent=2)+'\n')
print(f'Sealed {len(files)} final inputs/artifacts, {len(runs)} immutable raw logs; native remains BLOCKED')
