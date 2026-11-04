"""Serial measured matrix with admission checks. No 200/1000 entrypoint."""
import json,pathlib,sys
from run import run,NODE,HERE,REPO
OUT=REPO/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
def bench(mode,value,profile=False):
 name=f'{mode}-{str(value).replace(".","-")}-'+('profile' if profile else 'plain')
 return run(name,900 if mode=='history' else 180,[NODE,str(HERE/'benchmark.mjs'),mode,str(value)],profile)
def stats(name):
 rows=[json.loads(x) for x in (OUT/name/'raw.log').read_text().splitlines() if x.startswith('{')]
 cold=next((r['wallMs'] for r in rows if r.get('event')=='startup' and r.get('label')=='cold-client'),float('inf'))
 return cold
if sys.argv[1]=='history':
 records=[]
 # 25 plain/profile are initial harness validation; continue serially from 50.
 for n in [50,100]:
  for profile in [False,True]:
   r=bench('history',n,profile);records.append(r)
   if r['exitCode'] or r['stop']:raise SystemExit(1)
 last=records[-2:]
 admit=all(r['wallSeconds']<450 and r['peakProcessRssKiB']<768*1024 and stats(r['name'])<15000 for r in last)
 (OUT/'history-150-admission.json').write_text(json.dumps({'admitted':admit,'basis':last,'coldClientLimitMs':15000},indent=2)+'\n')
 if admit:
  for profile in [False,True]:
   r=bench('history',150,profile)
   if r['exitCode'] or r['stop']:raise SystemExit(1)
else:
 records=[]
 for n in [1,8,16,32]:
  for profile in [False,True]:
   r=bench('document',n,profile);records.append(r)
   if r['exitCode'] or r['stop']:raise SystemExit(1)
 last=records[-2:]
 admit=all(r['wallSeconds']<90 and r['peakProcessRssKiB']<768*1024 and stats(r['name'])<15000 for r in last)
 (OUT/'near-64-admission.json').write_text(json.dumps({'admitted':admit,'basis':last,'coldClientLimitMs':15000},indent=2)+'\n')
 if admit:
  for profile in [False,True]:
   r=bench('document',63.96875,profile)
   if r['exitCode'] or r['stop']:break
