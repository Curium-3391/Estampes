"""Sequential paired measurements; SOURCE is selected before importing the runner."""
import os,subprocess,sys
from pathlib import Path
REPO=Path(__file__).resolve().parents[2]
NODE='/workspace/.estampes-tools/node-v22.23.4-linux-x64/bin/node'
BASE='/workspace/Estampes-pr1d-baseline'
def run(source,name,mode,value,profile=False):
 env=dict(os.environ,PR1D_SOURCE=source)
 result=subprocess.run([sys.executable,str(REPO/'scripts/pr1d-remediation/run.py'),name,'900' if mode=='history' else '180','profile' if profile else 'plain',NODE,'scripts/pr1d-investigation/benchmark.mjs',mode,str(value)],env=env,cwd=REPO,check=False)
 if result.returncode:
  raw=(REPO/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'/name/'raw.log').read_text()
  if mode=='document' and value==32 and '"event":"cold-client-error"' in raw and 'Writer startup timed out' in raw:
   print(name+': preserved hard-deadline failure; continue the finite comparison, not a retry',flush=True)
  else:raise subprocess.CalledProcessError(result.returncode,result.args)
if sys.argv[1]=='a':
 cases=[(BASE,'baseline-history-25-2','history',25,False),
        (str(REPO),'a-history-25-2','history',25,False),
        (str(REPO),'a-history-25-3','history',25,False),
        (BASE,'baseline-history-25-3','history',25,False),
        (BASE,'baseline-history-25-profile','history',25,True),
        (str(REPO),'a-history-25-profile','history',25,True)]
 for case in cases:run(*case)
elif sys.argv[1]=='a-long':
 for n in [50,100]:
  for profile in [False,True]:
   suffix='profile' if profile else '2'
   run(BASE,f'baseline-history-{n}-{suffix}','history',n,profile)
   run(str(REPO),f'a-history-{n}-{suffix}','history',n,profile)
elif sys.argv[1]=='b':
 bbase=os.environ.get('PR1D_B_BASE',BASE)
 for n in [1,8,16,32]:
  if n!=1:run(bbase,f'b-base-document-{n}-1','document',n)
  run(str(REPO),f'b-document-{n}-1','document',n)
 # Repeat the most relevant document workload in reverse order.
 run(str(REPO),'b-document-8-2','document',8)
 run(bbase,'b-base-document-8-2','document',8)
 for n in [1,8,16,32]:
  run(bbase,f'b-base-document-{n}-profile','document',n,True)
  run(str(REPO),f'b-document-{n}-profile','document',n,True)
elif sys.argv[1]=='b-cpu':
 for n,first in [(1,'baseline'),(2,'candidate')]:
  subprocess.run([sys.executable,str(REPO/'scripts/pr1d-remediation/run.py'),f'b-cpu-pair-{n}','180','plain',NODE,str(REPO/'scripts/pr1d-remediation/json-cost.mjs'),BASE,str(REPO),first],cwd=REPO,check=True)
elif sys.argv[1]=='fault-control':
 pattern='^SIGKILL / after-intent-durable preserves one whole root and at most one retry effect$'
 for source,name in [(BASE,'startup-fault-baseline-control'),(str(REPO),'startup-fault-candidate-control')]:
  subprocess.run([sys.executable,str(REPO/'scripts/pr1d-remediation/run.py'),name,'180','plain',NODE,'--test','--test-concurrency=1','--test-name-pattern='+pattern,'tests/persistence-faults.test.js'],env=dict(os.environ,PR1D_SOURCE=source),cwd=REPO,check=False)
