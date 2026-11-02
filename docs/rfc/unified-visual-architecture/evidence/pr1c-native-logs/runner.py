import os, sys, json, subprocess, time, hashlib, re
from pathlib import Path
root=Path(__file__).parent
assert os.getuid()==1001, "Acceptance must run as non-root estampes"
env={k:v for k,v in os.environ.items() if not k.startswith("ESTAMPES_")}
env.update(PATH="/home/estampes/.nvm/versions/node/v22.23.4/bin:"+env["PATH"],TMPDIR=str(root/"tmp"),ESTAMPES_STORAGE_DIR="",ESTAMPES_ACCESS_KEY="",ESTAMPES_STORAGE_RETENTION_DAYS="0")
if (root/"venv/bin/python").exists():
    env["PYTHON"]=str(root/"venv/bin/python")
    env["PATH"]=str(root/"venv/bin")+":"+env["PATH"]
if (root/"browser-path").exists():
    env["CHROME_BIN"]=(root/"browser-path").read_text().strip()
    env["CHROMIUM_BIN"]=env["CHROME_BIN"]
env["LD_LIBRARY_PATH"]=str(root/"browser-libs/extracted/usr/lib/x86_64-linux-gnu")
name,*command=sys.argv[1:]
logs=Path("docs/rfc/unified-visual-architecture/evidence/pr1c-native-logs")
log=logs/(name+".log")
started=time.time()
with log.open("w") as out: result=subprocess.run(command,env=env,stdout=out,stderr=subprocess.STDOUT)
content=log.read_text()
counts={k:int(v) for k,v in re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$",content,re.M)}
record=dict(command=command,uid=os.getuid(),startedUTC=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime(started)),durationSeconds=round(time.time()-started,3),exitCode=result.returncode,counts=counts,log=str(log),sha256=hashlib.sha256(log.read_bytes()).hexdigest())
with (logs/"runs.jsonl").open("a") as f: f.write(json.dumps(record)+"\n")
print(json.dumps(record))
print("\n".join(content.splitlines()[-14:]))
sys.exit(result.returncode)
