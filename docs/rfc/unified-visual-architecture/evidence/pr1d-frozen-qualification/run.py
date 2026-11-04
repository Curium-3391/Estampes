"""Run one frozen case from the repository root as UID 1001 on verified ext4."""
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

MIB = 1024**2
GIB = 1024**3
LOG_LIMIT = 32 * MIB


def rss_tree(leader):
    rows = [tuple(map(int, row.split())) for row in
            subprocess.check_output(["ps", "-e", "-o", "pid=,ppid=,pgid=,rss="], text=True).splitlines()]
    descendants = {leader}
    while True:
        updated = descendants | {pid for pid, parent, group, _ in rows
                                 if parent in descendants or group == leader}
        if updated == descendants:
            return {pid: rss for pid, _, _, rss in rows if pid in descendants}
        descendants = updated


def allocated(path):
    return int(subprocess.check_output(["du", "-s", "-B1", "--", path], text=True).split()[0])


def run(scratch, name, timeout, allocation_cap, command):
    assert os.getuid() == 1001
    assert scratch.is_relative_to(Path.home()) and scratch != Path.home()
    assert scratch.stat().st_uid == os.getuid() and stat.S_IMODE(scratch.stat().st_mode) == 0o700
    assert subprocess.check_output(["findmnt", "-n", "-o", "SOURCE,FSTYPE", "-T", scratch],
                                   text=True).split() == ["/dev/sdd", "ext4"]
    case = scratch / "tmp" / name
    case.mkdir(mode=0o700)
    log = scratch / "evidence" / (name + ".log")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ESTAMPES_", "PR1D_"))
           and k not in ("NODE_OPTIONS", "LD_PRELOAD")}
    node = Path.home() / ".nvm/versions/node/v22.23.4/bin"
    env.update(PATH=str(node) + ":" + env["PATH"], TMPDIR=str(case), PR1D_ACCEPT_ROOT=str(case),
               QUAL_SCRATCH=str(scratch), ESTAMPES_STORAGE_DIR="", ESTAMPES_ACCESS_KEY="",
               ESTAMPES_STORAGE_RETENTION_DAYS="0", PYTHONDONTWRITEBYTECODE="1")
    started = time.monotonic()
    wall = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    peak_rss = peak_sum = peak_blocks = 0
    next_disk = 0
    stop = None
    resource.setrlimit(resource.RLIMIT_FSIZE, (12 * GIB, 12 * GIB))
    with log.open("xb") as out:
        child = subprocess.Popen(command, env=env, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        while child.poll() is None:
            rss = rss_tree(child.pid)
            peak_rss = max(peak_rss, max(rss.values(), default=0))
            peak_sum = max(peak_sum, sum(rss.values()))
            now = time.monotonic()
            if now >= next_disk:
                blocks = allocated(case)
                peak_blocks = max(peak_blocks, blocks)
                if blocks > allocation_cap or allocated(scratch) > 12 * GIB:
                    stop = "allocated scratch cap"
                if shutil.disk_usage(scratch).free < 48 * GIB:
                    stop = "free ext4 space floor"
                next_disk = now + 5
            available = int(re.search(r"^MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text(), re.M)[1])
            if now - started >= timeout:
                stop = "wall timeout"
            elif log.stat().st_size > LOG_LIMIT:
                stop = "log cap"
            elif peak_rss > 1536 * 1024 or peak_sum > 3072 * 1024 or available < 2048 * 1024:
                stop = "RSS cap or available memory floor"
            if stop:
                for pid in set(rss) - {child.pid}:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            time.sleep(1)
        code = child.wait()
    raw = log.read_bytes()
    counts = {k: int(v) for k, v in re.findall(rb"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", raw, re.M)}
    record = dict(name=name, command=command, uid=os.getuid(), startedUTC=wall,
                  durationSeconds=round(time.monotonic()-started, 3), exitCode=code,
                  stop=stop, timeoutSeconds=timeout, peakProcessRssKiB=peak_rss, peakTreeRssKiB=peak_sum,
                  peakAllocatedBytes=peak_blocks, log=log.name, sha256=hashlib.sha256(raw).hexdigest(),
                  counts={k.decode(): v for k, v in counts.items()})
    with (log.parent / "runs.jsonl").open("a") as stream:
        stream.write(json.dumps(record) + "\n")
    print(json.dumps(record), flush=True)
    return 124 if stop else code


if __name__ == "__main__":
    path, name, timeout, mib, *command = sys.argv[1:]
    assert re.fullmatch(r"[a-z0-9-]+", name)
    sys.exit(run(Path(path).resolve(strict=True), name, int(timeout), int(mib)*MIB, command))
