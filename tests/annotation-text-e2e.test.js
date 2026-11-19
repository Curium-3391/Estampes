import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";

// The workbench bar fills in after the canvas has drawn (its own
// surface_get_state call) and pushes the canvas down. Coordinates taken
// before that land on the wrong spot once the bar appears, so wait for it.
const settled=ui=>ui.frame.locator("#wb-bar:not(:empty)").waitFor();
async function point(ui,x,y) {
  await settled(ui);
  return ui.frame.locator("#surface").evaluate((svg,[x,y])=>{const p=svg.createSVGPoint();p.x=x*Number(svg.getAttribute("viewBox").split(" ")[2]);p.y=y*Number(svg.getAttribute("viewBox").split(" ")[3]);const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};},[x,y]);
}
const tap=async(ui,p,touch)=>touch?ui.page.touchscreen.tap(p.x,p.y):ui.page.mouse.click(p.x,p.y);
for(const touch of [false,true])test("type, drag, undo and reopen vector text and annotation notes: "+(touch?"mobile touch":"desktop"),{skip:noBrowser,timeout:120000},async()=>{
  const s=await startStack({cas:false});
  try{
    const ok=async(name,args)=>{const r=await s.call(name,args);assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent;};
    const data=(await sharp({create:{width:800,height:600,channels:3,background:"#ddd"}}).png().toBuffer()).toString("base64");
    const imageId=(await ok("upload_visual_image",{total:data.length,offset:0,data})).imageId;
    const ui=await s.open({imageId,touch,viewport:touch?{width:390,height:844}:{width:1280,height:900}});
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator('[data-mode="text"]').click();
    await tap(ui,await point(ui,.2,.35),touch);
    await ui.frame.locator("#text-content").waitFor();
    const wording="中文 Ω🙂\n第二行 <script>";
    await ui.frame.locator("#text-content").fill(wording);
    await ui.frame.locator("#text-size").fill("28");
    await ui.frame.locator("#text-color").fill("#e36bf0");
    await ui.frame.locator("#text-save").click();
    await ui.frame.locator("#status").filter({hasText:"已儲存文字變更"}).waitFor();
    let state=await ok("get_visual_state",{imageId});
    const obj=state.objects.find(o=>o.type==="shape");
    assert.ok(obj);assert.equal(obj.props.text,wording);assert.equal(obj.provenance.author,"user");
    const rendered=ui.frame.locator('#unified-layers g[data-object="'+obj.id+'"] text');
    assert.equal(await rendered.count(),2);
    await ui.shot("annotation-text-created-"+(touch?"mobile":"desktop"));
    assert.equal(await ui.frame.locator("#surface script").count(),0);
    await ui.frame.locator("#text-undo").click();
    await ui.page.waitForTimeout(250);
    assert.equal((await ok("get_visual_state",{imageId})).objects?.length??0,0);
    await ui.frame.locator("#text-redo").click();
    await rendered.first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    await settled(ui);const box=await rendered.first().boundingBox(),from={x:box.x+box.width/2,y:box.y+box.height/2};
    const to={x:from.x+35,y:from.y+25};
    if(touch){
      const cdp=await ui.page.context().newCDPSession(ui.page);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...from,id:1}]});
      await ui.page.waitForTimeout(150);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{...to,id:1}]});
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await cdp.detach();
    }else{await ui.page.mouse.move(from.x,from.y);await ui.page.mouse.down();await ui.page.waitForTimeout(150);await ui.page.mouse.move(to.x,to.y,{steps:4});await ui.page.mouse.up();}
    await ui.page.waitForTimeout(500);
    state=await ok("get_visual_state",{imageId});const moved=state.objects.find(o=>o.id===obj.id);
    assert.ok(moved.props.x>obj.props.x);assert.ok(moved.props.y>obj.props.y);
    assert.equal(moved.props.text,wording);
    await ui.reload();await rendered.first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    await settled(ui);const box2=await rendered.first().boundingBox();await tap(ui,{x:box2.x+box2.width/2,y:box2.y+box2.height/2},touch);
    await ui.frame.locator("#text-editor").waitFor();
    assert.equal(await ui.frame.locator("#text-content").inputValue(),wording);

    // Saved user annotations get a real touch-friendly Save control, with
    // multiline notes and clearing; the note is structured, never HTML.
    await ok("validate_visual_annotations",{imageId,annotations:[{id:"user-note",type:"point",x:.82,y:.82,label:"YOU 1"}]});
    await ui.reload();await ui.frame.locator("#unified-layers circle").waitFor();await ui.frame.locator('[data-mode="select"]').click();
    await tap(ui,await point(ui,.82,.82),touch);
    await ui.frame.getByRole("textbox",{name:"標籤",exact:true}).fill("標籤中文");
    await ui.frame.getByRole("textbox",{name:"標籤",exact:true}).dispatchEvent("keydown",{key:"Enter",isComposing:true,keyCode:229});
    assert.equal((await ok("get_visual_state",{imageId})).marks.find(m=>m.id==="user-note").label,"YOU 1","IME composition does not save prematurely");
    await ui.frame.getByRole("textbox",{name:"標記備註",exact:true}).fill("第一行\n第二行🙂 <img>");
    await ui.frame.getByRole("button",{name:"儲存標籤與備註",exact:true}).click();
    await ui.frame.locator("#status").filter({hasText:"已儲存標籤與備註"}).waitFor();
    state=await ok("get_visual_state",{imageId});let mark=state.marks.find(m=>m.id==="user-note");
    await ui.shot("annotation-note-editor-"+(touch?"mobile":"desktop"));
    assert.equal(mark.label,"標籤中文");assert.equal(mark.finding.note,"第一行\n第二行🙂 <img>");
    assert.deepEqual(mark.geometry,{x:.82,y:.82});
    await ui.frame.getByRole("textbox",{name:"標籤",exact:true}).fill("");
    await ui.frame.getByRole("textbox",{name:"標記備註",exact:true}).fill("");
    await ui.frame.getByRole("button",{name:"儲存標籤與備註",exact:true}).click();
    await ui.page.waitForTimeout(300);
    state=await ok("get_visual_state",{imageId});mark=state.marks.find(m=>m.id==="user-note");
    assert.equal(mark.label,"");assert.equal(mark.finding?.note,undefined);
    await ok("edit_visual_canvas",{imageId,layers:[{id:mark.layer,locked:true},{id:obj.layer,locked:true}]});
    await ui.reload();await ui.frame.locator("#unified-layers circle").waitFor();
    await ui.frame.locator('[data-mode="select"]').click();await tap(ui,await point(ui,.82,.82),touch);
    assert.equal(await ui.frame.getByRole("textbox",{name:"標記備註",exact:true}).getAttribute("readonly"),"");
    await settled(ui);const lockedBox=await rendered.first().boundingBox();await tap(ui,{x:lockedBox.x+lockedBox.width/2,y:lockedBox.y+lockedBox.height/2},touch);
    await ui.frame.locator("#text-editor").waitFor();assert.equal(await ui.frame.locator("#text-save").isDisabled(),true);
    // The user can change layer visibility even when its content is locked.
    await ok("edit_visual_canvas",{imageId,layers:[{id:obj.layer,visible:false}]});
    await ui.reload();await ui.frame.locator("#unified-layers circle").waitFor();
    assert.equal(await rendered.count(),0,"hidden text stays hidden after reload");
    assert.deepEqual(ui.errors,[]);
    await ui.shot("annotation-text-"+(touch?"mobile":"desktop"));
  }finally{await s.close();}
});

