import csv,json,pathlib
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
OUT=pathlib.Path(__file__).resolve().parents[2]/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
data=json.loads((OUT/'summary.json').read_text())
fig,axes=plt.subplots(1,2,figsize=(11,4))
for n in [25,50,100,150]:
 r=data.get(f'history-{n}-plain')
 if r:axes[0].plot(range(1,len(r['perCommitMs'])+1),[x/1000 for x in r['perCommitMs']],label=str(n)+' commands',alpha=.75)
axes[0].set(xlabel='Retained history / commit number',ylabel='Commit latency (s)',title='Uninstrumented, tmpfs');axes[0].legend()
sizes=[];cold=[];commit=[]
for n in [1,8,16,32,63.96875]:
 r=data.get(f'document-{str(n).replace(".","-")}-plain')
 if not r:continue
 sizes.append(n);commit.append(r['commitTotalMs']/1000);cold.append(next((x['wallMs']/1000 for x in r['startup'] if x.get('label')=='cold-client'),float('nan')))
axes[1].plot(sizes,commit,'o-',label='Commit');axes[1].plot(sizes,cold,'o-',label='Cold client');axes[1].axhline(30,color='r',ls='--',label='Client deadline')
axes[1].set(xlabel='Extension payload (MiB)',ylabel='Duration (s)',title='One version, same Document structure');axes[1].legend();fig.tight_layout();fig.savefig(OUT/'scaling.png',dpi=150);plt.close(fig)
with (OUT/'scaling.csv').open('w') as f:
 w=csv.writer(f);w.writerow(['run','commits','commit_total_ms','p50_ms','p95_ms','max_ms','cold_client_ms'])
 for name,r in data.items():
  if r['commits']:w.writerow([name,r['commits'],r['commitTotalMs'],*[r['latencyMs'][key] for key in ['p50','p95','max']],next((x['wallMs'] for x in r['startup'] if x.get('label')=='cold-client'),'')])
