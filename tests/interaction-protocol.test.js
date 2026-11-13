import test from "node:test";
import assert from "node:assert/strict";
import {PROTOCOL_VERSION,INTENTS,SCENE_META,buildAnnotationEvent,formatAnnotationChatMessage} from "../src/interaction-protocol.js";

const arrow={id:"user-5",type:"arrow",x:0.2045,y:0.5795,x2:0.7577,y2:0.5147,label:"YOU 1"};

test("v0.2 uses explicit SVG dimensions, not imaginary DPI or raster pixels",()=>{
  const event=buildAnnotationEvent({scene:"landscape",annotations:[arrow],intent:"point-out"});
  assert.equal(event.schemaVersion,PROTOCOL_VERSION);
  assert.equal(event.image.id,"demo:landscape");
  assert.equal(event.image.revision,"svg-v1");
  assert.deepEqual(event.image.intrinsicSize,{width:640,height:360,unit:"svg-user-unit"});
  assert.equal(event.image.rasterPixelSize,null);
  assert.equal(event.image.pixelDensityDpi,null);
  assert.deepEqual(event.image.coordinateSystem.range,[0,1]);
  assert.equal(event.annotations[0].geometry.x2,0.7577);
  assert.equal(event.annotations[0].arrowhead,"end");
  assert.equal(event.annotations[0].author,"user");
  assert.equal(event.annotations[0].grounding,"user-pointer");
});

test("v0.2 carries explicit user intent and optional quote without making up a messageId",()=>{
  const event=buildAnnotationEvent({scene:"landscape",annotations:[arrow],
    intent:"correct-assistant",note:"我指的是樹，不是山。",replyQuote:"你說這是山。"});
  assert.equal(event.interaction.intent,"correct-assistant");
  assert.equal(event.interaction.requestedAssistantAction,"reconsider-prior-identification");
  assert.equal(event.interaction.userNote,"我指的是樹，不是山。");
  assert.equal(event.interaction.replyTo.quote,"你說這是山。");
  assert.equal(event.interaction.replyTo.provenance,"user-entered");
  assert.equal(event.interaction.replyTo.messageId,null);
  const message=formatAnnotationChatMessage(event);
  assert.match(message,/我要更正你先前的指認/);
  assert.match(message,/使用者親自輸入/);
  assert.match(message,/semanticHint=unspecified/);
  assert.match(message,/svg-user-unit/);
  assert.match(message,/"schemaVersion":"0.2-draft"/);
});

test("without explicit context the message refuses to invent a prior question",()=>{
  const event=buildAnnotationEvent({scene:"shapes",
    annotations:[{id:"a",type:"point",x:0,y:1}],intent:"answer-question"});
  assert.equal(event.interaction.replyTo.quote,null);
  assert.equal(event.interaction.replyTo.provenance,"unavailable");
  assert.equal(event.interaction.userNote,null);
  assert.match(formatAnnotationChatMessage(event),/不要捏造上一輪問題/);
});

test("invalid coordinates, unknown intent or duplicate IDs are rejected",()=>{
  assert.throws(()=>buildAnnotationEvent({scene:"landscape",annotations:[arrow],intent:"trust-me"}));
  assert.throws(()=>buildAnnotationEvent({scene:"landscape",annotations:[arrow,arrow],intent:"point-out"}),/duplicate/);
  assert.throws(()=>buildAnnotationEvent({scene:"landscape",
    annotations:[{id:"p",type:"point",x:1.0001,y:0.2}]}));
  assert.throws(()=>buildAnnotationEvent({scene:"landscape",
    annotations:[{id:"a",type:"arrow",x:0.1,y:0.2,x2:0.3}]}));
  assert.throws(()=>buildAnnotationEvent({scene:"landscape",annotations:[]}));
});

test("all intents supported and text limits enforced",()=>{
  assert.equal(INTENTS.length,7);
  assert.deepEqual(Object.keys(SCENE_META),["landscape","shapes","formula"]);
  for(const intent of INTENTS) {
    const event=buildAnnotationEvent({scene:"landscape",annotations:[arrow],
      intent,note:"N".repeat(600),replyQuote:"Q".repeat(400)});
    assert.equal(event.interaction.intent,intent);
    assert.equal(event.interaction.userNote.length,500);
    assert.equal(event.interaction.replyTo.quote.length,300);
  }
});

