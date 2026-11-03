import collections,gzip,hashlib,json,pathlib
here=pathlib.Path(__file__).resolve().parent;summary=[]
for path in sorted(here.glob('*.cpuprofile')):
 stem=path.with_suffix('');cpu=json.loads(path.read_text());heap=json.loads(stem.with_suffix('.heapprofile').read_text());obs=json.loads(stem.with_suffix('.observation.json').read_text())
 nodes={n['id']:n for n in cpu['nodes']};own=collections.Counter()
 for ident,delta in zip(cpu.get('samples',[]),cpu.get('timeDeltas',[])):
  f=nodes[ident]['callFrame'];own[f.get('functionName','')+' @ '+f.get('url','')+':'+str(f.get('lineNumber',-1)+1)]+=delta
 allocations=collections.Counter()
 def walk(n):
  f=n['callFrame'];allocations[f.get('functionName','')+' @ '+f.get('url','')+':'+str(f.get('lineNumber',-1)+1)]+=n.get('selfSize',0)
  for child in n.get('children',[]):walk(child)
 walk(heap['head'])
 artifacts=[]
 for p in [path,stem.with_suffix('.heapprofile')]:
  raw=p.read_bytes();compressed=gzip.compress(raw,mtime=0);destination=p.with_name(p.name+'.gz');destination.write_bytes(compressed)
  artifacts.append({'path':destination.name,'rawSha256':hashlib.sha256(raw).hexdigest(),'storedSha256':hashlib.sha256(compressed).hexdigest()});p.unlink()
 summary.append({'name':stem.name,'estimatedSampledAllocationBytes':sum(allocations.values()),'topAllocationSites':[{'frame':k,'bytes':v} for k,v in allocations.most_common(12)],'cpuTopSelfMs':[{'frame':k,'ms':v/1000} for k,v in own.most_common(12)],'encodingCounts':obs.get('encodingCounts'),'resource':obs['resource'],'cpu':obs['cpu'],'io':obs['io'],'peakSampledHeapUsed':max((m['heapUsed'] for m in obs['memory']),default=0),'gcEvents':len(obs['gc']),'gcMs':sum(e['duration'] for e in obs['gc']),'artifacts':artifacts,'limitations':'Inspector sampling includes collected objects and has overhead; allocation estimates are cumulative, not live heap. I/O wrappers overlap. Earlier baseline-counted warm artifact precedes a cold-start timeout; use the isolated pair for comparisons.'})
(here/'profile-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for d in summary:print(d['name'],'alloc',d['estimatedSampledAllocationBytes'],'counts',d['encodingCounts'],'peakRSSKiB',d['resource']['maxRSS'])
