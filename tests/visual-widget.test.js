import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html=readFileSync(new URL("../public/visual-surface.html",import.meta.url),"utf8");
const js=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

test("M0.4 embedded canvas JavaScript parses",()=>{
  assert.ok(js,"inline module missing");
  assert.doesNotThrow(()=>new Script(js));
});

test("M0.4 separates media, AI overlays and human overlays",()=>{
  assert.match(html,/id="scene"/);
  assert.match(html,/id="assistant-annotations"/);
  assert.match(html,/id="user-annotations"/);
  assert.match(html,/priorUserMarks/);
  assert.match(html,/a\.author==="user"/);
  assert.match(html,/author:"user",grounding:"user-pointer"/);
  assert.match(html,/id="preview"/);
  assert.match(html,/viewBox="0 0 640 360"/);
  assert.match(html,/matrixTransform\(matrix.inverse\(\)\)/);
  assert.match(html,/v0\.4\.3/);
});

test("M0.4 tools and message bridge are both present",()=>{
  assert.match(html,/name:"validate_visual_annotations"/);
  assert.match(html,/request\("tools\/call"/);
  assert.match(html,/request\("ui\/message"/);
  assert.match(html,/ui\/notifications\/tool-input/);
  assert.match(html,/ui\/notifications\/tool-result/);
  assert.match(html,/data-mode="point"/);
  assert.match(html,/data-mode="rect"/);
  assert.match(html,/data-mode="arrow"/);
  assert.match(html,/id="intent"/);
  assert.match(html,/id="note"/);
  assert.match(html,/id="quote"/);
  assert.match(html,/name:"validate_visual_annotations"/);
  assert.match(html,/intent,note,replyQuote/);
  assert.match(html,/r\?\.event\?\.schemaVersion!=="0\.2-draft"/);
  assert.match(html,/!intentSelect\.value/);
  assert.match(html,/沒有前文的精確引述/);
  assert.match(html,/箭頭尖端/);
});

test("M0.4 uses fixed local scenes; no arbitrary image URL fetch",()=>{
  assert.match(js,/landscape:/);
  assert.match(js,/shapes:/);
  assert.match(js,/formula:/);
  assert.doesNotMatch(js,/fetch\(/);
});
