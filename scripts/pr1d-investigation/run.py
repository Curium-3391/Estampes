"""Bounded runner; each invocation takes a fresh private scratch. No native claim."""
import hashlib,json,os,pathlib,re,signal,subprocess,sys,tempfile,time,shutil
HERE=pathlib.Path(__file__).resolve().parent
REPO=HERE.parent.parent
NODE='/workspace/.estampes-tools/node-v22.23.4-linux-x64/bin/node'

def allocated(scratch):
    total=0
    for path in scratch.rglob('*'):
        try:total+=path.lstat().st_blocks*512
        except FileNotFoundError:pass  # atomic rename during sampling
    return total

def run(name,seconds,command,measure=False,extra=None):
    assert re.fullmatch(r'[a-z0-9-]+',name)
    out=REPO/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-investigation'
    case=out/name;case.mkdir(mode=0o700)
    scratch=pathlib.Path(tempfile.mkdtemp(prefix='pr1d-investigation-',dir='/tmp'))
    env={k:v for k,v in os.environ.items() if not k.startswith(('PR1D_','ESTAMPES_')) and k not in ('NODE_OPTIONS','LD_PRELOAD')}
    env.update(PR1D_SCRATCH=str(scratch),PR1D_OUTPUT=str(case),TMPDIR=str(scratch),PATH=str(pathlib.Path(NODE).parent)+':'+env['PATH'])
    inputs={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','scripts/pr1d-investigation','tests/fixtures'] for p in (REPO/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts}
    (case/'input-sha256.json').write_text(json.dumps(inputs,indent=2)+'\n')
    if measure:env.update(PR1D_MEASURE='1',NODE_OPTIONS='--import='+str(HERE/'profile.mjs'))
    if extra:env.update(extra)
    log=case/'raw.log';start=time.monotonic();stop=None;peak=tree=allocation=0;next_disk=0;seen=set()
    with log.open('xb') as stream:
        child=subprocess.Popen(command,cwd=REPO,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        while child.poll() is None:
            rows=[]
            for p in pathlib.Path('/proc').iterdir():
                if not p.name.isdigit():continue
                try:
                    status=(p/'status').read_text();parent=int(re.search(r'^PPid:\s+(\d+)',status,re.M)[1]);rss=int(re.search(r'^VmRSS:\s+(\d+)',status,re.M)[1]);hwm=int(re.search(r'^VmHWM:\s+(\d+)',status,re.M)[1]);rows.append((int(p.name),parent,rss,hwm))
                except (FileNotFoundError,ProcessLookupError,TypeError):pass
            descendants={child.pid}
            while True:
                expanded=descendants|{p for p,parent,_,_ in rows if parent in descendants}
                if expanded==descendants:break
                descendants=expanded
            seen|=descendants
            peak=max(peak,max((h for p,_,_,h in rows if p in descendants),default=0));tree=max(tree,sum(r for p,_,r,_ in rows if p in descendants))
            now=time.monotonic()
            if now>=next_disk:
                allocation=allocated(scratch);next_disk=now+5
            available=int(re.search(r'^MemAvailable:\s+(\d+)',pathlib.Path('/proc/meminfo').read_text(),re.M)[1])*1024
            cgroup=int(pathlib.Path('/sys/fs/cgroup/memory.current').read_text())
            if now-start>seconds:stop='wall budget'
            elif peak>1536*1024 or tree>3072*1024 or available<2*1024**3 or cgroup>7*1024**3:stop='memory budget'
            elif allocation>512*1024**2 or shutil.disk_usage(scratch).free<1024**3:stop='scratch budget'
            elif log.stat().st_size>32*1024**2:stop='log budget'
            if stop:
                for pid in descendants:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                break
            time.sleep(.5)
        code=child.wait()
    raw=log.read_bytes();record=dict(name=name,command=command,environment={k:env[k] for k in ['PR1D_SCRATCH','PR1D_OUTPUT','TMPDIR','PATH']},measure=measure,extra=extra,startedUTC=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(time.time()-(time.monotonic()-start))),wallSeconds=time.monotonic()-start,exitCode=code,stop=stop,budgetSeconds=seconds,peakProcessRssKiB=peak,peakTreeRssKiB=tree,peakAllocatedBytes=allocation,scratch=str(scratch),log=str(log.relative_to(out)),sha256=hashlib.sha256(raw).hexdigest())
    with (out/'runs.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
    print(json.dumps(record),flush=True)
    # Passing disposable benchmarks can be removed after exact evidence capture.
    # Failures and G2 captures remain; scratch belongs exclusively to this runner.
    if code==0 and not stop and not list(case.glob('failure-*')):shutil.rmtree(scratch)
    return record
if __name__=='__main__':
    name,seconds,mode,*command=sys.argv[1:]
    result=run(name,int(seconds),command,mode=='profile')
    sys.exit(124 if result['stop'] else result['exitCode'])