test("text edits target a rotated, zoomed workspace copy and survive server restart",{skip:noBrowser,timeout:120000},async()=>{
  const s=await startStack({cas:false});
  try{
    const ok=async(name,args)=>{const r=await s.call(name,args);assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent;};
    const data=(await sharp({create:{width:800,height:600,channels:3,background:"#ddd"}}).png().toBuffer()).toString("base64");
    const imageId=(await ok("upload_visual_image",{total:data.length,offset:0,data})).imageId;
    let read=await ok("edit_canvas_text",{imageId});
    const made=await ok("edit_canvas_text",{imageId,action:"create",expectedRevision:read.revision,props:{text:"旋轉工作區\n第二行",x:.45,y:.45,size:24,fill:"#579DF6"}});
    const id=made.selectedId;
    const preview=await ok("split_workspace",{source:imageId,mode:"copy"});
    const copied=await ok("split_workspace",{source:imageId,mode:"copy",commit:true,previewId:preview.previewId});
    const workspaceId=copied.workspaceId,set=copied.items[0].set,setId=set.split("#")[1];
    assert.ok(setId);
    await ok("edit_workspace",{workspaceId,arrange:[{item:copied.items[0].id,rotation:90}]});
    const ui=await s.open({result:()=>s.call("present_visual",{workspaceId})});
    const rendered=ui.frame.locator('#unified-layers g[data-object="'+id+'"] text').first();
    await rendered.waitFor();
    await ui.frame.locator("#zoom-in").click();await ui.page.waitForTimeout(300);
    await ui.frame.locator('[data-mode="select"]').click();
    await settled(ui);const box=await rendered.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await ui.page.mouse.move(x,y);await ui.page.mouse.down();await ui.page.waitForTimeout(150);
    await ui.page.mouse.move(x+25,y+15,{steps:5});await ui.page.mouse.up();await ui.page.waitForTimeout(400);
    read=await ok("edit_canvas_text",{imageId,setId});
    const moved=read.objects.find(o=>o.id===id);
    assert.ok(moved.editable.x>.45,"90-degree view movement maps back to source x");
    assert.ok(moved.editable.y<.45,"90-degree view movement maps back to source y");
    assert.equal((await ok("get_visual_state",{imageId})).objects.find(o=>o.id===id).props.x,.45,"copy editing leaves the original alone");
    await ui.frame.locator("#text-content").fill("副本的新文字🙂\n多行保留");
    await ui.frame.locator("#text-save").click();await ui.page.waitForTimeout(300);
    const saved=await ok("edit_canvas_text",{imageId,setId});
    assert.equal(saved.objects.find(o=>o.id===id).editable.text,"副本的新文字🙂\n多行保留");
    assert.deepEqual(ui.errors,[]);
    await s.close();
    const restarted=await startStack({cas:false,env:{ESTAMPES_STORAGE_DIR:s.dir}});
    try{
      const result=await restarted.call("edit_canvas_text",{imageId,setId});
      assert.ok(!result.isError,JSON.stringify(result.content));
      assert.equal(result.structuredContent.objects.find(o=>o.id===id).editable.text,"副本的新文字🙂\n多行保留");
      const undone=await restarted.call("edit_canvas_text",{imageId,setId,action:"undo",expectedRevision:result.structuredContent.revision});
      assert.ok(!undone.isError,JSON.stringify(undone.content));
      assert.equal(undone.structuredContent.objects.find(o=>o.id===id).editable.text,"旋轉工作區\n第二行");
    }finally{await restarted.close();}
  }finally{await s.close();}
});

