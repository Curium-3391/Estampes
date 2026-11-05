"""Derive per-pair tables without exclusions or significance claims."""
import hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
def rows(name):
 result=[]
 for line in (OUT/name/'raw.log').read_text().splitlines():
  if line.startswith('{'):
   try:result.append(json.loads(line))
   except json.JSONDecodeError:pass
 return result
runs=[json.loads(l) for l in (OUT/'runs.jsonl').read_text().splitlines()]
plain={}
for run in runs:
 name=run['name']
 if '-pair-' not in name:continue
 events=rows(name);commits=[e for e in events if e.get('event')=='commit'];startup=next((e for e in events if e.get('event')=='startup' and e.get('label')=='cold-client'),None);verified=next((e for e in events if e.get('event')=='verified'),None);failure=next((e for e in events if e.get('event')=='cold-client-error'),None);inputs=next((e for e in events if e.get('event')=='inputs'),None);warm=next((e for e in events if e.get('event')=='warm-summary'),None)
 workerPids={str(e['pid']) for e in events if e.get('event')=='startup'}
 workerPeak=max((run['perProcessHwmKiB'].get(pid,0) for pid in workerPids),default=0)
 samples=json.loads((OUT/name/'rss-samples.json').read_text())
 first=next(sample for sample in samples if sample['rssKiB'])
 assert len(first['rssKiB'])==1,'Cannot identify benchmark parent from initial /proc sample'
 parentPid=next(iter(first['rssKiB']))
 childOrder=[]
 for sample in samples:
  for pid in sample['rssKiB']:
   if pid!=parentPid and pid not in childOrder:childOrder.append(pid)
 assert len(childOrder)==3,'Unexpected subprocess topology: '+name
 bootstrap=next(e for e in events if e.get('event')=='startup' and e.get('label')=='bootstrap')
 assert childOrder[0]==str(bootstrap['pid'])
 if startup:assert childOrder[2]==str(startup['pid'])
 roles={'benchmark':parentPid,'warmWorker':childOrder[0],'directLeasedCoordinator':childOrder[1],'coldWorker':childOrder[2]}
 coldStartupPeak=run['perProcessHwmKiB'][childOrder[2]] if failure else startup['workerMemory']['hwmKiB']
 # Validated sequential three-child topology recovers the failed cold PID too.
 if failure:
  assert all(h<=workerPeak for pid,h in run['perProcessHwmKiB'].items() if pid!=parentPid and pid not in workerPids),'Failed-open child exceeded identified warm worker HWM'
 # Even the failed-open worker is bounded by the observed actual warm-worker peak.

 plain[name]={'commitSeconds':sum(e['wallMs'] for e in commits)/1000,'coldSeconds':startup['wallMs']/1000 if startup else None,'coldFailure':failure,'commitWorkerCpuSeconds':{k:sum(e['workerCpuTicks'][k] for e in commits)/run['tickHz'] for k in ['user','system']},'coldWorkerCpuSeconds':{k:startup['workerCpu'][k+'Ticks']/run['tickHz'] for k in ['user','system']} if startup else None,'processRoles':roles,'coldStartupPeakWorkerHwmKiB':coldStartupPeak,'warmWorkerHwmKiB':warm['workerMemory']['hwmKiB'] if warm else None,'coldReadyWorkerHwmKiB':startup['workerMemory']['hwmKiB'] if startup else None,'peakWorkerHwmKiB':workerPeak,'peakProcessHwmKiB':run['peakProcessRssKiB'],'peakTreeRssKiB':run['peakTreeRssKiB'],'exitCode':run['exitCode'],'stop':run['stop'],'completed':bool(verified and run['exitCode']==0 and not run['stop']),'inputs':inputs,'verified':verified,'allocatedBytes':verified['usage'] if verified else None}
pairs=[]
for mode,size,pair,order in [('document',8,1,'B -> C'),('document',8,2,'C -> B'),('document',16,1,'B -> C'),('document',32,1,'B -> C'),('document',32,2,'C -> B'),('history',100,1,'C -> B')]:
 stem=f'{mode}-{size}-pair-{pair}';b=plain.get(stem+'-baseline');c=plain.get(stem+'-candidate');changes={}
 if b and c:
  assert b['inputs']==c['inputs'],'Deterministic input mismatch: '+stem
  for metric in ['commitSeconds','coldSeconds','warmWorkerHwmKiB','coldReadyWorkerHwmKiB','peakWorkerHwmKiB','peakProcessHwmKiB','peakTreeRssKiB']:
   changes[metric]=100*(c[metric]/b[metric]-1) if b[metric] and c[metric] is not None else None
  if b['verified'] and c['verified']:
   logical=lambda x:[(r['revision'],r['sha256'],r['representation']['kind']) for r in x['hashes']]
   assert logical(b['verified'])==logical(c['verified']),'Full/Delta or all-version canonical parity mismatch'
 pairs.append({'workload':stem,'order':order,'baseline':b,'candidate':c,'changePercent':changes})
summary={'pairs':pairs,'completedPairs':sum(bool(p['baseline'] and p['candidate'] and p['baseline']['completed'] and p['candidate']['completed']) for p in pairs),'completedPlainRuns':sum(r['completed'] for r in plain.values()),'attemptedPlainRuns':len(plain),'runs':[{'name':r['name'],'exitCode':r['exitCode'],'stop':r['stop'],'counts':r['counts'],'wallSeconds':r['wallSeconds']} for r in runs]}
summary['variance']={}
for size in [8,32]:
 group=[p for p in pairs if p['workload'].startswith(f'document-{size}-')]
 summary['variance'][str(size)]={}
 for metric in ['commitSeconds','coldSeconds','peakWorkerHwmKiB','peakTreeRssKiB']:
  values={}
  for side in ['baseline','candidate']:
   observations=[p[side][metric] for p in group if p[side] and p[side][metric] is not None]
   values[side]={'observations':observations,'min':min(observations) if observations else None,'max':max(observations) if observations else None,'range':max(observations)-min(observations) if observations else None,'interpretation':'Successful numeric observations only; timeouts remain censored failures in original paired rows and are not assigned a successful latency.'}
  summary['variance'][str(size)][metric]=values
(OUT/'paired-results.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'completedPairs':summary['completedPairs'],'completedPlainRuns':summary['completedPlainRuns'],'runs':summary['runs']},indent=2))
