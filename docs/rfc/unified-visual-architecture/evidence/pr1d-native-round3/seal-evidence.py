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
interrupted = {
    "log": str(evidence / "full-serial.log"),
    "command": ["node", "--test", "--test-concurrency=1"],
    "exitCode": None,
    "reason": "WSL host restarted before command completion and run index write."
}
for run in [*runs, interrupted]:
    path = Path(run["log"])
    archive = path.with_suffix(".log.gz")
    raw = gzip.decompress(archive.read_bytes()) if archive.exists() else path.read_bytes()
    if run is interrupted:
        run["sha256"] = digest(raw)
    assert digest(raw) == run["sha256"], path
    cleaned = re.sub(rb"[ \t\r]+(?=\n|$)", b"", raw).rstrip(b"\n")
    if cleaned:
        cleaned += b"\n"
    if cleaned != raw or run is interrupted:
        if not archive.exists():
            archive.write_bytes(gzip.compress(raw, mtime=0))
        assert gzip.decompress(archive.read_bytes()) == raw
        path.write_bytes(cleaned)
        normalized.append({"log": path.name, "rawGzip": archive.name,
                           "rawSha256": digest(raw), "readableLogSha256": digest(cleaned)})
payload = {
    "schema": "estampes.pr1d-native-round3-evidence/1",
    "sourceCommit": "b2f853c5e7473a008552ff70c838de3faff07c20",
    "sourceTree": "c634b864f5643ffc189f1dddedf38d1656ada57d",
    "previousNativeBaseline": "a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0",
    "completedRuns": len(runs),
    "nonzeroRuns": [Path(run["log"]).name for run in runs if run["exitCode"]],
    "interrupted": interrupted,
    "normalizedDisplayLogsWithLosslessRaw": normalized,
    "files": [],
}
for path in sorted([report, *evidence.iterdir()]):
    if not path.is_file() or path.name == "manifest.json":
        continue
    data = path.read_bytes()
    item = {"path": str(path), "bytes": len(data), "sha256": digest(data)}
    if path.suffix == ".gz":
        raw = gzip.decompress(data)
        item.update(rawBytes=len(raw), rawSha256=digest(raw))
    payload["files"].append(item)
(evidence / "manifest.json").write_text(json.dumps(payload, indent=2)+"\n")
print(len(runs),"completed runs and",len(payload["files"]),"files sealed")
