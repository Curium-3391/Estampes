// Image, bundle, PDF and OAuth-client-metadata downloads check the address
// the socket connects to, not only the address seen by an earlier lookup
// (architecture review A07). Before, a hostname could pass the check and
// then resolve to a private address for the real connection (DNS rebinding).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { downloadImage, pinnedFetch, assertPublicHttpsUrl } from "../src/image-store.js";

async function localServer(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
}
let hits = 0;

test("a host that passes the early check but connects to a private address is refused at connection time", async () => {
  hits = 0;
  const srv = await localServer((req, res) => { hits++; res.end("secret"); });
  try {
    // Simulates rebinding: the early check is satisfied, then the name
    // resolves to 127.0.0.1 when the request connects.
    const passEarly = async (u) => new URL(u);
    await assert.rejects(downloadImage("https://localhost:" + srv.port + "/x", { checkUrl: passEarly }), /non-public address/);
    assert.equal(hits, 0, "no request reached the private server");
  } finally { await srv.close(); }
});

test("every redirect hop is checked again at connection time", async () => {
  hits = 0;
  const srv = await localServer((req, res) => { hits++; res.end("secret"); });
  try {
    const first = { status: 302, ok: false, headers: { get: (n) => (n === "location" ? "https://localhost:" + srv.port + "/internal" : null) }, body: null };
    let calls = 0;
    const fetchImpl = (url, init) => (calls++ === 0 ? Promise.resolve(first) : pinnedFetch(url, init));
    await assert.rejects(downloadImage("https://public.example/start", { checkUrl: async (u) => new URL(u), fetchImpl }), /non-public address/);
    assert.equal(hits, 0);
  } finally { await srv.close(); }
});

test("the pinned transport reads bodies, follows redirects and enforces the size limit", async () => {
  const srv = await localServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { location: "/img" }); return res.end(); }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.alloc(4096)); }
    res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("PNGDATA"));
  });
  try {
    // Plain http and a permissive lookup stand in for https to a public host.
    const allowAll = (host, opts, cb) => (opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
    const fetchImpl = (url, init) => pinnedFetch(String(url).replace("https:", "http:"), init, { request: httpRequest, lookup: allowAll });
    const checkUrl = async (u) => new URL(u);
    const base = "https://test.invalid:" + srv.port;
    assert.equal((await downloadImage(base + "/go", { fetchImpl, checkUrl })).toString(), "PNGDATA");
    await assert.rejects(downloadImage(base + "/big", { fetchImpl, checkUrl, maxBytes: 1024 }), /larger than/);
  } finally { await srv.close(); }
});

test("the early check uses the same address policy as module egress", async () => {
  for (const url of ["https://192.0.2.10/a.png", "https://[64:ff9b::7f00:1]/a.png", "https://[::ffff:10.0.0.1]/a.png", "https://100.64.0.1/a.png"]) {
    await assert.rejects(assertPublicHttpsUrl(url), /public/, url);
  }
});
