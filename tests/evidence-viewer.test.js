import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";

const html=readFileSync(new URL("../public/visual-evidence.html",import.meta.url),"utf8");
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

test("evidence viewer inline UI is parsable and protocol-ready",()=>{
 assert.ok(script);
 assert.doesNotThrow(()=>new Script(script));
 assert.match(html,/v0\.4\.7/);
 assert.match(script,/ui\/initialize/);
 assert.match(script,/ui\/notifications\/tool-result/);
 assert.match(script,/ui\/notifications\/tool-input/);
});

test("evidence viewer actually renders the 3 PNG blocks for user",()=>{
 assert.match(html,/id="image"/);
 assert.match(html,/data-view="marked"/);
 assert.match(html,/data-view="original"/);
 assert.match(html,/data-view="crop"/);
 assert.match(script,/data:image\/png;base64,/);
 assert.match(script,/estampes\.visual_evidence_view/);
 assert.match(script,/resultImage\.src=sources\[name\]/);
 assert.match(script,/name:"present_visual_evidence"/);
});

test("preview requires real png blocks and never claims to classify the subject",()=>{
 assert.match(script,/estampes\.visual_evidence_view/);
 assert.match(html,/原始完整圖片/);
 assert.match(html,/中性焦點全圖/);
 assert.match(html,/局部放大/);
 assert.doesNotMatch(script,/tree|house|mountain-right/);
});