test("paired canvas edits right-side text without touching the left image",{skip:noBrowser,timeout:60000},async()=>{
  const s=await startStack({cas:false});
  try{
    const ok=async(name,args)=>{const r=await s.call(name,args);assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent;};
    const image=async background=>{const data=(await sharp({create:{width:500,height:400,channels:3,background}}).png().toBuffer()).toString("base64");return (await ok("upload_visual_image",{total:data.length,offset:0,data})).imageId;};
    const left=await image("#eee"),right=await image("#ddd");
    const read=await ok("edit_canvas_text",{imageId:right});
    const made=await ok("edit_canvas_text",{imageId:right,action:"create",expectedRevision:read.revision,props:{text:"右側文字",x:.3,y:.4}});
    const second=await ok("edit_canvas_text",{imageId:right,action:"create",expectedRevision:made.revision,props:{text:"右側上層文字",x:.3,y:.65}});
    const firstLayer=made.objects.find(o=>o.id===made.selectedId).layer,secondLayer=second.objects.find(o=>o.id===second.selectedId).layer;
    const leftLayers=(await ok("get_visual_state",{imageId:left})).layers;
    const ui=await s.open({imageId:left,result:()=>s.call("present_visual",{imageId:left,pairImageId:right})});
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    const rendered=ui.frame.locator('#unified-layers g[data-side="right"][data-object="'+made.selectedId+'"] text');
    await rendered.waitFor();await ui.frame.locator('[data-mode="select"]').click();
    // Measuring a visible SVG node alone does not wait for the workbench's
    // opening layout/scroll to settle. Keep the native pointer click, but wait
    // for Playwright's stable, in-view geometry before taking its coordinates.
    await rendered.scrollIntoViewIfNeeded();
    await settled(ui);const b=await rendered.boundingBox();await ui.page.mouse.click(b.x+b.width/2,b.y+b.height/2);
    await ui.frame.locator("#text-editor").waitFor();
    assert.equal(await ui.frame.locator("#text-size").inputValue(),"15");
    assert.equal(await ui.frame.locator("#text-color").inputValue(),"#e4ae57");
    await ui.frame.locator("#text-content").fill("修改右側🙂");await ui.frame.locator("#text-save").click();await ui.page.waitForTimeout(300);
    assert.equal((await ok("get_visual_state",{imageId:right})).objects[0].props.text,"修改右側🙂");
    assert.equal((await ok("get_visual_state",{imageId:left})).objects?.length??0,0);
    await ui.frame.locator("#layer-manager summary").click();
    const down=ui.frame.locator('#layers button[data-layer="R'+secondLayer+'"][data-act="down"]');
    assert.equal(await down.isDisabled(),false);await down.click();
    await ui.frame.locator("#status").filter({hasText:"已調整圖層順序"}).waitFor();
    const reordered=(await ok("get_visual_state",{imageId:right})).layers.map(l=>l.id);
    assert.ok(reordered.indexOf(secondLayer)<reordered.indexOf(firstLayer),"right text-only layers reorder on the server");
    assert.deepEqual((await ok("get_visual_state",{imageId:left})).layers,leftLayers,"left layer order is untouched");
    await ui.reload();await ui.frame.locator("#layer-manager summary").click();
    await ui.frame.locator('#layers button[data-layer="R'+secondLayer+'"][data-act="up"]').waitFor();
    assert.equal(await ui.frame.locator('#layers button[data-layer="R'+secondLayer+'"][data-act="down"]').isDisabled(),true,"right order survives reload");
    assert.deepEqual(ui.errors,[]);
  }finally{await s.close();}
});

