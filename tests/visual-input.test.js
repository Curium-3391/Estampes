import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  createVisualEvidence, calculateCrop, extractDemoScenes,
  SOURCE_WIDTH, SOURCE_HEIGHT, IMAGE_REVISION
} from "../src/visual-input.js";
import { readFileSync } from "node:fs";

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const isPNG=(buf)=>Buffer.isBuffer(buf)&&buf.subarray(0,8).equals(PNG_SIGNATURE);

test("M0.4.3 uses the exact widget's scene artwork, not a separate semantic object catalog",()=>{
  const html=readFileSync(new URL("../public/visual-surface.html",import.meta.url),"utf8");
  const scenes=extractDemoScenes(html);
  assert.deepEqual(Object.keys(scenes),["landscape","shapes","formula"]);
  assert.match(scenes.landscape,/<circle cx="508" cy="73"/);
  assert.match(scenes.landscape,/<rect x="89" y="229"/);
  assert.match(scenes.shapes,/<circle cx="157" cy="154"/);
  assert.match(scenes.formula,/E = mc²/);
});

test("M0.4.3 returns genuine PNG bytes for original, blue-focus view and crop",async()=>{
  const ev=await createVisualEvidence({
    scene:"landscape",imageId:"demo:landscape",revision:IMAGE_REVISION,
    focus:{type:"rect",x:0.1,y:0.42,x2:0.4,y2:0.92}
  });
  assert.equal(ev.source.kind,"svg");
  assert.equal(ev.source.logicalSize.unit,"svg-user-unit");
  assert.deepEqual([ev.rendered.width,ev.rendered.height],[SOURCE_WIDTH,SOURCE_HEIGHT]);
  assert.equal(ev.coordinateSystem,"normalized-top-left");
  for(const bytes of Object.values(ev.images)) {
    assert.ok(isPNG(bytes),"each block must be a real PNG");
    assert.ok(bytes.length>100,"must not be placeholder");
    assert.equal((await sharp(bytes).metadata()).format,"png");
  }
  assert.notDeepEqual(ev.images.original,ev.images.marked,
    "overlay preview must visually differ from unmodified original");
  assert.equal((await sharp(ev.images.crop).metadata()).width,ev.crop.width*2);
  assert.ok(ev.crop.width>=190&&ev.crop.width<=310);
  // Pixel differences: sun center should not equal nearby sky; image has content.
  const raw=await sharp(ev.images.original).raw().toBuffer({resolveWithObject:true});
  const pix=(x,y)=>{
    const p=(y*raw.info.width+x)*raw.info.channels;
    return [...raw.data.subarray(p,p+3)];
  };
  assert.notDeepEqual(pix(508,73),pix(30,30));
});

test("Arrow crop is around the arrowhead, NOT the tail",()=>{
  const crop=calculateCrop({type:"arrow",x:0.1,y:0.2,x2:0.85,y2:0.7});
  assert.ok(crop.left>350,"arrowhead should be on the right");
  assert.ok(crop.top>150,"arrowhead should be below center");
});

test("Reversed rectangle coordinates and near-edge point are handled",()=>{
  const r=calculateCrop({type:"rect",x:.8,y:.8,x2:.2,y2:.2});
  assert.ok(r.width>200&&r.height>180);
  const p=calculateCrop({type:"point",x:1,y:0});
  assert.equal(p.left+p.width,SOURCE_WIDTH);
  assert.equal(p.top,0);
  assert.ok(p.width>0&&p.height>0);
});

test("Reject arbitrary URLs, unknown image IDs, wrong revisions or invalid geometry",async()=>{
  const call=(opts)=>createVisualEvidence({
    scene:"landscape",imageId:"demo:landscape",revision:"svg-v1",
    focus:{type:"point",x:.5,y:.5},...opts
  });
  await assert.rejects(call({imageId:"https://example.com/photo.jpg"}),/identity/);
  await assert.rejects(call({imageId:"demo:shapes"}),/identity/);
  await assert.rejects(call({revision:"svg-v2"}),/identity/);
  await assert.rejects(call({focus:{type:"point",x:1.01,y:0.5}}),/0..1/);
  await assert.rejects(call({focus:{type:"arrow",x:.1,y:.2,x2:.8}}),/x2\/y2/);
});
