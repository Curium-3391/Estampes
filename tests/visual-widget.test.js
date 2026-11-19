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
  assert.match(html,/id="stored-annotations"/);
  assert.match(html,/id="fresh-annotations"/);
  // Stored marks keep their author colour inside each layer group.
  assert.match(html,/renderMarks\(g,items\.filter\(m=>m\.author!=="user"\),"#E4AE57","AI"/);
  assert.match(html,/priorUserMarks/);
  assert.match(html,/a\.author==="user"/);
  assert.match(html,/author:"user",grounding:"user-pointer"/);
  assert.match(html,/id="preview"/);
  assert.match(html,/viewBox="0 0 640 360"/);
  assert.match(html,/matrixTransform\(matrix.inverse\(\)\)/);
  assert.match(html,/v__ESTAMPES_VERSION__/); // filled from package.json at serve time
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
  assert.match(html,/id="context-details"/);
  assert.match(html,/data-view="annotated"/);
  assert.match(html,/data-view="original"/);
  assert.match(html,/data-view="zoom"/);
  assert.match(html,/focusChoice/);
  assert.match(js,/function cropBox\(mark\)/);
  assert.match(js,/svg.setAttribute\("viewBox"/);
  assert.match(js,/storedEl.style.display=hideMarks/);
  assert.match(js,/freshEl.style.display=hideMarks/);
  assert.match(html,/name:"validate_visual_annotations"/);
  assert.match(html,/intent,note,replyQuote/);
  assert.match(html,/r\?\.event\?\.schemaVersion!=="0\.2-draft"/);
  // Intent is optional, so the user can point first without filling a form.
  assert.match(html,/const intent=intentSelect.value\|\|"free-annotate"/);
  assert.doesNotMatch(html,/!intentSelect\.value/);
  // The fallback message posted when validation fails (src/surface/user-voice.js).
  assert.match(html,/chatMessage=joinUserVoice\(fallbackParts\(/);
});

test("M0.4 uses fixed local scenes; no arbitrary image URL fetch",()=>{
  assert.match(js,/landscape:/);
  assert.match(js,/shapes:/);
  assert.match(js,/formula:/);
  assert.doesNotMatch(js,/fetch\(/);
});
