"""Runs one job in a forked child with hard resource limits. The parent
(server.py) keeps the pid so it can SIGKILL on timeout or cancel."""
import json
import os
import resource
import signal
import sys

from .limits import LIMITS, CasError


def apply_limits(timeout_ms):
    cpu = int(timeout_ms / 1000) + 2
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
    mem = LIMITS.memory_mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    except (ValueError, OSError):
        pass
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        pass
    sys.setrecursionlimit(3000)


def child_main(fd, params, timeout_ms):
    """Never returns: writes one JSON object to fd and _exits."""
    code = 0
    try:
        apply_limits(timeout_ms)
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        from .ops import compute
        try:
            out = {"ok": True, "result": compute(params)}
        except CasError as e:
            out = {"ok": False, "error": {"code": e.code, "message": e.message}}
        except MemoryError:
            out = {"ok": False, "error": {"code": "resource_limit", "message": "the calculation needs too much memory"}}
        except RecursionError:
            out = {"ok": False, "error": {"code": "resource_limit", "message": "the calculation is too deep"}}
        except Exception:  # never leak a traceback to the client
            out = {"ok": False, "error": {"code": "internal", "message": "the engine failed on this input"}}
        data = json.dumps(out, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(data) > LIMITS.max_reply_bytes:
            data = json.dumps({"ok": False, "error": {"code": "resource_limit", "message": "the result is too large"}}).encode()
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except BaseException:
        code = 1
    finally:
        os._exit(code)
