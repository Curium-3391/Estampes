"""Readable non-additive counter and memory tables from sealed raw profiles."""
from pathlib import Path
import json
OUT=Path(__file__).resolve().parents[2]/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
s=json.loads((OUT/'summary.json').read_text());metrics=[]
for size in [1,8,16,32]:
 for variant in ['b-base','b']:
  name=f'{variant}-document-{size}-profile';case=s.get(name)
  if not case:continue
  warm=next((r for r in case['profiles'] if r['operation']=='commit' and r.get('transaction',{}).get('mode')=='content'),None)
  coldPid=next((r['pid'] for r in case['cold'] if r.get('label')=='cold-client'),None)
  cold=next((r for r in case['profiles'] if r['operation']=='open' and r['pid']==coldPid),None)
  for label,row in [('commit',warm),('cold-client-open',cold)]:
   if row:metrics.append({'case':name,'sizeMiB':size,'phase':label,'wallMs':row['wallMs'],'cpuUs':row['cpuUs'],'memoryEnd':row['memory'],'maxRSSKiB':row['maxRSSKiB'],'operations':row['operations']})
(OUT/'counters-memory.json').write_text(json.dumps(metrics,indent=2)+'\n')
md=['# CPU, logical IO, JSON and memory counters','', 'Instrumented runs only. Timers are inclusive and overlap. CPU is per operation; memory is operation-end, while HWM is per process. Read bytes are logical IO, not physical device traffic. Canonical bytes count repeated encoding.','', '| Case / operation | User / sys ms | lstat | FD stat | FD read / readFile bytes |','| --- | ---: | ---: | ---: | ---: |']
def op(r,key,field='calls'):return r['operations'].get(key,{}).get(field,0)
for r in metrics:md.append(f"| {r['case']} / {r['phase']} | {r['cpuUs']['user']/1000:.1f} / {r['cpuUs']['system']/1000:.1f} | {op(r,'fs.lstat')} | {op(r,'fd.stat')} | {op(r,'fd.read','bytes')} / {op(r,'fd.readFile','bytes')} |")
md+=['','| Case / operation | Guard calls / ms | Canonical calls / bytes | Schema parse calls / ms | Hash calls / bytes |','| --- | ---: | ---: | ---: | ---: |']
for r in metrics:md.append(f"| {r['case']} / {r['phase']} | {op(r,'assertJson')} / {op(r,'assertJson','ms'):.1f} | {op(r,'canonicalJson')} / {op(r,'canonicalJson','bytes')} | {op(r,'parse')} / {op(r,'parse','ms'):.1f} | {op(r,'sha256.update')} / {op(r,'sha256.update','bytes')} |")
md+=['','| Case / operation | Heap used / total bytes | External / arrayBuffer bytes | Worker HWM KiB |','| --- | ---: | ---: | ---: |']
for r in metrics:
 m=r['memoryEnd'];md.append(f"| {r['case']} / {r['phase']} | {m['heapUsed']} / {m['heapTotal']} | {m['external']} / {m['arrayBuffers']} | {r['maxRSSKiB']} |")
md+=['','## Sampled retained allocation','', 'The Inspector heap samples estimate retained allocation sites at stop, not cumulative allocation or transient memory peaks. Per-worker samples and CPU ranks (including explicit idle samples) remain in summary.json and compressed original profiles.','', '| Case | PID profile | Sampled retained bytes |','| --- | --- | ---: |']
for name,case in s.items():
 for heap in case.get('heapSamples',[]):md.append(f"| {name} | {heap['file']} | {heap['sampledRetainedBytes']} |")
(OUT/'COUNTERS.md').write_text('\n'.join(md)+'\n')
print(f'Counter/memory table: {len(metrics)} instrumented operations')
