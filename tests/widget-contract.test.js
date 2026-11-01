import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html=readFileSync(new URL("../public/number-line.html",import.meta.url),"utf8");

test("M0.3 widget JavaScript parses",()=>{
  const match=html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match,"widget module script missing");
  assert.doesNotThrow(()=>new Script(match[1]));
});

test("M0.3 widget has separate validation and chat paths",()=>{
  assert.match(html,/record_number_line_selection/);
  assert.match(html,/request\("tools\/call"/);
  assert.match(html,/request\("ui\/message"/);
  assert.match(html,/工具驗證失敗，改嘗試直接傳給 AI/);
  assert.match(html,/v0\.3\.1/);
});
