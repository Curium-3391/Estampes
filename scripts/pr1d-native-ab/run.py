"""Finite native A/B supervisor. Run as estampes after committing PROTOCOL.md."""
import hashlib,json,os,pathlib,re,shutil,signal,subprocess,tempfile,time,sys,resource
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
NODE='/home/estampes/.nvm/versions/node/v22.23.4/bin/node'
BASE=pathlib.Path('/home/estampes/projects/pr1d-native-baseline')
CAND=pathlib.Path('/home/estampes/projects/pr1d-native-candidate')
PATTERN='R3-B1 / four interrupted recovery epochs preserve exact claims and retry / current.before-rename$'
GIB=1024**3

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def allocated(path):
 total=0
 for parent,dirs,files in os.walk(path,followlinks=False):
  for name in dirs+files:
   try:total+=(pathlib.Path(parent)/name).lstat().st_blocks*512
   except FileNotFoundError:pass
 return total

def processes():
 rows=[]
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:
   s=(p/'status').read_text();field=lambda n:int(re.search('^'+n+r':\s+(\d+)',s,re.M)[1])
   rows.append((int(p.name),field('PPid'),field('VmRSS'),field('VmHWM')))
  except (OSError,TypeError):pass
 return rows

def headroom():
 assert os.getuid()==os.getgid()==1001
 assert subprocess.check_output([NODE,'--version'],text=True).strip()=='v22.23.4'
 assert subprocess.check_output(['findmnt','-n','-o','SOURCE,FSTYPE','-T',BASE],text=True).split()==['/dev/sdd','ext4']
 assert shutil.disk_usage(BASE).free>=48*GIB
 assert int(re.search(r'^MemAvailable:\s+(\d+)',pathlib.Path('/proc/meminfo').read_text(),re.M)[1])*1024>=2*GIB
 assert len(list(pathlib.Path('/proc').glob('[0-9]*')))<=256