test("a freshly drawn annotation keeps its note through send, chat and reload",{skip:noBrowser,timeout:60000},async()=>{
  const s=await startStack({cas:false});
  try{
    const data=(await sharp({create:{width:500,height:400,channels:3,background:"#ddd"}}).png().toBuffer()).toString("base64");
    const imageId=(await s.call("upload_visual_image",{total:data.length,offset:0,data})).structuredContent.imageId;
    const ui=await s.open({imageId});
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    await ui.page.evaluate(()=>{window.sentMessages=[];addEventListener("message",e=>{if(e.data?.method==="ui/message")window.sentMessages.push(e.data.params);});});
    await ui.frame.locator('[data-mode="point"]').click();await tap(ui,await point(ui,.7,.7),false);
    await ui.frame.locator('[data-mode="select"]').click();await tap(ui,await point(ui,.7,.7),false);
    const note="新畫的備註\n第二行🙂 <img>";
    await ui.frame.getByRole("textbox",{name:"標籤",exact:true}).fill("新標籤");
    await ui.frame.getByRole("textbox",{name:"標記備註",exact:true}).fill(note);
    await ui.frame.getByRole("button",{name:"儲存標籤與備註",exact:true}).click();
    await ui.frame.locator("#send").click();
    await ui.frame.locator("#status").filter({hasText:"v0.2 上下文事件已提交"}).waitFor();
    const state=(await s.call("get_visual_state",{imageId})).structuredContent;
    const mark=state.marks.find(m=>m.label==="新標籤");assert.ok(mark);assert.equal(mark.finding?.note,note);
    const message=await ui.page.evaluate(()=>window.sentMessages.at(-1).content[0].text);
    assert.ok(message.includes(JSON.stringify(note)),"the structured event sent to the assistant includes the note");
    assert.ok(message.startsWith("我在 Estampes 畫布上標了 1 個地方："),"the person's sentence comes first, in their language");
    assert.ok(message.includes("\n\n--- Estampes annotation, for the assistant ---\n"),"then the English block for the assistant");
    await ui.reload();await ui.frame.locator("#unified-layers circle").waitFor();
    await ui.frame.locator('[data-mode="select"]').click();await tap(ui,await point(ui,.7,.7),false);
    assert.equal(await ui.frame.getByRole("textbox",{name:"標記備註",exact:true}).inputValue(),note);
    assert.deepEqual(ui.errors,[]);
  }finally{await s.close();}
});

