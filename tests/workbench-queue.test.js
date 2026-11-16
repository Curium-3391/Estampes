// The workbench serialises layout and panel changes. A revision conflict is
// retried once; that retry must not be queued behind the job that waits for
// it, or the queue deadlocks and every later move/resize is stuck
// (architecture review A09). Runs the real wbApply from public/workbench.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/workbench.js", import.meta.url), "utf8");
const start = source.indexOf("function wbApply(");
const end = source.indexOf("\n}\n", start) + 2;
const wbApplySource = source.slice(start, end);

function harness(responses) {
  const calls = [];
  const ctx = {
    wb: { chain: Promise.resolve(), surface: { revision: 1 } },
    status: { textContent: "" },
    uuid: () => "k" + calls.length,
    wbArgs: () => ({ imageId: "img:0000000000000000" }),
    wbLoad: async () => { ctx.wb.surface.revision++; },
    setSurface: (r) => { ctx.wb.surface.revision = r.revision; },
    wbCall: async (name, args) => {
      calls.push(args);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(wbApplySource + ";this.wbApply=wbApply;", ctx);
  return { ctx, calls };
}
const settled = (p, ms = 500) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

test("a revision conflict is retried once and the queue keeps working", async () => {
  const conflict = new Error("the surface changed since revision 1");
  const { ctx, calls } = harness([conflict, { revision: 3 }, { revision: 4 }]);
  const first = ctx.wbApply([{ op: "layout" }]);
  assert.equal(await settled(first), true, "the conflicted change finishes");
  assert.equal(calls.length, 2, "one retry");
  const second = ctx.wbApply([{ op: "layout" }]);
  assert.equal(await settled(second), true, "the next change runs after it");
  assert.equal(calls.length, 3);
  assert.equal(ctx.wb.surface.revision, 4);
});

test("a second conflict is reported, not retried forever, and the queue still moves", async () => {
  const conflict = () => new Error("the surface changed since revision 1");
  const { ctx, calls } = harness([conflict(), conflict(), { revision: 9 }]);
  assert.equal(await settled(ctx.wbApply([{ op: "layout" }])), true);
  assert.match(ctx.status.textContent, /沒有套用/);
  assert.equal(calls.length, 2);
  assert.equal(await settled(ctx.wbApply([{ op: "layout" }])), true);
  assert.equal(calls.length, 3);
});
