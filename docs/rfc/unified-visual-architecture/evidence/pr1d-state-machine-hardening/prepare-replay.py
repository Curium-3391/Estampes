"""Adapt ONLY the unavailable native profile to a process-crash fixture.
Production src is symlinked unchanged; original tests/logs are never edited.
"""
import pathlib,sys,hashlib,json
source=pathlib.Path(sys.argv[1]).resolve();target=pathlib.Path(sys.argv[2]).resolve();target.mkdir(exist_ok=False)
for n in ['src','tests','node_modules']:(target/n).symlink_to(source/n,target_is_directory=True)
(target/'package.json').write_bytes((source/'package.json').read_bytes())
manifest=[]
for d in ['pr1d-native-round2','pr1d-native-logs','pr1d-native-round3']:
 out=target/'docs/rfc/unified-visual-architecture/evidence'/d;out.mkdir(parents=True)
 for p in sorted((source/'docs/rfc/unified-visual-architecture/evidence'/d).glob('*.mjs')):
  raw=p.read_text();s=raw.replace('linux-local-durable','linux-process-crash-test').replace('persistence: "durable"','persistence: "memory"').replace('persistence:"durable"','persistence:"memory"').replace('"durable"','"process-crash-test"')
  (out/p.name).write_text(s)
  manifest.append({'path':str(p.relative_to(source)),'originalSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'transformedSha256':hashlib.sha256(s.encode()).hexdigest()})
print(json.dumps({'source':str(source),'target':str(target),'scope':'test fixture profile and paired persistence/durability expectations only; original assertions otherwise unchanged','inputs':manifest},indent=2))
