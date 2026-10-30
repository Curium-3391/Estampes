import test from "node:test";
import assert from "node:assert/strict";
import { readQuickTunnel, watchQuickTunnel } from "../src/tunnel.js";

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

test("the quick tunnel address is read from cloudflared's metrics and checked", async () => {
  assert.equal(await readQuickTunnel("http://tunnel:20241/", reply({ hostname: "Calm-Words-Here.trycloudflare.com" })), "https://calm-words-here.trycloudflare.com");
  assert.equal(await readQuickTunnel("http://tunnel:20241", reply({ hostname: "" })), null);
  assert.equal(await readQuickTunnel("http://tunnel:20241", reply({ hostname: "evil.com/path?x" })), null);
  assert.equal(await readQuickTunnel("http://tunnel:20241", reply({}, false)), null);
  let asked = "";
  await readQuickTunnel("http://tunnel:20241/", async (url) => { asked = url; return { ok: false }; });
  assert.equal(asked, "http://tunnel:20241/quicktunnel");
});

test("the watcher reports the address once and survives a missing tunnel", async () => {
  const seen = [];
  let calls = 0;
  const stop = watchQuickTunnel("http://tunnel:20241", (u) => seen.push(u), {
    fetchImpl: async () => { if (++calls < 2) throw new Error("ENOTFOUND"); return { ok: true, json: async () => ({ hostname: "a-b.trycloudflare.com" }) }; },
  });
  await new Promise((r) => setTimeout(r, 3300));
  stop();
  assert.deepEqual(seen, ["https://a-b.trycloudflare.com"]);
});
