"""Unix-socket CAS server. One forked child per job (SymPy already
imported, so a job starts in milliseconds); the parent enforces a
wall-clock timeout and cancel with SIGKILL. Not a network service."""
import asyncio
import json
import os
import signal
import socket
import struct
import sys

from . import ops, protocol
from .limits import LIMITS, CasError
from .worker import child_main

SOCKET = os.environ.get("ESTAMPES_CAS_SOCKET", "/run/estampes-cas/cas.sock")
ALLOWED_UID = os.environ.get("ESTAMPES_CAS_ALLOWED_UID", "")


class Service:
    def __init__(self):
        self.sem = asyncio.Semaphore(LIMITS.workers)
        self.waiting = 0
        self.running = {}  # request id -> pid
        self.cancelled = set()
        self.listening = []

    async def run_job(self, rid, params):
        if self.waiting >= LIMITS.queue + LIMITS.workers and self.sem.locked():
            raise CasError("resource_limit", "the calculator is busy, try again in a moment")
        self.waiting += 1
        try:
            async with self.sem:
                return await self._fork(rid, params)
        finally:
            self.waiting -= 1

    async def _fork(self, rid, params):
        timeout_ms = min(int(params.pop("timeoutMs", LIMITS.timeout_ms)), LIMITS.timeout_ms)
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:  # child
            os.close(r)
            for s in self.listening:
                try: s.close()
                except Exception: pass
            child_main(w, params, timeout_ms)
        os.close(w)
        self.running[rid] = pid
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=LIMITS.max_reply_bytes + 1024)
        transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(r, "rb", buffering=0))
        try:
            data = await asyncio.wait_for(reader.read(LIMITS.max_reply_bytes + 1), timeout_ms / 1000)
        except asyncio.TimeoutError:
            self._kill(pid)
            raise CasError("timeout", "the calculation took longer than %.1f s and was stopped" % (timeout_ms / 1000))
        finally:
            transport.close()
            self.running.pop(rid, None)
            self._kill(pid)
        if rid in self.cancelled:
            self.cancelled.discard(rid)
            raise CasError("cancelled", "the calculation was cancelled")
        if not data:
            raise CasError("resource_limit", "the calculation was stopped (out of memory or time)")
        if len(data) > LIMITS.max_reply_bytes:
            raise CasError("resource_limit", "the result is too large")
        out = json.loads(data.decode("utf-8"))
        if not out.get("ok"):
            raise CasError(out["error"]["code"], out["error"]["message"])
        return out["result"]

    def _kill(self, pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    async def handle(self, req):
        method, rid = req.get("method"), str(req.get("id", ""))[:64]
        if method == "health":
            return {"engine": {"name": "SymPy", "version": ops.VERSION}, "operations": list(ops.OPERATIONS), "running": len(self.running),
                    "limits": {"timeoutMs": LIMITS.timeout_ms, "maxExprChars": LIMITS.max_expr_chars, "maxMatrix": LIMITS.max_matrix, "maxPrecision": LIMITS.max_precision}}
        if method == "parse":
            from .latex_in import latex_to_text
            from .parser import parse
            p = req.get("params") or {}
            src = latex_to_text(p["latex"]) if isinstance(p.get("latex"), str) else p.get("text")
            ast = parse(src)
            return {"ast": ast, "text": src}
        if method == "cancel":
            target = str((req.get("params") or {}).get("target", ""))[:64]
            pid = self.running.get(target)
            if pid:
                self.cancelled.add(target)
                self._kill(pid)
            return {"cancelled": bool(pid)}
        if method == "compute":
            params = req.get("params")
            if not isinstance(params, dict):
                raise CasError("syntax", "params must be an object")
            return await self.run_job(rid, params)
        raise CasError("unsupported", "unknown method")

    async def client(self, reader, writer):
        sock = writer.get_extra_info("socket")
        if ALLOWED_UID:
            try:
                uid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
            except OSError:
                uid = -1
            if str(uid) != ALLOWED_UID and uid != 0:
                writer.close()
                return
        tasks = set()

        async def one(req):
            rid = str(req.get("id", ""))[:64]
            try:
                if req.get("v") != protocol.VERSION:
                    raise CasError("unsupported", "unsupported protocol version")
                out = {"v": 1, "id": rid, "ok": True, "result": await self.handle(req)}
            except CasError as e:
                out = {"v": 1, "id": rid, "ok": False, "error": {"code": e.code, "message": e.message}}
            except Exception:
                out = {"v": 1, "id": rid, "ok": False, "error": {"code": "internal", "message": "the service failed on this request"}}
            try:
                writer.write(protocol.encode(out, LIMITS.max_reply_bytes + 4096))
                await writer.drain()
            except (ConnectionError, CasError):
                pass

        try:
            while True:
                req = await protocol.read_frame(reader)
                if not isinstance(req, dict):
                    break
                t = asyncio.create_task(one(req)); tasks.add(t); t.add_done_callback(tasks.discard)
        except (asyncio.IncompleteReadError, ConnectionError, CasError, json.JSONDecodeError, UnicodeDecodeError):
            pass
        finally:
            for rid in list(self.running):
                pass  # jobs finish or time out on their own; results of a closed client are dropped
            writer.close()


async def main():
    svc = Service()
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    server = await asyncio.start_unix_server(svc.client, path=SOCKET)
    os.umask(old)
    os.chmod(SOCKET, 0o600)
    svc.listening = [s for s in server.sockets]
    # Warm up so the first job does not pay for sympy's lazy imports.
    ops.compute({"operation": "evaluate", "input": {"text": "integrate(x,x)"}}) if False else ops.compute({"operation": "simplify", "input": {"text": "sin(x)^2+cos(x)^2"}})
    print("estampes-cas listening on", SOCKET, "sympy", ops.VERSION, flush=True)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await stop.wait()
    server.close()


def run():
    asyncio.run(main())


if __name__ == "__main__":
    run()