test("rejected text drags redraw the last accepted position",{skip:noBrowser,timeout:60000},async()=>{
  const s=await startStack({cas:false});
  try{
    const data=(await sharp({create:{width:800,height:600,channels:3,background:"#ddd"}}).png().toBuffer()).toString("base64");
    const imageId=(await s.call("upload_visual_image",{total:data.length,offset:0,data})).structuredContent.imageId;
    const read=(await s.call("edit_canvas_text",{imageId})).structuredContent;
    const made=(await s.call("edit_canvas_text",{imageId,action:"create",expectedRevision:read.revision,props:{text:"拖曳失敗",x:.3,y:.4,size:28}})).structuredContent;
    const ui=await s.open({imageId});
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    const rendered=ui.frame.locator('#unified-layers g[data-object="'+made.selectedId+'"] text');
    await rendered.waitFor();await ui.frame.locator('[data-mode="select"]').click();
    await ui.page.evaluate(()=>{const original=window.hostCall;window.rejectTextCode="";window.hostCall=p=>p.name==="edit_canvas_text"&&p.arguments.action===(window.rejectTextAction??"update")&&window.rejectTextCode?{isError:true,content:[{type:"text",text:window.rejectTextCode}],structuredContent:{code:window.rejectTextCode}}:original(p);});
    for(const code of ["SAVE_FAILED","STALE_CANVAS"]){
      await ui.page.evaluate(code=>{window.rejectTextCode=code;},code);
      await settled(ui);await rendered.scrollIntoViewIfNeeded();const before=await rendered.boundingBox(),from={x:before.x+before.width/2,y:before.y+before.height/2};
      await ui.page.mouse.move(from.x,from.y);await ui.page.mouse.down();await ui.frame.locator("#text-editor").waitFor();
      await ui.page.mouse.move(from.x+40,from.y+30,{steps:4});await ui.page.mouse.up();
      await ui.frame.locator("#status").filter({hasText:code}).waitFor();
      const after=await rendered.boundingBox();assert.ok(Math.abs(after.x-before.x)<1&&Math.abs(after.y-before.y)<1,"failed drag restores the saved position: "+code);
      const saved=(await s.call("get_visual_state",{imageId})).structuredContent.objects[0];assert.equal(saved.props.x,.3);assert.equal(saved.props.y,.4);
    }
    await ui.frame.locator("#text-close").click();
    await ui.page.evaluate(()=>{window.rejectTextAction="read";window.rejectTextCode="READ_FAILED";});
    await settled(ui);await rendered.scrollIntoViewIfNeeded();const before=await rendered.boundingBox(),from={x:before.x+before.width/2,y:before.y+before.height/2};
    await ui.page.mouse.move(from.x,from.y);await ui.page.mouse.down();
    await ui.frame.locator("#status").filter({hasText:"READ_FAILED"}).waitFor();
    await ui.page.mouse.move(from.x+40,from.y+30,{steps:4});await ui.page.mouse.up();
    const after=await rendered.boundingBox();assert.ok(Math.abs(after.x-before.x)<1&&Math.abs(after.y-before.y)<1,"failed initial read also restores the saved position");
    assert.deepEqual(ui.errors,[]);
  }finally{await s.close();}
});

