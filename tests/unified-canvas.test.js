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
  assert.match(source,/send\.disabled=!ready\|\|userMarks\.length===0/);
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

test("provenance colors are distinct from viewer inspection marker",()=>{
  assert.match(source,/#E4AE57/);
  assert.match(source,/#579DF6/);
  assert.doesNotMatch(source,/source\.images/);
});
