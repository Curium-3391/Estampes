"""Publish finished scratch logs losslessly and verify the original source seal."""
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys

BASE = "82ae9081f6e60b4965d56138a8046d5831922e1d"
OUTPUT = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main(scratch):
    original = scratch / "evidence"
    source = json.loads((original / "source-manifest.json").read_text())
    assert source["source"] == BASE
    for name, seal in source["files"].items():
        actual = Path(name).read_bytes()
        assert len(actual) == seal["bytes"] and digest(actual) == seal["sha256"], name

    commands = [json.loads(line) for line in (original / "runs.jsonl").read_text().splitlines()]
    for row in commands:
        assert digest((original / row["log"]).read_bytes()) == row["sha256"], row["name"]

    raw = {p.name: p.read_bytes() for p in original.iterdir() if p.is_file()}
    gc_trace = scratch / "tmp/maintenance-drain/g2-trace.jsonl"
    if gc_trace.exists():
        raw[gc_trace.name] = gc_trace.read_bytes()
    logs = []
    for name, data in sorted(raw.items()):
        # Keep small UTF-8 logs directly readable if whitespace-safe. Keep a
        # lossless compressed copy for the larger trace and raw TAP output.
        payload = data
        if name.endswith(".log") and any(line.rstrip(b" \t\r") != line for line in data.split(b"\n")):
            payload = b"\n".join(line.rstrip(b" \t\r") for line in data.split(b"\n"))
        if payload != data or len(data) > 512 * 1024:
            target = OUTPUT / (name + ".gz")
            compressed = gzip.compress(data, compresslevel=9, mtime=0)
            assert gzip.decompress(compressed) == data
            with target.open("xb") as out:
                out.write(compressed)
            logs.append({"log": name, "rawGzip": target.name, "rawSha256": digest(data)})
        if len(data) <= 512 * 1024:
            with (OUTPUT / name).open("xb") as out:
                out.write(payload)
    manifest = {
        "schema": "estampes.pr1d-frozen-qualification-evidence/1",
        "source": BASE,
        "sourceTree": source["sourceTree"],
        "production": source["production"],
        "productionTree": source["productionTree"],
        "trackedFilesVerified": len(source["files"]),
        "firstFrozenMatrixCommit": "99e160d7a2d5fbedae781dec620f3834ecb5b2fe",
        "harnessCommitAtSeal": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "runsRecorded": len(commands),
        "losslessRaw": logs,
        "files": {
            p.name: {"sha256": digest(p.read_bytes()), "bytes": p.stat().st_size}
            for p in sorted(OUTPUT.iterdir()) if p.is_file()
        },
    }
    with (OUTPUT / "manifest.json").open("x") as out:
        out.write(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(source['files'])} source files and {len(commands)} run receipts verified")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(strict=True))
