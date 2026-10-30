import asyncio, json, os, struct, tempfile, unittest, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Conn:
    def __init__(self, r, w): self.r, self.w = r, w
    async def call(self, method, params=None, rid="1"):
        body = json.dumps({"v": 1, "id": rid, "method": method, "params": params or {}}).encode()
        self.w.write(struct.pack(">I", len(body)) + body); await self.w.drain()
        n = struct.unpack(">I", await self.r.readexactly(4))[0]
        return json.loads(await self.r.readexactly(n))


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.mkdtemp()
        self.sock = os.path.join(self.dir, "cas.sock")
        env = dict(os.environ, ESTAMPES_CAS_SOCKET=self.sock, ESTAMPES_CAS_TIMEOUT_MS="1000", ESTAMPES_CAS_QUEUE="1", ESTAMPES_CAS_WORKERS="2", PYTHONPATH=ROOT)
        self.proc = subprocess.Popen([sys.executable, "-m", "estampes_cas"], env=env, stdout=subprocess.PIPE)
        for _ in range(100):
            if os.path.exists(self.sock): break
            await asyncio.sleep(0.1)
        self.r, self.w = await asyncio.open_unix_connection(self.sock)
        self.c = Conn(self.r, self.w)

    async def asyncTearDown(self):
        self.w.close(); self.proc.terminate(); self.proc.wait(5)

    async def test_health_and_compute(self):
        h = await self.c.call("health")
        self.assertEqual(h["result"]["engine"]["name"], "SymPy")
        r = await self.c.call("compute", {"operation": "differentiate", "input": {"text": "sin(x^2)"}, "params": {"variable": "x"}})
        self.assertEqual(r["result"]["exact"]["plain"], "2*x*cos(x^2)")
        self.assertEqual(oct(os.stat(self.sock).st_mode & 0o777), "0o600")

    async def test_timeout_kills_and_server_survives(self):
        t0 = time.time()
        r = await self.c.call("compute", {"operation": "integrate", "input": {"text": "exp(-x^2)*ln(x)"}})
        self.assertFalse(r["ok"])
        self.assertIn(r["error"]["code"], ("timeout", "resource_limit"))
        self.assertLess(time.time() - t0, 6)
        again = await self.c.call("compute", {"operation": "evaluate", "input": {"text": "1+1"}})
        self.assertEqual(again["result"]["exact"]["plain"], "2")

    async def test_cancel_kills_job(self):
        body = {"operation": "integrate", "input": {"text": "exp(-x^2)*ln(x)"}}
        task = asyncio.create_task(self.c.call("compute", body, rid="slow"))
        await asyncio.sleep(0.4)
        c2 = Conn(*await asyncio.open_unix_connection(self.sock))
        cancel = await c2.call("cancel", {"target": "slow"}, rid="c")
        r = await task
        self.assertTrue(cancel["result"]["cancelled"])
        self.assertEqual(r["error"]["code"], "cancelled")

    async def test_bad_frames(self):
        self.w.write(struct.pack(">I", 10 ** 9)); await self.w.drain()
        self.assertEqual(await self.r.read(10), b"")
        r, w = await asyncio.open_unix_connection(self.sock)
        c = Conn(r, w)
        out = await c.call("nope")
        self.assertEqual(out["error"]["code"], "unsupported")
        w.close()

    async def test_injection_not_executed(self):
        marker = os.path.join(self.dir, "pwned")
        for src in ["__import__('os').system('touch %s')" % marker, "().__class__.__bases__", "open('/etc/passwd')", "exec('1')"]:
            r = await self.c.call("compute", {"operation": "evaluate", "input": {"text": src}})
            self.assertFalse(r["ok"], src)
        self.assertFalse(os.path.exists(marker))


if __name__ == "__main__":
    unittest.main()