def run(name,seconds,command,source=CAND,extra=None,allocation=512*1024**2):
 headroom()
 case=OUT/name;case.mkdir(mode=0o700)
 scratch=pathlib.Path(tempfile.mkdtemp(prefix='pr1d-native-ab-',dir='/home/estampes'))
 env={'HOME':'/home/estampes','USER':'estampes','LOGNAME':'estampes','LANG':'C.UTF-8','TZ':'Asia/Taipei','PATH':str(pathlib.Path(NODE).parent)+':/usr/bin:/bin','TMPDIR':str(scratch),'PR1D_SCRATCH':str(scratch),'PR1D_OUTPUT':str(case),'PR1D_SOURCE':str(source),'PR1D_ACCEPT_ROOT':str(scratch),'PYTHONDONTWRITEBYTECODE':'1'}
 if extra:env.update(extra)
 inputs={str(p.relative_to(source)):digest(p) for folder in ['src','tests/fixtures','scripts/pr1d-investigation'] for p in (source/folder).rglob('*') if p.is_file()}
 inputs.update({'independent/'+str(p.relative_to(ROOT)):digest(p) for p in (ROOT/'scripts/pr1d-native-ab').glob('*') if p.is_file()})
 (case/'input-sha256.json').write_text(json.dumps(inputs,indent=2)+'\n')
 log=case/'raw.log';start=time.monotonic();started=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());stop=None;peak=tree=blocks=0;next_disk=0;pid_peaks={};known=set();samples=[]
 def kill(child):
  for pid in known:
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 with log.open('xb') as stream:
  child=subprocess.Popen(command,cwd=source,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   while child.poll() is None:
    rows=processes();desc={child.pid}
    while True:
     new=desc|{p for p,pp,_,_ in rows if pp in desc}
     if new==desc:break
     desc=new
    known|=desc;rss={p:r for p,_,r,_ in rows if p in desc}
    for p,_,_,h in rows:
     if p in desc:pid_peaks[str(p)]=max(pid_peaks.get(str(p),0),h)
    peak=max([peak,*pid_peaks.values()]);tree=max(tree,sum(rss.values()));now=time.monotonic()
    samples.append({'seconds':round(now-start,3),'rssKiB':rss})
    available=int(re.search(r'^MemAvailable:\s+(\d+)',pathlib.Path('/proc/meminfo').read_text(),re.M)[1])*1024
    if now>=next_disk:
     blocks=max(blocks,allocated(scratch));next_disk=now+5
     if blocks>allocation:stop='case scratch allocation cap'
     elif sum(allocated(p) for p in pathlib.Path('/home/estampes').glob('pr1d-native-ab-*'))>4*GIB:stop='total scratch allocation cap'
     elif shutil.disk_usage(scratch).free<48*GIB:stop='ext4 free floor'
    if now-start>seconds:stop='wall timeout'
    elif peak>1536*1024 or tree>3072*1024 or available<2*GIB:stop='memory cap/floor'
    elif len(list(pathlib.Path('/proc').glob('[0-9]*')))>256 or len(desc)>24:stop='process count cap'
    elif log.stat().st_size>32*1024**2:stop='log cap'
    if stop:kill(child);break
    time.sleep(.2)
  except BaseException as error:
   stop=f'supervisor error: {type(error).__name__}: {error}';kill(child)
  code=child.wait()
 # Terminate orphan workers, including any failed-open child, before subsequent case.
 for p,pp,_,_ in processes():
  if p in known and p!=child.pid:
   try:os.kill(p,signal.SIGKILL)
   except ProcessLookupError:pass
 raw=log.read_bytes();blocks=max(blocks,allocated(scratch))
 counts={k.decode():int(v) for k,v in re.findall(rb'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',raw,re.M)}
 receipt={'name':name,'command':command,'cwd':str(source),'environment':env,'startedUTC':started,'wallSeconds':time.monotonic()-start,'exitCode':code,'stop':stop,'budgetSeconds':seconds,'peakProcessRssKiB':peak,'peakTreeRssKiB':tree,'perProcessHwmKiB':pid_peaks,'peakAllocatedBytes':blocks,'scratch':str(scratch),'log':str(log.relative_to(OUT)),'sha256':hashlib.sha256(raw).hexdigest(),'inputManifestSha256':digest(case/'input-sha256.json'),'counts':counts,'tickHz':os.sysconf('SC_CLK_TCK')}
 (case/'rss-samples.json').write_text(json.dumps(samples)+'\n')
 (case/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 with (OUT/'runs.jsonl').open('a') as f:f.write(json.dumps(receipt)+'\n')
 print(json.dumps(receipt),flush=True)
 # Retain even successful benchmark Stores until delivery; no cross-variant reuse.
 return receipt

def prepare_native():
 target=pathlib.Path('/home/estampes/projects/pr1d-native-regressions');target.mkdir(mode=0o700)
 for n in ['src','node_modules','scripts']:(target/n).symlink_to(CAND/n,target_is_directory=True)
 (target/'package.json').write_bytes((CAND/'package.json').read_bytes())
 shutil.copytree(CAND/'tests/fixtures',target/'tests/fixtures')
 paths=list((CAND/'tests').glob('persistence*.test.js'))+[CAND/'tests/fixtures'/n for n in ['uva-pr1a.mjs','uva-persistence.mjs','uva-lifecycle.mjs']]
 manifest=[]
 for p in paths:
  relative=p.relative_to(CAND);raw=p.read_text();s=raw
  if p.name=='uva-pr1a.mjs':s=s.replace('persistence: "memory"','persistence: "durable"')
  else:
   s=s.replace('"linux-process-crash-test"','"linux-local-durable"')
   if p.name in ['persistence-integrity-hardening.test.js','persistence-verification-race.test.js','persistence-state-machine.test.js','persistence-filesystem-trust.test.js']:
    s=s.replace("'linux-process-crash-test'","'linux-local-durable'")
    for a,b in [('persistence: "memory"','persistence: "durable"'),('persistence:"memory"','persistence:"durable"'),("persistence: 'memory'","persistence: 'durable'"),("persistence:'memory'","persistence:'durable'")]:s=s.replace(a,b)
   if p.name=='persistence-transactions.test.js':s=s.replace('first.ack.durability,"process-crash-test"','first.ack.durability,"durable"').replace('["linux-local-durable","linux-local-durable"]','["linux-local-durable"]')
  (target/relative).write_text(s)
  manifest.append({'path':str(relative),'sourceSha256':digest(p),'transformedSha256':digest(target/relative)})
 (OUT/'native-harness.json').write_text(json.dumps({'source':str(CAND),'target':str(target),'transform':'Existing native adapter literal substitutions only; unchanged production symlinks and test assertions. All current persistence files included.','files':manifest},indent=2)+'\n')
 subprocess.run(['diff','-ru',str(CAND/'tests'),str(target/'tests')],stdout=(OUT/'native-test-adaptation.diff').open('w'))
 return target

def main():
 headroom()
 assert subprocess.check_output(['git','status','--porcelain','--',str(OUT/'PROTOCOL.md'),str(ROOT/'scripts/pr1d-native-ab')],cwd=ROOT,text=True)==''
 freeze=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 assert subprocess.check_output(['git','show',freeze+':'+str((OUT/'PROTOCOL.md').relative_to(ROOT))],cwd=ROOT)==(OUT/'PROTOCOL.md').read_bytes()
 begin=time.monotonic();(OUT/'execution-start.json').write_text(json.dumps({'protocolCommit':freeze,'protocolSha256':digest(OUT/'PROTOCOL.md'),'startedUTC':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
 def bounded(*a,**kw):
  if time.monotonic()-begin>=7200:
   with (OUT/'not-run.jsonl').open('a') as f:f.write(json.dumps({'name':a[0],'reason':'total 7200 s budget exhausted'})+'\n')
   return
  return run(*a,**kw)
 benchmark=str(ROOT/'scripts/pr1d-native-ab/benchmark.mjs')
 bounded('canonical-parity',180,[NODE,str(ROOT/'scripts/pr1d-native-ab/parity.mjs'),str(BASE),str(CAND)])
 negative=['tests/document-canonical-remediation.test.js','tests/documents-foundation.test.js','tests/documents-review.test.js']
 # New candidate tests run unchanged against each exact runtime using disposable symlink tree.
 for label,source in [('baseline',BASE),('candidate',CAND)]:
  target=pathlib.Path('/home/estampes/projects/pr1d-negative-'+label);target.mkdir(mode=0o700)
  for n in ['src','node_modules','docs','scripts']:(target/n).symlink_to(source/n,target_is_directory=True)
  (target/'package.json').write_bytes((source/'package.json').read_bytes());(target/'tests').mkdir();shutil.copytree(CAND/'tests/fixtures',target/'tests/fixtures')
  for name in negative:shutil.copy2(CAND/name,target/name)
  bounded(label+'-negatives',180,[NODE,'--test','--test-concurrency=1',*[str(target/n) for n in negative]],source=source)
 sequence=[('document',8,1,'baseline'),('document',8,1,'candidate'),('document',8,2,'candidate'),('document',8,2,'baseline'),('document',16,1,'baseline'),('document',16,1,'candidate'),('document',32,1,'baseline'),('document',32,1,'candidate'),('document',32,2,'candidate'),('document',32,2,'baseline'),('history',100,1,'candidate'),('history',100,1,'baseline')]
 for mode,value,pair,label in sequence:
  bounded(f'{mode}-{value}-pair-{pair}-{label}',900 if mode=='history' else 180,[NODE,benchmark,mode,str(value)],source=BASE if label=='baseline' else CAND)
 for label,source in [('baseline',BASE),('candidate',CAND)]:
  bounded('document-8-profile-'+label,180,[NODE,benchmark,'document','8'],source=source,extra={'PR1D_MEASURE':'1','NODE_OPTIONS':'--import='+str(source/'scripts/pr1d-investigation/profile.mjs')})
 native=prepare_native()
 bounded('g2-native-once',420,[NODE,'--test','--test-concurrency=1','--test-name-pattern='+PATTERN,str(native/'tests/persistence-state-machine.test.js')],extra={'PR1D_G2_PRESERVE':'1','NODE_OPTIONS':'--import='+str(CAND/'scripts/pr1d-investigation/g2-preload.mjs')})
 bounded('candidate-native-integrity-crash',2400,[NODE,'--test','--test-concurrency=1','--test-skip-pattern='+PATTERN,*[str(p) for p in sorted((native/'tests').glob('persistence*.test.js'))]],allocation=GIB)
 ev=CAND/'docs/rfc/unified-visual-architecture/evidence'
 historical=[('r1-h01','pr1d-native-logs/superseded-current-regression.mjs'),('r1-independent','pr1d-native-logs/independent-cases.mjs'),('r2-storage','pr1d-native-round2/storage-faults.mjs'),('r2-cache','pr1d-native-round2/cache-integrity.mjs'),('r2-ack','pr1d-native-round2/cache-ack-race.mjs'),('r3-adversarial','pr1d-native-round3/adversarial.mjs'),('r3-metadata','pr1d-native-round3/metadata-boundary.mjs'),('r3-publication','pr1d-native-round3/publication-controls.mjs'),('r3-backup','pr1d-native-round3/backup-gc.mjs')]
 for name,p in historical:bounded(name,600,[NODE,'--test','--test-concurrency=1',str(ev/p)])
 (OUT/'execution-end.json').write_text(json.dumps({'seconds':time.monotonic()-begin,'completedUTC':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')

if __name__=='__main__':main()
