import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { t } from "../src/i18n/index.js";

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
  assert.match(html,/t\("nl\.sendingUnverified"\)/);
  assert.equal(t("nl.sendingUnverified"),"工具驗證失敗，改嘗試直接傳給 AI…");
  assert.equal(t("nl.bridgeFailedUnverified",{error:"E",message:"M",value:-3,x:0.125}),
    "工具驗證失敗：E；聊天橋接失敗：M。可手動輸入：我在 Estampes 指向 -3 (x=0.125)。");
  assert.match(html,/v0\.3\.1/);
});
