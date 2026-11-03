import os,sys,json,subprocess,time,hashlib,re,signal
from pathlib import Path
root=Path(__file__).parent
assert os.getuid()==1001
logs=Path("docs/rfc/unified-visual-architecture/evidence/pr1d-native-round3")
env={k:v for k,v in os.environ.items() if not k.startswith("ESTAMPES_")}
env.update(PATH="/home/estampes/.nvm/versions/node/v22.23.4/bin:"+env["PATH"],TMPDIR=str(root/"tmp"),ESTAMPES_STORAGE_DIR="",ESTAMPES_ACCESS_KEY="",ESTAMPES_STORAGE_RETENTION_DAYS="0",PR1D_ACCEPT_ROOT=str(root))
if (root/"venv/bin/python").exists():
 env["PYTHON"]=str(root/"venv/bin/python");env["PATH"]=str(root/"venv/bin")+":"+env["PATH"]
if (root/"browser-path").exists():
 env["CHROME_BIN"]=(root/"browser-path").read_text().strip();env["CHROMIUM_BIN"]=env["CHROME_BIN"]
env["LD_LIBRARY_PATH"]=str(root/"browser-libs/extracted/usr/lib/x86_64-linux-gnu")
name,*cmd=sys.argv[1:];log=logs/(name+".log");started=time.time()
assert not log.exists(),"Never overwrite failed evidence"
with log.open("w") as out:
 p=subprocess.Popen(cmd,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
 try: code=p.wait(timeout=2400)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGKILL);p.wait();code=124
body=log.read_text(errors="replace")
record=dict(command=cmd,uid=os.getuid(),startedUTC=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime(started)),durationSeconds=round(time.time()-started,3),exitCode=code,inputSha256={arg:hashlib.sha256(Path(arg).read_bytes()).hexdigest() for arg in cmd if Path(arg).is_file() and Path(arg).suffix in [".mjs",".js",".py"]},counts={k:int(v) for k,v in re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$",body,re.M)},log=str(log),sha256=hashlib.sha256(log.read_bytes()).hexdigest())
with (logs/"runs.jsonl").open("a") as f:f.write(json.dumps(record)+"\n")
print(json.dumps(record));print("\n".join(body.splitlines()[-12:]));sys.exit(code)
