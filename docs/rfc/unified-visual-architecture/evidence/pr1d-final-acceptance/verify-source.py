from pathlib import Path
import hashlib
import json
import subprocess

base = "29d097833688ddb649a88cb2a09f22ba5fadda8e"
previous = "31dae29f1cf7d1e8caf6c670124eed7c7ed91e11"
evidence = Path(__file__).resolve().parent.relative_to(Path.cwd())
hardening = evidence.parent / "pr1d-state-machine-hardening"
report = evidence.parent.parent / "PR-1D-FINAL-ENGINEERING-ACCEPTANCE-REPORT.md"
tracking = "refs/remotes/origin/fix/unified-visual-architecture-pr1d-state-machine-hardening"

def git(*args):
    return subprocess.check_output(["git", *args])

def list_paths(*args):
    return [p for p in git(*args).decode().split("\0") if p]

assert git("rev-parse", tracking).decode().strip() == base
subprocess.run(["git","merge-base","--is-ancestor",previous,base],check=True)
subprocess.run(["git","merge-base","--is-ancestor",base,"HEAD"],check=True)
subprocess.run(["git","diff","--exit-code",base,"--",".",f":(exclude){evidence}",f":(exclude){report}"],check=True)
authorization = json.loads((hardening/"authorization.json").read_text())
assert authorization["evidenceBaseCommit"] == previous
allowed = set(authorization["authorizedProductionAndTestPaths"])
changed = set(list_paths("diff","--name-only","-z",previous,base,"--","src","tests"))
assert changed == allowed, changed ^ allowed
documentation = {str(evidence.parent/"check-consistency.mjs"),
    str(evidence.parent.parent/"PR-1D-FILESYSTEM-TRUST-MODEL.md"),
    str(evidence.parent.parent/"PR-1D-STATE-MACHINE-HARDENING-REPORT.md")}
for name in list_paths("diff","--name-only","-z",previous,base):
    assert name in allowed or name in documentation or name.startswith(str(hardening)+"/"),name
for name in list_paths("diff","--diff-filter=MDR","--name-only","-z",previous,base):
    assert name in allowed or name == str(evidence.parent/"check-consistency.mjs"),name
paths = list_paths("ls-tree","-r","--name-only","-z",base)
rows = []
for name in paths:
    data = Path(name).read_bytes()
    assert git("show",base+":"+name) == data,name
    rows.append({"path":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
sealed = {"commit":base,"tree":git("rev-parse",base+"^{tree}").decode().strip(),
          "previousNativeBaseline":previous,"changedSourceAndTestPaths":sorted(changed),"files":rows}
(evidence/"source-manifest.json").write_text(json.dumps(sealed,indent=2)+"\n")
print(len(rows),"selected source-tree files are byte-identical;",len(changed),"authorized hardening source/test paths")
