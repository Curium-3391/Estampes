import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";

const html=readFileSync(new URL("../public/visual-surface.html",import.meta.url),"utf8");
const source=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
const index=source.indexOf("function cropBox(mark){");
const end=source.indexOf("\nfunction renderView()",index);
assert.ok(index>=0 && end>index);
// Canvas size is a parameter: 640×360 demo scenes, 1000×(aspect) photos.
const makeCropBox=(VW,VH)=>new Function("VW","VH",
  "const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));const K=()=>VW/640;\n"+
    source.slice(index,end)+"\nreturn cropBox;"
)(VW,VH);
const cropBox=makeCropBox(640,360);

function assertWithinSource(mark){
  const a=cropBox(mark).split(" ").map(Number);
  assert.equal(a.length,4);
  assert.ok(a.every(Number.isFinite));
  const [x,y,width,height]=a;
  assert.ok(x>=0 && y>=0);
  assert.ok(width>0 && height>0);
  assert.ok(x+width<=640.00001 && y+height<=360.00001);
  assert.ok(Math.abs(width/height-640/360)<1e-8);
  return a;
}

test("unified canvas contains all views without a second tool call",()=>{
  assert.doesNotThrow(()=>new Script(source));
  for(const mode of ["annotated","original","zoom"]){
    assert.match(html,new RegExp('data-view="'+mode+'"'));
  }
  assert.match(source,/aiEl\.style\.display=hideMarks/);
  assert.match(source,/userEl\.style\.display=hideMarks/);
  assert.match(source,/hit\.style\.pointerEvents=hideMarks/);
  assert.doesNotMatch(source,/name:"present_visual_evidence"/);
});

test("context is optional; drawing and submission require no menu completion",()=>{
  assert.match(html,/<details id="context-details">/);
  assert.match(source,/const intent=intentSelect\.value\|\|"point-out"/);
  assert.match(source,/send\.disabled=!ready\|\|fresh===0/);
  assert.doesNotMatch(source,/!intentSelect\.value/);
});

test("crop stays inside the source and preserves original aspect",()=>{
  const a=assertWithinSource({type:"point",x:.25,y:265/360});
  assert.ok(a[0]<=160 && a[0]+a[2]>=160);
  assert.ok(a[1]<=265 && a[1]+a[3]>=265);
  assertWithinSource({type:"point",x:0,y:1});
  assertWithinSource({type:"point",x:1,y:0});
  assertWithinSource({type:"rect",x:.8,y:.8,x2:.2,y2:.2});
});

test("arrows zoom around the arrowhead, not the tail",()=>{
  const [x,y,width,height]=assertWithinSource(
    {type:"arrow",x:.1,y:.1,x2:.9,y2:.8}
  );
  assert.ok(x>350 && y>150);
  assert.ok(x+width>=.9*640 && y+height>=.8*360);
});

test("photo canvases crop in their own aspect ratio",()=>{
  const portrait=makeCropBox(1000,1333);
  for(const mark of [{type:"point",x:.5,y:.6},{type:"point",x:1,y:1},{type:"rect",x:.4,y:.5,x2:.6,y2:.71}]){
    const [x,y,w,h]=portrait(mark).split(" ").map(Number);
    assert.ok(x>=0&&y>=0&&x+w<=1000.0001&&y+h<=1333.0001);
    assert.ok(Math.abs(w/h-1000/1333)<1e-8);
  }
});

test("real photos render from widget-only _meta and processed views get their own tabs",()=>{
  assert.match(source,/meta\["estampes\/image"\]/);
  assert.match(source,/meta\["estampes\/views"\]/);
  assert.match(source,/toolResponseMetadata/);
  assert.match(source,/imageId\?\{imageId\}:\{scene:selectedScene\}/);
  assert.match(source,/viewMode="annotated"/);
});

test("re-delivered host data does not reset the chosen tab or unsent marks",()=>{
  // ChatGPT fires openai:set_globals on every resize; v0.5.1 snapped back
  // to the first tab after each click.
  assert.match(source,/if\(key===appliedKey\)return;/);
  assert.match(source,/o\.toolOutput===seenOutput/);
});

test("only new marks are focus; sent marks become context and fade",()=>{
  assert.match(source,/role:sentIds\.has\(id\)\?"context":"focus"/);
  assert.match(source,/for\(const id of freshIds\)sentIds\.add\(id\)/);
  assert.match(source,/userEl\.style\.opacity="\.55"/);
});

test("GPT notes and status appear beside their marks",()=>{
  assert.match(html,/<ol id="findings"/);
  assert.match(source,/STATUS_TEXT\[m\.status\]/);
  assert.match(source,/a\.status==="inspected"\?"✓ "/);
});

test("new user marks continue numbering after re-presented ones",()=>{
  assert.match(source,/function nextLabel\(\)/);
  assert.match(source,/\[\.\.\.priorUserMarks,\.\.\.userMarks\]/);
  assert.match(source,/id:ID_PREFIX\+\(\+\+seq\)/);
});

