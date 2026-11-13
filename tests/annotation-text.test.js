import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { storeUserMarks, applyCanvasChanges, editCanvas, undoCanvasEdit, redoCanvasEdit, canvasMarks, snapshotCanvas } from "../src/canvas-state.js";
import { replayUserAnnotation, resolveCoordinateAnnotation } from "../src/scene-catalog.js";
import { editText, textState, registerTextTools } from "../src/visual/text-tools.js";
import { canvasRevision, renderCanvas } from "../src/scene/canvas-render.js";
import { applySceneOps, renderedObjects } from "../src/scene/scene-ops.js";
import { serializeCanvas, restoreCanvas, useStorageDir } from "../src/storage.js";
import { exportMarksSvg } from "../src/marks-file.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { clearWorkspaces, workspaceItems, getWorkspace, commitTransfer } from "../src/workspace.js";

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });
const photo = async () => registerImage(await sharp({create:{width:400,height:300,channels:3,background:"#eee"}}).png().toBuffer(), {source:"test"});
const edit = (e,args) => editText(e,{expectedRevision:canvasRevision(e),...args});
const text = {x:.2,y:.3,text:"中文 α🙂\n第二行 <&>",size:24,fill:"#579DF6"};

test("user labels and notes clear and undo exactly; changed notes never inherit old review/evidence", async () => {
  const e=await photo();
  storeUserMarks(e,[{id:"user-1",type:"point",x:.3,y:.4,label:"原標籤",note:"原備註",review:"confirmed",confidence:"high",evidence:[{observer:"tool",says:"old claim"}]}]);
  const before=structuredClone(canvasMarks(e)[0]);
  editCanvas(e,{marks:[{id:"user-1",label:"",note:"新備註\n第二行"}],resolveUser:replayUserAnnotation});
  const after=canvasMarks(e)[0];
  assert.equal(after.note,"新備註\n第二行"); assert.equal(after.label,"");
  assert.equal(after.author,"user");assert.equal(after.x,.3);assert.equal(after.layer,before.layer);
  for(const k of ["review","confidence","evidence"])assert.equal(after[k],undefined);
  undoCanvasEdit(e);assert.deepEqual(canvasMarks(e)[0],before);
  redoCanvasEdit(e);assert.deepEqual(canvasMarks(e)[0],after);
  editCanvas(e,{marks:[{id:"user-1",note:""}],resolveUser:replayUserAnnotation});
  assert.equal(canvasMarks(e)[0].note,undefined);
  editCanvas(e,{layers:[{id:before.layer,locked:true}]});
  assert.throws(()=>editCanvas(e,{marks:[{id:"user-1",note:"blocked"}],resolveUser:replayUserAnnotation}),/locked/);
  applyCanvasChanges(e,{annotations:[{id:"ai-1",type:"point",x:.7,y:.7}],resolve:resolveCoordinateAnnotation});
  assert.throws(()=>editCanvas(e,{marks:[{id:"ai-1",note:"replace AI"}],resolveUser:replayUserAnnotation}),/only your own/);
});

test("standalone vector text supports multiline, stable identity, exact contents and persistent inverses", async () => {
  const e=await photo(),empty=await renderCanvas(e);
  const id=edit(e,{action:"create",props:text});
  assert.equal(e.objects.get(id).provenance.author,"user");
  assert.equal(e.layers.find(l=>l.id===e.objects.get(id).layer).author,"user");
  assert.equal(renderedObjects(e)[0].primitives.length,2);
  assert.notDeepEqual((await renderCanvas(e)).data,empty.data);
  const svg=exportMarksSvg(e,[],e.layers);
  assert.ok(svg.includes("第二行 &lt;&amp;&gt;"));
  edit(e,{action:"update",id,props:{x:.6,y:.7,text:"改字\n再改",size:32,fill:"#F2545B"}});
  const copy=Object.create(e);restoreCanvas(copy,structuredClone(serializeCanvas(e)));
  edit(copy,{action:"undo"});assert.deepEqual(copy.objects.get(id).props,{kind:"text",space:"canvas",...text});
  edit(copy,{action:"redo"});assert.equal(copy.objects.get(id).props.size,32);
  edit(copy,{action:"delete",id});assert.equal(copy.objects.has(id),false);
  edit(copy,{action:"undo"});assert.equal(copy.objects.get(id).props.text,"改字\n再改");
  assert.equal(copy.objects.get(id).provenance.author,"user");
});

