"""Seal completed evidence; do not run through run.py (the manifest excludes itself)."""
import gzip,hashlib,json,pathlib,re
here=pathlib.Path(__file__).resolve().parent;root=here.parents[4]
runs=[json.loads(line) for line in (here/'runs.jsonl').read_text().splitlines()]
for run in runs:
 raw=(here/(run['name']+'.log')).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==run['sha256'],('changed raw run log',run['name'])
sealed=next(r for r in runs if r['name']=='delivery-node22-serial')
for name,expected in sealed['inputs'].items():
 if name.startswith(('src/','tests/')):assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected,('source changed after sealed suite',name)
for p in json.loads((here/'profile-summary.json').read_text()):
 for a in p['artifacts']:
  raw=(here/a['path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==a['storedSha256'];assert hashlib.sha256(gzip.decompress(raw)).hexdigest()==a['rawSha256']
log=(here/'delivery-node22-serial.log').read_text();counts={key:int(re.search('^# '+key+r' (\d+)$',log,re.M).group(1)) for key in ['tests','pass','fail','skipped','cancelled']}
assert sealed['exitCode']==0 and counts=={'tests':486,'pass':484,'fail':0,'skipped':2,'cancelled':0}
artifacts=[]
for p in sorted(here.iterdir()):
 if p.is_file() and p.name!='manifest.json':
  raw=p.read_bytes();artifacts.append({'path':p.name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
manifest={'schema':'estampes.pr1d-integrity-hardening-evidence/1','baseline':'a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0','implementationHead':json.loads((here/'source-seal.json').read_text())['implementationHead'],'status':'Integrity Remediation Candidate Ready','overall':'PR-1D Overall BLOCKED','nativeReacceptance':'NOT EXECUTED: no approved native ext4/XFS mount','sealedSourceMatches':True,'counts':counts,'runCount':len(runs),'nonzeroRuns':[{'name':r['name'],'exitCode':r['exitCode']} for r in runs if r['exitCode']!=0],'artifacts':artifacts,'reportSha256':hashlib.sha256((root/'docs/rfc/unified-visual-architecture/PR-1D-INTEGRITY-HARDENING-REPORT.md').read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256((here.parent/'check-consistency.mjs').read_bytes()).hexdigest()}
(here/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='artifacts'},indent=2))
