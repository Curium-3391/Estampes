from pathlib import Path
import collections,gzip,json,os
root=Path(os.environ["PR1D_ACCEPT_ROOT"])/"profiles"
out=Path("docs/rfc/unified-visual-architecture/evidence/pr1d-native-round2")
summary=[]
for cpu_path in sorted(root.glob("*.cpuprofile")):
 stem=cpu_path.with_suffix("");cpu=json.loads(cpu_path.read_text());heap=json.loads(stem.with_suffix(".heapprofile").read_text());observation=json.loads(stem.with_suffix(".observation.json").read_text())
 nodes={n["id"]:n for n in cpu["nodes"]};parents={child:n["id"] for n in cpu["nodes"] for child in n.get("children",[])}
 def label(frame):return frame.get("functionName","")+" @ "+frame.get("url","")+":"+str(frame.get("lineNumber",-1)+1)
 self_us=collections.Counter();inclusive_us=collections.Counter();total_us=0;idle_us=0
 for ident,delta in zip(cpu.get("samples",[]),cpu.get("timeDeltas",[])):
  total_us+=delta;frame=nodes[ident]["callFrame"];self_us[label(frame)]+=delta
  if frame.get("functionName")=="(idle)":idle_us+=delta
  seen=set();cursor=ident
  while cursor in nodes:
   name=label(nodes[cursor]["callFrame"])
   if name not in seen:inclusive_us[name]+=delta;seen.add(name)
   if cursor not in parents:break
   cursor=parents[cursor]
 allocations=collections.Counter()
 def walk(node):
  allocations[label(node["callFrame"])]+=node.get("selfSize",0)
  for child in node.get("children",[]):walk(child)
 walk(heap["head"])
 gc=observation["gc"];by_kind=collections.Counter(str(e.get("kind")) for e in gc)
 memory=observation["memory"]
 result=dict(name=stem.name,cpuSampledWallMs=total_us/1000,cpuIdleSampleMs=idle_us/1000,cpuTopSelfMs=[dict(frame=k,ms=v/1000) for k,v in self_us.most_common(25)],cpuTopInclusiveMs=[dict(frame=k,ms=v/1000) for k,v in inclusive_us.most_common(25)],estimatedSampledAllocationsBytes=sum(allocations.values()),heapTopEstimatedAllocationSites=[dict(frame=k,bytes=v) for k,v in allocations.most_common(25)],gcEvents=len(gc),gcTotalMs=sum(e["duration"] for e in gc),gcKinds=by_kind,maxRSSKiB=observation["maxRSSKiB"],maxSampledHeapUsed=max((x["heapUsed"] for x in memory),default=0),maxSampledHeapTotal=max((x["heapTotal"] for x in memory),default=0),maxSampledExternal=max((x["external"] for x in memory),default=0),finalMemory=observation["finalMemory"],io=observation.get("io"),limitations="Inspector sampling is statistical, includes collected allocations, and has overhead. CPU inclusive rows overlap. I/O wrappers are nested; their wall times must not be added. RSS is not live JS heap.")
 summary.append(result)
 for suffix in [".cpuprofile",".heapprofile",".observation.json"]:
  path=stem.with_suffix(suffix)
  with (out/(path.name+".gz")).open("wb") as f:
   with gzip.GzipFile(filename="",mode="wb",fileobj=f,mtime=0) as z:z.write(path.read_bytes())
(out/"profile-summary.json").write_text(json.dumps(summary,indent=2)+"\n")
print(json.dumps(summary,indent=2))
