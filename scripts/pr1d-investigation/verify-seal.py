"""Check immutable baseline and seal new artifacts; no self-referential digest."""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
base=json.loads((OUT/'baseline-sha256.json').read_text())
changed=[]
for path,digest in base['files'].items():
 p=ROOT/path
 if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:changed.append(path)
assert changed==['tests/fixtures/uva-lifecycle.mjs'],changed
assert subprocess.check_output(['git','diff',base['baseline'],'--','src','server.js','package.json','package-lock.json'],cwd=ROOT)==b''
# All original assertions and historical reports/evidence remain byte-identical.
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
artifacts={}
paths=[p for p in OUT.rglob('*') if p.is_file() and p.name!='manifest.json']
paths+=list((ROOT/'scripts/pr1d-investigation').glob('*'))+[ROOT/'tests/pr1d-evidence-preservation.test.js',ROOT/'tests/fixtures/uva-lifecycle.mjs',ROOT/'docs/rfc/unified-visual-architecture/PR-1D-PERFORMANCE-INVESTIGATION-REPORT.md']
for p in paths:
 if p.is_file():artifacts[str(p.relative_to(ROOT))]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
for line in (OUT/'runs.jsonl').read_text().splitlines():
 r=json.loads(line);assert hashlib.sha256((OUT/r['log']).read_bytes()).hexdigest()==r['sha256'],r['name']
seal={'baseline':base['baseline'],'production':base['production'],'baselineFiles':len(base['files']),'modifiedBaselineFiles':changed,'productionUnchanged':True,'originalAssertionsAndHistoricalEvidenceUnchanged':True,'artifacts':artifacts}
(OUT/'manifest.json').write_text(json.dumps(seal,indent=2)+'\n')
print(f"Verified {len(base['files'])} baseline paths; one authorized fixture hook; sealed {len(artifacts)} artifacts")
