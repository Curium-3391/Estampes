"""Create only a NEW disposable harness; existing sealed source/tests are never edited.
Usage: python3 prepare-native.py WORKSPACE NEW_HARNESS_ROOT
Use separate owned 0700 ext4 TMPDIR, then node --test --test-concurrency=1 NEW_HARNESS_ROOT/tests/persistence-*.test.js
"""
from pathlib import Path
import sys,shutil,json,hashlib
workspace=Path(sys.argv[1]).resolve();destination=Path(sys.argv[2]).resolve();destination.mkdir(mode=0o700)
manifest=json.loads(Path(__file__).with_name("native-harness.json").read_text())
for name in ["src","node_modules"]:(destination/name).symlink_to(workspace/name,target_is_directory=True)
shutil.copy2(workspace/"package.json",destination/"package.json")
(destination/"tests").mkdir();shutil.copytree(workspace/"tests/fixtures",destination/"tests/fixtures")
for row in manifest["files"]:
 name=row["path"];s=(workspace/name).read_text();assert hashlib.sha256(s.encode()).hexdigest()==row["sourceSha256"],name
 if name.endswith("uva-pr1a.mjs"):s=s.replace('persistence: "memory"','persistence: "durable"')
 else:
  s=s.replace('"linux-process-crash-test"','"linux-local-durable"')
  if name.endswith(("/persistence-integrity-hardening.test.js","/persistence-verification-race.test.js","/persistence-state-machine.test.js","/persistence-filesystem-trust.test.js")):
   s=s.replace("'linux-process-crash-test'","'linux-local-durable'").replace('persistence: "memory"','persistence: "durable"').replace('persistence:"memory"','persistence:"durable"').replace("persistence: 'memory'","persistence: 'durable'").replace("persistence:'memory'","persistence:'durable'")
  if name.endswith("persistence-transactions.test.js"):
   s=s.replace('first.ack.durability,"process-crash-test"','first.ack.durability,"durable"').replace('["linux-local-durable","linux-local-durable"]','["linux-local-durable"]')
 (destination/name).write_text(s);assert hashlib.sha256(s.encode()).hexdigest()==row["harnessSha256"],name
print(destination)
