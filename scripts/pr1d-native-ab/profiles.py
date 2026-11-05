"""Separate explanatory profiles; never combine inclusive timers or plain latency."""
import collections,gzip,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
summary={}
for label in ['baseline','candidate']:
 case=OUT/('document-8-profile-'+label);operations=[];cpu=[];heap=[]
 for p in sorted(case.glob('measure-*.jsonl')):
  for line in p.read_text().splitlines():operations.append(json.loads(line))
 for p in sorted(case.glob('cpu-*.json.gz')):
  data=json.loads(gzip.decompress(p.read_bytes()));nodes={n['id']:n for n in data['nodes']};counts=collections.Counter()
  for node,delta in zip(data.get('samples',[]),data.get('timeDeltas',[])):
   frame=nodes[node]['callFrame'];counts[(frame['functionName'],frame['url'])]+=delta
  cpu.append({'file':p.name,'samples':len(data.get('samples',[])),'sampledGarbageCollectorUs':sum(v for (name,url),v in counts.items() if 'garbage collector' in name),'topSampledFramesUs':[{'function':n,'url':u,'sampledUs':v} for (n,u),v in counts.most_common(15)],'interpretation':'Profile interval includes idle/RPC waits/bootstrap. Sampled deltas are not independent operation timers.'})
 for p in sorted(case.glob('heap-*.json.gz')):
  data=json.loads(gzip.decompress(p.read_bytes()));ranks=collections.Counter()
  def walk(n):
   f=n['callFrame'];ranks[(f['functionName'],f['url'])]+=n.get('selfSize',0)
   for c in n.get('children',[]):walk(c)
  walk(data['head']);heap.append({'file':p.name,'sampledRetainedBytes':sum(ranks.values()),'topSites':[{'function':n,'url':u,'bytes':v} for (n,u),v in ranks.most_common(15)],'interpretation':'1 MiB sampling; retained allocations at stop, not cumulative allocation or transient peak.'})
 summary[label]={'receipt':json.loads((case/'receipt.json').read_text()),'operations':operations,'cpu':cpu,'heap':heap}
(OUT/'profile-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:{'operations':len(v['operations']),'cpuProfiles':len(v['cpu']),'heapProfiles':len(v['heap']),'exit':v['receipt']['exitCode']} for k,v in summary.items()}))
