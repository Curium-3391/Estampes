from pathlib import Path
import hashlib
import json
import subprocess

base = "b2f853c5e7473a008552ff70c838de3faff07c20"
tree = "c634b864f5643ffc189f1dddedf38d1656ada57d"
previous = "a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0"
evidence = Path(__file__).resolve().parent.relative_to(Path.cwd())
report = evidence.parent.parent / "PR-1D-NATIVE-REACCEPTANCE-ROUND3-REPORT.md"
tracking = "refs/remotes/origin/fix/unified-visual-architecture-pr1d-integrity-hardening"

def git(*args):
    return subprocess.check_output(["git", *args])

assert git("rev-parse", base+"^{tree}").decode().strip() == tree
assert git("rev-parse", tracking).decode().strip() == base
subprocess.run(["git","merge-base","--is-ancestor",previous,base],check=True)
subprocess.run(["git","merge-base","--is-ancestor",base,"HEAD"],check=True)
subprocess.run(["git","diff","--exit-code",base,"--",".",f":(exclude){evidence}",
                f":(exclude){report}"],check=True)
subprocess.run(["git","diff","--exit-code",previous,base,"--",
                str(evidence.parent/"pr1d-native-round2"),
                str(evidence.parent/"pr1d-native-logs")],check=True)
paths = git("ls-tree","-r","--name-only","-z",base).decode().rstrip("\0").split("\0")
rows = []
for name in paths:
    actual = Path(name).read_bytes()
    assert git("show",base+":"+name) == actual,name
    rows.append({"path":name,"bytes":len(actual),"sha256":hashlib.sha256(actual).hexdigest()})
(evidence/"source-manifest.json").write_text(json.dumps(
    {"commit":base,"tree":tree,"previousNativeBaseline":previous,"files":rows},indent=2)+"\n")
print(len(rows),"files in the selected source tree are byte-identical")