// #82 live failure: the AI's label/note fields were read-only in the widget,
// so a user could not change the text of AI-created marks. A tap on the drawn
// label selects its mark, and a tap (even a jittery finger) never moves it.
for(const touch of [false,true])test("#82: the user rewrites the label and note of AI-created marks: "+(touch?"mobile touch":"desktop"),{skip:noBrowser,timeout:90000},async()=>{
  const s=await startStack({cas:false});
  try{
    const ok=async(name,args)=>{const r=await s.call(name,args);assert.ok(!r.isError,JSON.stringify(r.content));return r.structuredContent;};
    const data=(await sharp({create:{width:900,height:1200,channels:3,background:"#ccc"}}).png().toBuffer()).toString("base64");
    const imageId=(await ok("upload_visual_image",{total:data.length,offset:0,data})).imageId;
    const annotations=[{id:"t82-A",type:"rect",x:.1,y:.15,x2:.4,y2:.35,label:"A",note:"AI note A"},
      {id:"t82-B",type:"point",x:.7,y:.5,label:"B",note:"AI note B"},{id:"t82-C",type:"arrow",x:.2,y:.7,x2:.5,y2:.85,label:"C"}];
    await ok("present_visual",{imageId,annotations});
    const ui=await s.open({imageId,touch,viewport:touch?{width:390,height:844}:{width:1280,height:900},result:()=>s.call("present_visual",{imageId})});
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator('[data-mode="select"]').click();
    const before=(await ok("get_visual_state",{imageId})).marks;
    // Tap the drawn words "A", not the box.
    const labelA=ui.frame.locator("#unified-layers text").filter({hasText:/^\? A$/});
    await settled(ui);await labelA.scrollIntoViewIfNeeded();const lb=await labelA.boundingBox();
    await tap(ui,{x:lb.x+lb.width-2,y:lb.y+lb.height/2},touch);
    const label=ui.frame.getByRole("textbox",{name:"標籤",exact:true}),note=ui.frame.getByRole("textbox",{name:"標記備註",exact:true});
    await label.waitFor();
    assert.equal(await label.inputValue(),"A");assert.equal(await label.getAttribute("readonly"),null,"the AI's label is editable");
    assert.equal(await note.inputValue(),"AI note A");
    await label.fill("甲 晶片 Ω🙂");await note.fill("使用者改寫\n第二行 <b>");
    await ui.frame.getByRole("button",{name:"儲存標籤與備註",exact:true}).click();
    await ui.frame.locator("#status").filter({hasText:"已儲存標籤與備註"}).waitFor();
    let marks=(await ok("get_visual_state",{imageId})).marks,a=marks.find(m=>m.id==="t82-A");
    assert.equal(a.label,"甲 晶片 Ω🙂");assert.equal(a.finding.note,"使用者改寫\n第二行 <b>");
    assert.equal(a.provenance.author,"assistant");
    assert.deepEqual(a.geometry,before.find(m=>m.id==="t82-A").geometry,"saving text does not move the mark");
    // The point: a jittery tap selects without moving it; clear its label.
    const pb=await point(ui,.7,.5);
    if(touch){
      const cdp=await ui.page.context().newCDPSession(ui.page);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:pb.x,y:pb.y,id:1}]});
      await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:pb.x+4,y:pb.y+3,id:1}]});
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await cdp.detach();
    }else await tap(ui,pb,false);
    await ui.page.waitForTimeout(400);
    assert.equal(await label.inputValue(),"B");
    await label.fill("");await note.fill("");
    await ui.frame.getByRole("button",{name:"儲存標籤與備註",exact:true}).click();
    await ui.frame.locator("#status").filter({hasText:"已儲存標籤與備註"}).waitFor();
    marks=(await ok("get_visual_state",{imageId})).marks;const b=marks.find(m=>m.id==="t82-B");
    assert.equal(b.label,undefined);assert.equal(b.finding?.note,undefined);
    assert.deepEqual(b.geometry,before.find(m=>m.id==="t82-B").geometry,"a tap to select never nudges the mark");
    // The AI is told what the user rewrote, and the edit survives a reload.
    const next=await s.call("present_visual",{imageId});
    assert.match(next.content.map(c=>c.text).join("\n"),/rewrote the text of YOUR mark t82-A: label "A" -> "甲 晶片 Ω🙂"/);
    await ui.reload();await ui.frame.locator("#unified-layers text").filter({hasText:"甲 晶片 Ω🙂"}).waitFor();
    assert.deepEqual(ui.errors,[]);
    await ui.shot("ai-label-edit-"+(touch?"mobile":"desktop"));
  }finally{await s.close();}
});
