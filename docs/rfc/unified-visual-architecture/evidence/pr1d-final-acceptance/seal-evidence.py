import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

evidence, report = map(Path, sys.argv[1:])
digest = lambda data: hashlib.sha256(data).hexdigest()
runs = list(map(json.loads, (evidence / "runs.jsonl").read_text().splitlines()))
normalized = []
for run in runs:
    path = Path(run["log"])
    archive = path.with_suffix(".log.gz")
    raw = gzip.decompress(archive.read_bytes()) if archive.exists() else path.read_bytes()
    assert digest(raw) == run["sha256"], path
    clean = re.sub(rb"[ \t\r]+(?=\n|$)", b"", raw).rstrip(b"\n")
    if clean:
        clean += b"\n"
    if clean != raw:
        if not archive.exists():
            archive.write_bytes(gzip.compress(raw, mtime=0))
        assert gzip.decompress(archive.read_bytes()) == raw
        path.write_bytes(clean)
        normalized.append({"log":path.name,"rawGzip":archive.name,
                           "rawSha256":digest(raw),"readableLogSha256":digest(clean)})
payload = {
    "schema":"estampes.pr1d-final-acceptance-evidence/1",
    "sourceCommit":"29d097833688ddb649a88cb2a09f22ba5fadda8e",
    "sourceTree":"756ea491e27bce3a2998dc61ba1e3ee34525919c",
    "previousNativeBaseline":"31dae29f1cf7d1e8caf6c670124eed7c7ed91e11",
    "testCommit":"25b2f9b62e716c1b2deb699cf7dd6ae70c3d6687",
    "completedRuns":len(runs),
    "nonzeroRuns":[Path(r["log"]).name for r in runs if r["exitCode"]],
    "normalizedDisplayLogsWithLosslessRaw":normalized,
    "files":[],
}
for path in sorted([report,*evidence.iterdir()]):
    if not path.is_file() or path.name=="manifest.json":
        continue
    data=path.read_bytes()
    item={"path":str(path),"bytes":len(data),"sha256":digest(data)}
    if path.suffix==".gz":
        raw=gzip.decompress(data)
        item.update(rawBytes=len(raw),rawSha256=digest(raw))
    payload["files"].append(item)
(evidence/"manifest.json").write_text(json.dumps(payload,indent=2)+"\n")
print(len(runs),"completed runs and",len(payload["files"]),"files sealed")
