import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOL_ANNOTATIONS, annotationsFor } from "../src/tool-annotations.js";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test("every registered tool carries all four MCP annotations, as decided in src/tool-annotations.js", { timeout: 40000 }, async () => {
  const port = await freePort(), base = "http://127.0.0.1:" + port, dir = mkdtempSync(join(tmpdir(), "estampes-ann-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  const client = new Client({ name: "annotations-test", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    let up = false;
    for (let i = 0; i < 100 && child.exitCode === null; i++) { try { if ((await fetch(base + "/")).ok) { up = true; break; } } catch {} await sleep(100); }
    assert.ok(up, "server did not start: " + out);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 60, "expected the full tool list, got " + tools.length);
    for (const t of tools) {
      for (const h of HINTS) assert.equal(typeof t.annotations?.[h], "boolean", t.name + " is missing " + h);
      assert.deepEqual(
        Object.fromEntries(HINTS.map((h) => [h, t.annotations[h]])), annotationsFor(t.name), t.name + " differs from src/tool-annotations.js");
    }
  } finally {
    try { await client.close(); } catch {}
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the annotation table is internally consistent", () => {
  for (const [name, row] of Object.entries(TOOL_ANNOTATIONS)) {
    for (const h of HINTS) assert.equal(typeof row[h], "boolean", name + "." + h);
    assert.ok(typeof row.reason === "string" && row.reason.length > 8, name + " needs a reason");
    if (row.readOnlyHint) {
      assert.equal(row.destructiveHint, false, name + ": a read-only tool cannot be destructive");
      assert.equal(row.idempotentHint, true, name + ": a read-only tool is idempotent");
    }
  }
  assert.throws(() => annotationsFor("not_a_tool"), /no row/);
});

test("tools that write, delete or fetch keep the hints their handlers need", () => {
  // Guards the decisions most likely to be flipped to read-only by mistake.
  for (const name of ["validate_visual_annotations", "load_image", "render_pdf_page", "edit_visual_canvas"]) {
    assert.equal(TOOL_ANNOTATIONS[name].readOnlyHint, false, name + " saves state");
  }
  for (const name of ["edit_visual_canvas", "undo_workspace_change", "update_derived", "store_commit_plan", "execute_module"]) {
    assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, true, name + " can remove or overwrite data");
  }
  for (const name of ["present_visual", "load_image", "render_pdf_page", "create_workspace", "import_workspace_bundle", "execute_module"]) {
    assert.equal(TOOL_ANNOTATIONS[name].openWorldHint, true, name + " can reach outside the server");
  }
});
