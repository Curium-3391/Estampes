"""Derive observations without overwriting raw evidence or assuming success."""
from pathlib import Path
import json,gzip
OUT=Path(__file__).resolve().parents[2]/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
def lines(p):
 rows=[]
 for line in p.read_text().splitlines():
  try: rows.append(json.loads(line))
  except json.JSONDecodeError: pass
 return rows
receipts={r['name']:r for r in lines(OUT/'runs.jsonl')}
excluded={'baseline-history-25-1','a-history-25-1','baseline-history-50-1','a-history-50-1'}
summary={}
for case in sorted(OUT.iterdir()):
 if not case.is_dir() or not (case/'raw.log').exists(): continue
 rows=lines(case/'raw.log');commits=[r for r in rows if r.get('event')=='commit'];warm=next((r for r in rows if r.get('event')=='warm-summary'),{})
 if not commits: continue
 record={'excluded':case.name in excluded,'receipt':receipts.get(case.name),'commits':len(commits),'totalCommitMs':sum(r['wallMs'] for r in commits),'lastCommitMs':commits[-1]['wallMs'],'maxCommitMs':max(r['wallMs'] for r in commits),'cold':[r for r in rows if r.get('event') in ['direct-cold','startup','cold-client-error']],'verified':next((r for r in rows if r.get('event')=='verified'),None),'warm':warm,'profiles':[]}
 for p in sorted(case.glob('measure-*.jsonl')): record['profiles'].extend(lines(p))
 heaps=[]
 for p in sorted(case.glob('heap-*.json.gz')):
  value=json.loads(gzip.decompress(p.read_bytes()));alloc={}
  def visit(node):
   frame=node['callFrame'];key=frame.get('url','')+':'+str(frame.get('lineNumber',-1)+1)+' '+frame.get('functionName','')
   alloc[key]=alloc.get(key,0)+node.get('selfSize',0)
   for child in node.get('children',[]):visit(child)
  visit(value['head']);heaps.append({'file':p.name,'sampledRetainedBytes':sum(alloc.values()),'top':sorted(alloc.items(),key=lambda x:-x[1])[:15]})
 record['heapSamples']=heaps
 cpus=[]
 for p in sorted(case.glob('cpu-*.json.gz')):
  v=json.loads(gzip.decompress(p.read_bytes()));nodes={n['id']:n['callFrame'] for n in v['nodes']};counts={}
  for sample,us in zip(v.get('samples',[]),v.get('timeDeltas',[])):
   frame=nodes[sample];key=frame.get('url','')+':'+str(frame.get('lineNumber',-1)+1)+' '+frame.get('functionName','')
   counts[key]=counts.get(key,0)+us
  cpus.append({'file':p.name,'sampledUsIncludingIdle':sum(counts.values()),'top':sorted(counts.items(),key=lambda x:-x[1])[:20]})
 record['cpuSamples']=cpus;summary[case.name]=record
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
md=['# Measurements','', 'All timings are tmpfs process-crash observations. Inclusive counters overlap; profiles are separate from plain latency. First exploratory pair and interrupted pre-resume pair are excluded. Missing terminal receipts are not passes.','', '| Case | Commit total s | Last commit s | Cold client s | Process HWM KiB | Exit / excluded |','| --- | ---: | ---: | ---: | ---: | --- |']
for name,r in summary.items():
 cold=next((x['wallMs']/1000 for x in r['cold'] if x.get('label')=='cold-client'),None);receipt=r['receipt'] or {}
 md.append(f"| {name} | {r['totalCommitMs']/1000:.3f} | {r['lastCommitMs']/1000:.3f} | {cold if cold is not None else 'incomplete'} | {receipt.get('peakProcessRssKiB','unknown')} | {receipt.get('exitCode','missing')} / {r['excluded']} |")
(OUT/'RESULTS.md').write_text('\n'.join(md)+'\n')
for name,r in summary.items():print(name,r['commits'],round(r['totalCommitMs']/1000,3),(r['receipt'] or {}).get('exitCode','INCOMPLETE'))