test("text edits reject stale state, locked layers and conflicting history without losing other objects", async () => {
  const e=await photo(),rev=canvasRevision(e),id=edit(e,{action:"create",props:text});
  assert.throws(()=>editText(e,{action:"update",id,props:{x:.9},expectedRevision:rev}),{code:"STALE_CANVAS"});
  applySceneOps(e,[{op:"object.update",id,props:{text:"another editor"}}],{author:"user"});
  assert.throws(()=>edit(e,{action:"undo"}),{code:"HISTORY_CONFLICT"});
  const layer=e.objects.get(id).layer;
  editCanvas(e,{layers:[{id:layer,locked:true}]});
  for(const action of ["update","delete"])assert.throws(()=>edit(e,{action,id,props:{text:"blocked"}}),{code:"LAYER_LOCKED"});
  const id2=edit(e,{action:"create",props:{...text,text:"new layer"}});
  assert.notEqual(e.objects.get(id2).layer,layer);
  assert.equal(e.objects.get(id).props.text,"another editor");
});

test("text remains vector data through workspace copy and bundle import; copy history is independent", async () => {
  const e=await photo();edit(e,{action:"create",props:text});
  const transfer=await commitTransfer({source:e.imageId,target:"new",mode:"copy"});
  const [copy]=await workspaceItems(await getWorkspace(transfer.workspaceId));
  assert.equal(textState(copy.entry).history.canUndo,false);
  const [o]=copy.entry.objects.values();edit(copy.entry,{action:"update",id:o.id,props:{x:.8}});
  assert.equal([...e.objects.values()][0].props.x,.2);
  const {buffer}=await exportBundle(transfer.workspaceId);
  clearImages();clearWorkspaces();
  const imported=await importBundle(buffer),[item]=await workspaceItems(await getWorkspace(imported.workspace.id));
  assert.equal([...item.entry.objects.values()][0].props.text,text.text);
  assert.equal([...item.entry.objects.values()][0].props.x,.8);
  assert.equal(textState(item.entry).history.canUndo,false);
});

test("failed text persistence restores object, layer, sequence and undo state", async () => {
  const e=await photo(),handlers=new Map();
  registerTextTools({registerTool:(name,spec,handler)=>handlers.set(name,handler)}, {ensureSet:async()=>e,saveCanvas:async()=>{throw Error("disk full");}});
  const call=handlers.get("edit_canvas_text");
  const revision=canvasRevision(e);
  const r=await call({imageId:e.imageId,action:"create",expectedRevision:revision,props:text});
  assert.equal(r.isError,true);assert.equal(canvasRevision(e),revision);
  assert.equal(e.textHistory,undefined);assert.equal(e.objectSeq,undefined);
});


test("editing an assistant's standalone text preserves its creator and records the user edit",async()=>{
  const e=await photo();
  const made=applySceneOps(e,[{op:"object.create",type:"shape",props:{kind:"text",space:"canvas",...text}}],{author:"assistant"});
  const id=made.created[0],creator=structuredClone(e.objects.get(id).provenance);
  edit(e,{action:"update",id,props:{text:"使用者修正"}});
  assert.equal(e.objects.get(id).provenance.author,"assistant");
  assert.equal(e.objects.get(id).provenance.createdAt,creator.createdAt);
  assert.equal(e.objects.get(id).provenance.editedByUser,true);
  edit(e,{action:"undo"});assert.equal(e.objects.get(id).props.text,text.text);
  assert.equal(e.objects.get(id).provenance.editedByUser,true,"audit remains sticky after undo");
});


test("annotation note undo belongs to its workspace copy; rollback restores the history too",async()=>{
  const e=await photo();storeUserMarks(e,[{id:"user-1",type:"point",x:.2,y:.2,note:"原始備註"}]);
  editCanvas(e,{marks:[{id:"user-1",note:"來源的修改"}],resolveUser:replayUserAnnotation});
  const transfer=await commitTransfer({source:e.imageId,target:"new",mode:"copy"});
  const [copy]=await workspaceItems(await getWorkspace(transfer.workspaceId));
  assert.notEqual(copy.entry.markHistory,e.markHistory);assert.equal(copy.entry.markHistory.past.length,0);
  const restore=snapshotCanvas(copy.entry);
  editCanvas(copy.entry,{marks:[{id:"user-1",note:"副本的修改"}],resolveUser:replayUserAnnotation});
  assert.equal(e.markHistory.past.length,1);assert.equal(e.marks.get("user-1").note,"來源的修改");
  restore();assert.equal(copy.entry.markHistory.past.length,0);assert.equal(copy.entry.marks.get("user-1").note,"來源的修改");
});
