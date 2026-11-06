"""Generate factual tables separately; report explains evidence boundaries."""
import json,pathlib,collections
OUT=pathlib.Path(__file__).resolve().parents[2]/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
s=json.loads((OUT/'summary.json').read_text());runs={r['name']:r for r in map(json.loads,(OUT/'runs.jsonl').read_text().splitlines())}
lines=['# Measured results','', 'All times seconds; tmpfs process-crash profile. P95 of a single document commit is not a distribution.','', '| Run | p50 / p95 / max | Commit total | Direct cold | Cold client | Peak process HWM KiB | Allocated warm bytes | Exit |','| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for name,r in s.items():
 if not r['commits'] or name not in runs:continue
 p=r['latencyMs'];direct=r['directCold'][0]['wallMs']/1000 if r['directCold'] else None;cold=next((x['wallMs']/1000 for x in r['startup'] if x.get('label')=='cold-client'),None);warm=r['warm'][0] if r['warm'] else {}
 fmt=lambda x:f'{x:.3f}' if isinstance(x,(int,float)) else 'NOT COMPLETED'
 lines.append(f"| {name} | {p['p50']/1000:.3f} / {p['p95']/1000:.3f} / {p['max']/1000:.3f} | {r['commitTotalMs']/1000:.3f} | {fmt(direct)} | {fmt(cold)} | {runs[name]['peakProcessRssKiB']} | {warm.get('usage',{}).get('allocatedBytes','—')} | {runs[name]['exitCode']} |")
lines+=['','## Plain phase totals','','| Run | Build/preflight | Stage/prepare | Candidate/history | CURRENT incl. rehash | Post-publish incl. final rehash |','| --- | ---: | ---: | ---: | ---: | ---: |']
for name,r in s.items():
 if not name.endswith('-plain') or not r['commits']:continue
 t=r['transactionTotalsMs'];lines.append('| '+name+' | '+' | '.join(f'{t[k]/1000:.3f}' for k in ['buildAndPreflightMs','stageAndPrepareMs','candidateVerificationMs','currentPublicationMs','postPublicationMs'])+' |')
lines+=['','## Profile overhead observations','','Run order/environment and profiler work are confounded in single pairs. No causal overhead estimate or SLA.','', '| Pair | Commit total ratio profile/plain | Cold client ratio |','| --- | ---: | ---: |']
for name,r in s.items():
 if not name.endswith('-plain') or name[:-6]+'-profile' not in s or not r['commits']:continue
 b=s[name[:-6]+'-profile'];a_cold=next((x['wallMs'] for x in r['startup'] if x.get('label')=='cold-client'),None);b_cold=next((x['wallMs'] for x in b['startup'] if x.get('label')=='cold-client'),None)
 ratio=f'{b_cold/a_cold:.3f}' if a_cold and b_cold else '—';lines.append(f"| {name[:-6]} | {b['commitTotalMs']/r['commitTotalMs']:.3f} | {ratio} |")
lines+=['','## Last content commit counters (profile)','','| History | lstat | FD stat | FD sync | Digest calls | SHA updates / bytes | Canonical calls / bytes | Schema parse calls | Proof metadata paths (cumulative) |','| ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |']
for n in [25,50,100,150]:
 r=s.get(f'history-{n}-profile');m=next((x for x in r['measurements'] if x['operation']=='commit' and x['ordinal']==n),None) if r else None
 if not m:continue
 o=m['operations'];v=r['lastVerification'];lines.append(f"| {n} | {o['fs.lstat']['calls']} | {o['fd.stat']['calls']} | {o['fd.sync']['calls']} | {o['ManagedFiles.digest']['calls']} | {o['sha256.update']['calls']} / {o['sha256.update']['bytes']} | {o['canonicalJson']['calls']} / {o['canonicalJson']['bytes']} | {o['parse']['calls']} | {v['metadataPathsTraversed']} |")
lines+=['','## Focused phase leaf counters and process CPU','','Approximate stage markers; nested method durations overlap. Memory is sampled at phase end.','', '| Run / operation / phase | Wall ms | User / system ms | lstat | Read bytes | SHA bytes | Canonical bytes | Heap / external bytes |','| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |']
for name in ['phase-history-25','phase-document-8']:
 if name not in s:continue
 for m in s[name]['measurements']:
  if m['operation']=='commit' and m['ordinal']!=(25 if name=='phase-history-25' else 1):continue
  for phase,p in m.get('phaseData',{}).items():
   op=p['operations'];mem=p.get('memory',{});get=lambda key,field:op.get(key,{}).get(field,0)
   lines.append(f"| {name} / PID {m['pid']} / {m['operation']}-{m['ordinal']} / {phase} | {p['wallMs']:.1f} | {p['userUs']/1000:.1f} / {p['systemUs']/1000:.1f} | {get('fs.lstat','calls')} | {get('fd.read','bytes')+get('fd.readFile','bytes')} | {get('sha256.update','bytes')} | {get('canonicalJson','bytes')} | {mem.get('heapUsed')} / {mem.get('external')} |")
(OUT/'RESULTS.md').write_text('\n'.join(lines)+'\n')
