"""From the repository root, run as estampes with a new owned ext4 scratch.

python3 <this file> /home/estampes/<new-0700-scratch> all
Use "original" or "instrumented" to run the corresponding phase separately.
New logs go to <scratch>/evidence. Checked-in evidence remains immutable.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import time

EVIDENCE = Path(__file__).resolve().parent
HISTORICAL = EVIDENCE.parent / "pr1d-final-acceptance"
NODE = Path.home() / ".nvm/versions/node/v22.23.4/bin/node"
LIMIT = 16 * 1024 ** 2
PATTERN = "four interrupted recovery epochs.*current.before-rename"
CASES = [(f"strict-{i}", "strict") for i in range(1, 5)] + [
    ("control-uninterrupted", "uninterrupted"),
    ("control-bounded-drain", "bounded-drain"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(scratch, native, name, mode=None):
    evidence = scratch / "evidence"
    log = evidence / (name + ".log")
    trace = evidence / (name + ".jsonl")
    assert not log.exists() and not trace.exists(), f"Refusing to overwrite {name}"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("ESTAMPES_", "PR1D_")) and key != "NODE_OPTIONS"}
    temp = scratch / ("tmp-" + name)
    temp.mkdir(mode=0o700)
    env.update(TMPDIR=str(temp), ESTAMPES_STORAGE_DIR="", ESTAMPES_ACCESS_KEY="",
               ESTAMPES_STORAGE_RETENTION_DAYS="0", PR1D_ACCEPT_ROOT=str(scratch))
    command = [str(NODE), "--test", "--test-concurrency=1"]
    inputs = [native / "tests/fixtures" / name for name in
              ("uva-lifecycle.mjs", "uva-persistence.mjs", "uva-pr1a.mjs")]
    if mode is None:
        entry = native / "tests/persistence-state-machine.test.js"
        command.extend(["--test-name-pattern", PATTERN, str(entry)])
    else:
        entry = native / "tests/replay.mjs"
        command.append(str(entry))
        env.update(PR1D_G2_MODE=mode, PR1D_G2_TRACE=str(trace))
        inputs.extend(native / "tests" / name for name in ("observe.mjs", "worker-observer.mjs"))
    started = time.time()
    with log.open("xb") as out:
        process = subprocess.Popen(command, env=env, stdout=out, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            code = process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    counts = dict(re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$",
                             log.read_text(errors="replace"), re.M))
    record = dict(name=name, mode=mode, command=command, uid=os.getuid(),
                  startedUTC=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                  durationSeconds=round(time.time() - started, 3), exitCode=code,
                  inputSha256={str(path): digest(path) for path in [entry, *inputs]},
                  counts={key: int(value) for key, value in counts.items()},
                  log=log.name, sha256=digest(log))
    if trace.exists():
        record.update(trace=trace.name, traceSha256=digest(trace))
    with (evidence / "runs.jsonl").open("a") as output:
        output.write(json.dumps(record) + "\n")
    print(json.dumps(record), flush=True)
    if code in (124, -signal.SIGXFSZ) or (
        trace.exists() and (trace.stat().st_size >= LIMIT or '"event":"resource-stop"' in trace.read_text())
    ) or log.stat().st_size >= LIMIT or any(temp.iterdir()):
        raise SystemExit(f"Stopping fixed run list after timeout, resource cap or incomplete cleanup in {name}")
    return code


def main():
    scratch = Path(sys.argv[1]).resolve(strict=True)
    phase = sys.argv[2]
    assert phase in ("all", "original", "instrumented")
    assert os.getuid() == 1001 and scratch.is_relative_to(Path.home()) and scratch != Path.home()
    assert scratch.stat().st_uid == os.getuid() and stat.S_IMODE(scratch.stat().st_mode) == 0o700
    assert subprocess.check_output(["findmnt", "-n", "-o", "FSTYPE", "-T", scratch], text=True).strip() == "ext4"
    assert shutil.disk_usage(scratch).free >= 1024 ** 3
    assert NODE.is_file()
    resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
    (scratch / "evidence").mkdir(mode=0o700)
    native = scratch / "native"
    subprocess.run([sys.executable, HISTORICAL / "prepare-native.py", Path.cwd(), native], check=True)
    codes = []
    if phase != "instrumented":
        codes.append(run(scratch, native, "original"))
    if phase != "original":
        for name in ("replay.mjs", "observe.mjs", "worker-observer.mjs"):
            shutil.copyfile(EVIDENCE / name, native / "tests" / name)
        codes.extend(run(scratch, native, name, mode) for name, mode in CASES)
    return int(any(codes))


if __name__ == "__main__":
    sys.exit(main())
