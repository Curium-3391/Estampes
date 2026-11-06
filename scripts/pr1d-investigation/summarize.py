"""Derived summaries retain raw logs/profiles. Inclusive times must not be added."""
import collections,gzip,json,pathlib
OUT=pathlib.Path(__file__).resolve().parents[2]/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
summary={}
for case in sorted(OUT.iterdir()):
 if not case.is_dir() or not (case/'raw.log').exists():continue
 rows=[]
 for line in (case/'raw.log').read_text().splitlines():
  try:rows.append(json.loads(line))
  except ValueError:pass
 commits=[r for r in rows if r.get('event')=='commit'];latencies=sorted(r['wallMs'] for r in commits)
 result={'commits':len(commits),'latencyMs':{q:latencies[min(len(latencies)-1,int(len(latencies)*fraction))] for q,fraction in [('p50',.5),('p95',.95),('max',1)]} if latencies else {}}
 result['commitTotalMs']=sum(latencies);result['perCommitMs']=[r['wallMs'] for r in commits]
 result['transactionTotalsMs']={k:sum(r['transaction'][k] for r in commits) for k in commits[0].get('transaction',{}) if k!='mode'} if commits else {}
 result['lastVerification']=commits[-1]['verification'] if commits else None
 result['startup']=[r for r in rows if r.get('event') in ['startup','cold-client-error']]
 result['directCold']=[json.loads(r['out']) for r in rows if r.get('event')=='direct-cold' and r.get('code')==0]
 result['warm']=[r for r in rows if r.get('event')=='warm-summary'];result['verified']=[r for r in rows if r.get('event')=='verified']
 measurements=[]
 for f in case.glob('measure-*.jsonl'):
  measurements.extend(json.loads(line) for line in f.read_text().splitlines())
 result['measurements']=measurements
 cpu=[];heap=[]
 for f in case.glob('cpu-*.json.gz'):
  p=json.loads(gzip.decompress(f.read_bytes()));nodes={n['id']:n for n in p['nodes']};parents={child:n['id'] for n in p['nodes'] for child in n.get('children',[])}
  selftime=collections.Counter();inclusive=collections.Counter();total=0
  # V8 timeDeltas span from previous sample; attribute interval to current sample.
  for node,dt in zip(p.get('samples',[]),p.get('timeDeltas',[])):
   frame=nodes[node]['callFrame'];key=f"{frame['functionName']} @ {frame['url']}:{frame['lineNumber']+1}";selftime[key]+=dt;total+=dt
   seen=set();cur=node
   while cur in nodes:
    frame=nodes[cur]['callFrame'];key=f"{frame['functionName']} @ {frame['url']}:{frame['lineNumber']+1}"
    if key not in seen:inclusive[key]+=dt;seen.add(key)
    cur=parents.get(cur)
  cpu.append({'file':f.name,'sampleIntervalUs':10000,'sampledUs':total,'topSelfUs':selftime.most_common(30),'topInclusiveUs':inclusive.most_common(30)})
 for f in case.glob('heap-*.json.gz'):
  p=json.loads(gzip.decompress(f.read_bytes()));sites=collections.Counter()
  def walk(n):
   frame=n['callFrame'];sites[f"{frame['functionName']} @ {frame['url']}:{frame['lineNumber']+1}"]+=n.get('selfSize',0)
   for c in n.get('children',[]):walk(c)
  walk(p['head']);heap.append({'file':f.name,'retainedSampleEstimateBytes':sum(sites.values()),'topSitesBytes':sites.most_common(20)})
 result['cpuProfiles']=cpu;result['heapProfiles']=heap;summary[case.name]=result
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for name,r in summary.items():
 if r['commits']:print(name,'commitsMs',round(r['commitTotalMs']),r['latencyMs'],'coldMs',[(x.get('label'),round(x.get('wallMs',0))) for x in r['startup']])
