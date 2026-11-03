#!/usr/bin/env python3
"""Run an argv without a shell; preserve raw bytes and input hashes before launch."""
import datetime,hashlib,json,os,pathlib,subprocess,sys,time
here=pathlib.Path(__file__).resolve().parent
name,*argv=sys.argv[1:]
log=here/(name+'.log')
inputs={}
root=pathlib.Path(os.environ.get('PR1D_CODE_ROOT',str(here.parents[4])))
for folder in ('src','tests'):
 for p in sorted((root/folder).rglob('*')):
  if p.is_file():inputs[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
for p in sorted(here.iterdir()):
 if p.suffix in ('.mjs','.py','.sh'):inputs[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
for a in argv:
 p=pathlib.Path(a)
 if p.is_file():inputs[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
env=os.environ.copy()
for k in list(env):
 if k.startswith('ESTAMPES_'):del env[k]
env.update(ESTAMPES_STORAGE_DIR='',ESTAMPES_ACCESS_KEY='',ESTAMPES_STORAGE_RETENTION_DAYS='0')
start=time.monotonic();stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.open('xb') as out:r=subprocess.run(argv,stdout=out,stderr=subprocess.STDOUT,env=env)
raw=log.read_bytes()
row={'name':name,'argv':argv,'cwd':os.getcwd(),'codeRoot':str(root),'startedUTC':stamp,'seconds':time.monotonic()-start,'exitCode':r.returncode,'sha256':hashlib.sha256(raw).hexdigest(),'inputs':inputs,'configuration':{k:os.environ[k] for k in ['PR1D_CODE_ROOT','PR1D_PROFILE_LABEL','PR1D_PROFILE_WARM_ONLY','PR1D_AUTO_MAINTENANCE','PR1D_ACCEPT_ROOT','NODE_OPTIONS','CHROME_BIN','CHROMIUM_BIN'] if k in os.environ}}
with (here/'runs.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
print(json.dumps({k:v for k,v in row.items() if k!='inputs'}),flush=True)
sys.exit(r.returncode)
