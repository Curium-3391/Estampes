"""Verify completed raw evidence and suite inputs; manifest excludes itself."""
import hashlib,json,pathlib,re,subprocess
here=pathlib.Path(__file__).resolve().parent;root=here.parents[4]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
runs=[json.loads(line) for line in (here/'runs.jsonl').read_text().splitlines()]
assert len({r['name'] for r in runs})==len(runs)
for run in runs:assert sha(here/(run['name']+'.log'))==run['sha256'],('raw log changed',run['name'])
for runName,external,stored in [('backup-relocation-red-corrected','/tmp/estampes-backup-relocation-test.mjs','backup-relocation-probe.mjs'),('backup-relocation-baseline','/tmp/estampes-backup-relocation-baseline.mjs','backup-relocation-baseline-probe.mjs')]:
 row=next(r for r in runs if r['name']==runName);assert sha(here/stored)==row['inputs'][external]
row=next(r for r in runs if r['name']=='unknown-current-owner-red');assert sha(here/'unknown-current-owner-probe.mjs')==row['inputs']['/tmp/estampes-unknown-current-claim.mjs']
sealed=next(r for r in runs if r['name']=='delivery-node22-serial')
for name,expected in sealed['inputs'].items():
 if name.startswith(('src/','tests/')):assert sha(root/name)==expected,('source changed after complete suite',name)
log=(here/'delivery-node22-serial.log').read_text();counts={key:int(re.search('^# '+key+r' (\d+)$',log,re.M).group(1)) for key in ['tests','pass','fail','skipped','cancelled']}
assert sealed['exitCode']==0 and counts=={'tests':519,'pass':517,'fail':0,'skipped':2,'cancelled':0},counts
source=json.loads((here/'source-seal.json').read_text())
for row in source['sourceAndTests']:assert sha(root/row['path'])==row['sha256']
changed=set(subprocess.check_output(['git','diff','--name-only','31dae29f1cf7d1e8caf6c670124eed7c7ed91e11'],cwd=root,text=True).splitlines())
changed.update(subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=root,text=True).splitlines())
changed.add(str((here/'manifest.json').relative_to(root)));changed.add(str((here/'changed-files.json').relative_to(root)))
(here/'changed-files.json').write_text(json.dumps(sorted(changed),indent=2)+'\n')
artifacts=[]
for p in sorted(here.iterdir()):
 if p.is_file() and p.name!='manifest.json':artifacts.append({'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p)})
manifest={'schema':'estampes.pr1d-state-machine-hardening-evidence/1','baseline':'31dae29f1cf7d1e8caf6c670124eed7c7ed91e11','implementationHead':source['implementationHead'],'stateMachineRemediation':'PASS (process-crash)','filesystemTrustHardening':'PASS (private trusted UID only)','integrityRemediation':'BLOCKED (hostile same-UID exclusion not implemented)','overall':'PR-1D Overall BLOCKED','native':'NOT EXECUTED: no approved ext4/XFS mount','sealedSourceMatches':True,'counts':counts,'runCount':len(runs),'nonzeroRuns':[{'name':r['name'],'exitCode':r['exitCode']} for r in runs if r['exitCode']!=0],'artifacts':artifacts,'reportSha256':sha(root/'docs/rfc/unified-visual-architecture/PR-1D-STATE-MACHINE-HARDENING-REPORT.md'),'trustModelSha256':sha(root/'docs/rfc/unified-visual-architecture/PR-1D-FILESYSTEM-TRUST-MODEL.md'),'checkerSha256':sha(here.parent/'check-consistency.mjs')}
(here/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='artifacts'},indent=2))
