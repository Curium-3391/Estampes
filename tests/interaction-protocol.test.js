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
  assert.match(message,/箭頭尖端/);
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
  assert.equal(INTENTS.length,6);
  assert.deepEqual(Object.keys(SCENE_META),["landscape","shapes","formula"]);
  for(const intent of INTENTS) {
    const event=buildAnnotationEvent({scene:"landscape",annotations:[arrow],
      intent,note:"N".repeat(600),replyQuote:"Q".repeat(400)});
    assert.equal(event.interaction.intent,intent);
    assert.equal(event.interaction.userNote.length,500);
    assert.equal(event.interaction.replyTo.quote.length,300);
  }
});
