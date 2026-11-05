"""Seal the final independent evidence; manifest excludes its own recursive hash."""
import hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
report=ROOT/'docs/rfc/unified-visual-architecture/PR-1D-NATIVE-PERFORMANCE-AB-REPORT.md'
paths=[report,*sorted((ROOT/'scripts/pr1d-native-ab').rglob('*')),*sorted(OUT.rglob('*'))]
rows=[]
for p in paths:
 if not p.is_file() or p==OUT/'manifest.json' or '__pycache__' in p.parts:continue
 rows.append({'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
runs=[json.loads(l) for l in (OUT/'runs.jsonl').read_text().splitlines()]
result={'baseline':'d9aaa49f27d195ed53baeb12e95e434f1a7b10b0','candidate':'4814daf2378e9619f171c02a65792062957a8e99','protocol':json.loads((OUT/'execution-start.json').read_text()),'files':rows,'runCount':len(runs),'nonzeroRuns':[{'name':r['name'],'exitCode':r['exitCode'],'stop':r['stop']} for r in runs if r['exitCode'] or r['stop']],'verdict':'INCONCLUSIVE — DEFAULT TO BASELINE','production':'NOT QUALIFIED','scope':'All new evidence, independent harness/analysis scripts and final report; excludes manifest.json itself. All 2,469 original candidate files independently sealed in integrity-verification.json. Final commit resolved by git log on report path.'}
(OUT/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
for row in rows:assert hashlib.sha256((ROOT/row['path']).read_bytes()).hexdigest()==row['sha256']
print(json.dumps({'artifacts':len(rows),'runs':len(runs),'nonzero':result['nonzeroRuns'],'allArtifactHashesVerified':True}))
