"""Recreate the supplemental harness without changing workspace sources.
Usage: python3 prepare-native-harness.py WORKSPACE NEW_DISPOSABLE_HARNESS
The destination must not already exist. Run tests with a separate owned 0700 TMPDIR.
"""
import hashlib, json, shutil, sys
from pathlib import Path
workspace=Path(sys.argv[1]).resolve()
destination=Path(sys.argv[2]).resolve()
manifest=json.loads(Path(__file__).with_name("native-harness.json").read_text())
destination.mkdir(mode=0o700)
for name in ["src", "node_modules"]:
    (destination/name).symlink_to(workspace/name,target_is_directory=True)
shutil.copy2(workspace/"package.json",destination/"package.json")
(destination/"tests").mkdir()
shutil.copytree(workspace/"tests/fixtures",destination/"tests/fixtures")
for name,record in manifest["transforms"].items():
    source=(workspace/name).read_text()
    for old,new in record["replacements"]:
        assert source.count(old)==1,(name,old)
        source=source.replace(old,new)
    output=destination/name
    output.write_text(source)
    assert hashlib.sha256(output.read_bytes()).hexdigest()==record["sha256"],name
print(destination)
