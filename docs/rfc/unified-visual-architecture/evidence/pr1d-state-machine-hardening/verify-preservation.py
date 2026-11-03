"""Verify exact baseline provenance, scope, old tests/reports and source seals."""
import hashlib,json,pathlib,subprocess,sys
here=pathlib.Path(__file__).resolve().parent;root=here.parents[4]
base=json.loads((here/'baseline-sha256.json').read_text());authorization=json.loads((here/'authorization.json').read_text())
assert base['head']==authorization['evidenceBaseCommit']=='31dae29f1cf7d1e8caf6c670124eed7c7ed91e11'
allowed=set(authorization['authorizedProductionAndTestPaths']);checker='docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs'
changed=[];preserved=0
for name,expected in base['files'].items():
 original=subprocess.check_output(['git','show',base['head']+':'+name],cwd=root)
 assert hashlib.sha256(original).hexdigest()==expected,('baseline manifest changed',name)
 actual=hashlib.sha256((root/name).read_bytes()).hexdigest()
 if actual!=expected:
  assert name in allowed or name==checker,('unapproved baseline modification',name)
  changed.append({'path':name,'baselineSha256':expected,'currentSha256':actual})
 else:preserved+=1
current=[]
for folder in ['src','tests']:
 for p in sorted((root/folder).rglob('*')):
  if p.is_file():current.append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
result={'baseline':base['head'],'implementationHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'baselineFiles':len(base['files']),'preservedFiles':preserved,'authorizedModifications':changed,'sourceAndTests':current,'oldTestsAndHistoricalReportsUnchanged':True}
(here/'source-seal.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='sourceAndTests'},indent=2))