test("users pick colour, size and a translucent highlighter",()=>{
  for(const c of ["blue","red","green","yellow","magenta","cyan","white","black"])assert.match(html,new RegExp('data-color="'+c+'"'));
  assert.match(html,/data-pen="highlighter"/);
  assert.match(source,/op=hl\?\.38:1/);
  assert.match(source,/\.\.\.styleFields\(\)/);
});

test("undo and redo step through marks, including a clear",()=>{
  const start=source.indexOf("let past=[],future=[];"),stop=source.indexOf("undoBtn.addEventListener",start);
  assert.ok(start>=0&&stop>start);
  const h=new Function("let userMarks=[],selectedFocusId=null;const render=()=>{};\n"+source.slice(start,stop)+
    "\nreturn {commitMarks,undo,redo,get marks(){return userMarks}};")();
  h.commitMarks([...h.marks,"a"]);h.commitMarks([...h.marks,"b"]);h.commitMarks([]);
  assert.deepEqual(h.marks,[]);
  h.undo();assert.deepEqual(h.marks,["a","b"]);
  h.undo();assert.deepEqual(h.marks,["a"]);
  h.redo();assert.deepEqual(h.marks,["a","b"]);
  h.commitMarks([...h.marks,"c"]);h.redo();assert.deepEqual(h.marks,["a","b","c"]);
  assert.match(html,/id="redo"/);
  assert.match(source,/k==="z"/);
});

test("a late tool input never replaces the applied result",()=>{
  // 0.5.5 live trial: ChatGPT delivered tool-input after the result (and
  // again after a chat message), squashing the photo to 1000x750 and
  // dropping GPT's marks until the next resize.
  assert.match(source,/tool-input"&&!gotResult\)applyInput/);
  assert.match(source,/o\?\.toolInput&&!gotResult/);
  assert.match(source,/else if\(!sameImage\)VH=750/);
  assert.match(source,/if\(!ready\)\{pendingSync=pendingSync\|\|force;return;\}/);
});

test("missing pixels are reloaded and the verification image has its own tab",()=>{
  assert.match(source,/name:"load_visual_canvas",arguments:\{imageId:id\}/);
  assert.match(source,/if\(!photo\|\|\(!full&&!r\.annotations\)\)syncCanvas\(!!photo\)/);
  // Full geometry comes from widget-only _meta; the model gets a compact list.
  assert.match(source,/meta\["estampes\/annotations"\]/);
  assert.doesNotMatch(html,/id="pip"/);
  assert.match(source,/"touchmove"\][\s\S]{0,200}passive:false/);
  assert.match(source,/requestDisplayMode\(\{mode\}\)/);
  assert.match(html,/id="export-marks"/);
  assert.match(html,/data-size="fine"/);
  assert.match(html,/data-view="check"[^>]*hidden/);
  assert.match(source,/part:"check"/);
});

test("provenance colors are distinct from viewer inspection marker",()=>{
  assert.match(source,/#E4AE57/);
  assert.match(source,/#579DF6/);
  assert.doesNotMatch(source,/source\.images/);
});

test("zoom keeps the point under the pointer and clamps to the photo",()=>{
  const start=source.indexOf("function setCam(next){"),stop=source.indexOf("const camCentre",start);
  assert.ok(start>=0&&stop>start);
  const z=new Function("let cam=null;const VW=1000,VH=1333,MAX_ZOOM=24;const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));"+
    "const applyViewBox=()=>{},scheduleRender=()=>{},scheduleDetail=()=>{};const svg={getScreenCTM:()=>({a:1})};\n"+
    source.slice(start,stop)+"\nreturn {zoomAt,panBy,setCam,get cam(){return cam}};")();
  z.zoomAt(4,{x:500,y:600});
  assert.equal(z.cam.w,250);
  // The anchor keeps its relative position inside the view.
  assert.ok(Math.abs((500-z.cam.x)/z.cam.w-0.5)<1e-9);
  z.panBy(-10000,-10000);
  assert.equal(z.cam.x,750);assert.ok(Math.abs(z.cam.y+z.cam.h-1333)<1e-9);
  z.zoomAt(1000,{x:900,y:1300});assert.ok(Math.abs(z.cam.w-1000/24)<1e-9);
  z.zoomAt(0.001,{x:0,y:0});assert.equal(z.cam,null);
});

test("pinch, wheel and pan never draw; labels and drawing tolerances follow the zoom",()=>{
  assert.match(source,/if\(pointers\.size>=2\)\{cancelStroke\(\)/);
  assert.match(source,/svg\.addEventListener\("wheel"[\s\S]*passive:false/);
  assert.match(source,/gesturechange/);
  assert.match(source,/lk=U\(\)/);
  assert.match(source,/1\.5\*U\(\)/);
  assert.match(source,/name:"load_visual_region"/);
  assert.match(html,/data-mode="pan"/);
});
