"""Verify Round 2 production, test and evidence inputs against the exact base."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

base = "88d892829c7fada3ebbf5db8a2bcdf8c42975c47"
evidence = Path(__file__).parent
report = evidence.parent.parent / "PR-1D-NATIVE-REACCEPTANCE-ROUND2-REPORT.md"
relative_evidence = evidence.relative_to(Path.cwd())
relative_report = report.relative_to(Path.cwd())
reference = "refs/remotes/origin/fix/unified-visual-architecture-pr1d-native-findings"
assert subprocess.check_output(["git", "rev-parse", reference], text=True).strip() == base
subprocess.run(["git", "merge-base", "--is-ancestor", base, "HEAD"], check=True)
subprocess.run(["git", "diff", "--exit-code", base, "--", ".",
                f":(exclude){relative_evidence}", f":(exclude){relative_report}"], check=True)
manifest = json.loads((evidence / "source-manifest.json").read_text())
assert manifest["sourceCommit"] == base
for item in manifest["files"]:
    path = item["path"]
    actual = Path(path).read_bytes()
    expected = subprocess.check_output(["git", "show", f"{base}:{path}"])
    assert actual == expected and len(actual) == item["bytes"], path
    assert hashlib.sha256(actual).hexdigest() == item["sha256"], path
print(f"{len(manifest['files'])} original files exactly match their baseline SHA-256 and bytes")
harness = json.loads((evidence / "native-harness.json").read_text())
assert harness["sourceCommit"] == base
directory = Path(sys.argv[1])
assert directory == Path(harness["root"])
assert (directory / "src").resolve() == Path("src").resolve()
for item in harness["files"]:
    path = item["path"]
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == item["sourceSha256"], path
    assert hashlib.sha256((directory / path).read_bytes()).hexdigest() == item["harnessSha256"], path
print(f"{len(harness['files'])} source and native harness fixture/test pairs exactly match their hashes")
