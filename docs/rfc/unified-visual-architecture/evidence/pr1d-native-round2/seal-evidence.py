import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

evidence = Path(sys.argv[1])
report = Path(sys.argv[2])
digest = lambda data: hashlib.sha256(data).hexdigest()
runs = list(map(json.loads, (evidence / "runs.jsonl").read_text().splitlines()))
sealed_runs = []
for run in runs:
    path = Path(run["log"])
    raw_archive = path.with_suffix(".log.gz")
    if raw_archive.exists():
        raw = gzip.decompress(raw_archive.read_bytes())
    else:
        raw = path.read_bytes()
    assert digest(raw) == run["sha256"], path
    normalized = re.sub(rb"[ \t\r]+(?=\n|$)", b"", raw).rstrip(b"\n")
    if normalized:
        normalized += b"\n"
    if normalized != raw:
        if not raw_archive.exists():
            raw_archive.write_bytes(gzip.compress(raw, mtime=0))
        assert gzip.decompress(raw_archive.read_bytes()) == raw
        path.write_bytes(normalized)
        sealed_runs.append({"log": path.name, "rawGzip": raw_archive.name, "rawSha256": digest(raw),
                            "readableLogSha256": digest(normalized)})

input_corrections = [{
    "runLog": "supplemental-storage.log",
    "executedInput": "storage-faults-first.mjs.txt",
    "sha256": digest((evidence / "storage-faults-first.mjs.txt").read_bytes()),
    "reason": "The historical runner hashed input paths at completion. This script changed after the first child had loaded its test module."
}]
payload = {
    "schema": "estampes.pr1d-native-round2-evidence/1",
    "sourceBranch": "fix/unified-visual-architecture-pr1d-native-findings",
    "sourceCommit": "88d892829c7fada3ebbf5db8a2bcdf8c42975c47",
    "testCommit": "26a51e6f9f85e7d64870810bb93d7f58db42ece4",
    "runCount": len(runs),
    "recordedNonzeroRuns": [Path(r["log"]).name for r in runs if r["exitCode"]],
    "inputCorrections": input_corrections,
    "normalizedDisplayLogsWithLosslessRaw": sealed_runs,
    "files": [],
}
for path in sorted([report, *evidence.iterdir()]):
    if not path.is_file() or path.name == "manifest.json":
        continue
    data = path.read_bytes()
    item = {"path": str(path), "bytes": len(data), "sha256": digest(data)}
    if path.suffix == ".gz":
        original = gzip.decompress(data)
        item.update(rawBytes=len(original), rawSha256=digest(original))
    payload["files"].append(item)
(evidence / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
print(len(runs), "recorded runs verified;", len(payload["files"]), "evidence files sealed")