// EST-SEM-01: an arrow's type is geometry; only point-out makes the head the referent.
const leftArrow={id:"user-1v5g-1",type:"arrow",x:0.50371,y:0.28759,x2:0.38220,y2:0.28804,label:"YOU 1"};
const photo={imageId:"img-test",width:1536,height:432};

test("free annotation is the default and leaves arrow meaning unspecified",()=>{
  const event=buildAnnotationEvent({image:photo,annotations:[leftArrow],note:"我覺得電流是往這個方向走的"});
  assert.equal(INTENTS[0],"free-annotate");
  assert.equal(event.interaction.intent,"free-annotate");
  assert.equal(event.interaction.requestedAssistantAction,"interpret-annotation");
  assert.equal(event.interaction.arrowMeaning,"unspecified");
  assert.equal(event.interaction.semanticsPolicy,"geometry-is-not-intent");
  const a=event.annotations[0];
  assert.equal(a.semanticHint,"unspecified");
  assert.deepEqual(a.geometry,{x:0.50371,y:0.28759,x2:0.38220,y2:0.28804});
  assert.equal(a.direction.heading,"left");
  assert.equal(a.direction.provenance,"computed-from-geometry");
  const message=formatAnnotationChatMessage(event);
  assert.match(message,/由右往左/);
  assert.match(message,/semanticHint=unspecified/);
  assert.match(message,/方向、流向/);
  assert.doesNotMatch(message,/才是我指的對象/);
  assert.match(message,/我覺得電流是往這個方向走的/);
});

test("only an explicit point-out makes the arrowhead the target, and the note can still override",()=>{
  const event=buildAnnotationEvent({image:photo,annotations:[leftArrow],intent:"point-out",note:"箭頭指到的元件是什麼？"});
  assert.equal(event.interaction.arrowMeaning,"arrowhead-is-target");
  assert.equal(event.annotations[0].semanticHint,"point-to-target");
  const message=formatAnnotationChatMessage(event);
  assert.match(message,/箭頭尖端（x2,y2）是我指的對象/);
  assert.match(message,/以我的文字為準/);
  for(const intent of INTENTS.filter(i=>i!=="point-out")){
    const e=buildAnnotationEvent({image:photo,annotations:[leftArrow],intent});
    assert.equal(e.annotations[0].semanticHint,"unspecified",intent);
  }
});

test("arrow direction uses image pixels, not stretched normalized units",()=>{
  // Equal normalized dx and dy on a wide image is mostly horizontal in pixels.
  const diag={id:"d",type:"arrow",x:0.2,y:0.8,x2:0.4,y2:0.6};
  const event=buildAnnotationEvent({image:photo,annotations:[diag]});
  assert.equal(event.annotations[0].direction.heading,"right");
  const square=buildAnnotationEvent({image:{imageId:"sq",width:500,height:500},annotations:[diag]});
  assert.equal(square.annotations[0].direction.heading,"up-right");
  assert.equal(square.annotations[0].direction.angleDeg,45);
});

test("without a note the message asks for several readings instead of assuming one",()=>{
  const message=formatAnnotationChatMessage(buildAnnotationEvent({image:photo,annotations:[leftArrow]}));
  assert.match(message,/列出可能的解讀/);
  assert.match(message,/只問一次/);
});

test("per-mark notes survive both point and polyline submission events and chat",()=>{
  const note="中文備註\n第二行🙂 <img>";
  const event=buildAnnotationEvent({scene:"landscape",annotations:[
    {id:"note-point",type:"point",x:.2,y:.3,note},
    {id:"note-line",type:"polyline",points:[{x:.1,y:.2},{x:.3,y:.4}],note},
  ]});
  for(const mark of event.annotations){assert.equal(mark.note,note);assert.equal(mark.author,"user");assert.equal(mark.grounding,"user-pointer");}
  const chat=formatAnnotationChatMessage(event);assert.ok(chat.includes(note));assert.ok(chat.includes(JSON.stringify(note)));
});
