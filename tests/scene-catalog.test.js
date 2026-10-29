import test from "node:test";
import assert from "node:assert/strict";
import { sceneLandmarks, landmarkIds, resolveSceneAnnotation, replayUserAnnotation } from "../src/scene-catalog.js";

test("mountain-right resolves away from tree even when model guesses tree coordinates",()=>{
  const a=resolveSceneAnnotation("landscape",{
    id:"ai-mountain",type:"point",targetId:"mountain-right",
    x:0.82,y:0.49,label:"山",
  });
  assert.equal(a.x,360/640);
  assert.equal(a.y,130/360);
  assert.equal(a.author,"assistant");
  assert.equal(a.grounding,"scene-anchor");
  assert.ok(a.x < sceneLandmarks.landscape.tree.box.x,
    "mountain anchor must be left of foreground tree bbox");
});

test("sun landmark matches source SVG geometry",()=>{
  const a=resolveSceneAnnotation("landscape",{id:"s",type:"point",targetId:"sun"});
  assert.equal(a.x,508/640);
  assert.equal(a.y,73/360);
});
test("semantic target must exist in selected scene",()=>{
  assert.throws(()=>resolveSceneAnnotation("formula",{id:"a",type:"point",targetId:"tree"}));
  assert.throws(()=>resolveSceneAnnotation("shapes",{id:"a",type:"arrow",targetId:"circle"}));
});
test("free coordinates are retained but never called semantically grounded",()=>{
  const a=resolveSceneAnnotation("landscape",{id:"free",type:"point",x:0.82,y:0.49,label:"mountain"});
  assert.equal(a.x,0.82);
  assert.equal(a.grounding,"unverified");
  assert.equal(a.author,"assistant");
});
test("replayed human annotations preserve user author, but provenance is unverified",()=>{
  const a=replayUserAnnotation({id:"user-1",type:"rect",x:0.1,y:0.1,x2:0.6,y2:0.8});
  assert.equal(a.author,"user");
  assert.equal(a.grounding,"replayed-unverified");
  assert.equal(a.id,"user-1");
});
test("all built-in scene anchors use normalized bounded coordinates",()=>{
  assert.ok(landmarkIds.includes("mountain-right"));
  for(const [scene,anchors] of Object.entries(sceneLandmarks)){
    for(const [name,shape] of Object.entries(anchors)){
      for(const o of [shape.point,shape.box]){
        for(const value of Object.values(o)) assert.ok(value>=0 && value<=1, scene+" "+name);
      }
      assert.ok(shape.box.x<=shape.point.x && shape.point.x<=shape.box.x2,scene+" "+name);
      assert.ok(shape.box.y<=shape.point.y && shape.point.y<=shape.box.y2,scene+" "+name);
    }
  }
});
