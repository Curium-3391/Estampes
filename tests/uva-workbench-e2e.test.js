// Real Chromium + application/MCP + leased persistence. Host relay is a fixture,
// never described as live ChatGPT acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startStack, noBrowser } from './helpers/widget-host.js';
const requestId=()=> 'req:'+randomUUID();
test('A–D/F/G browser: editable GPT/user image workspace, layers, Graph, stale writes and reopen',{skip:noBrowser,timeout:120000},async t=>{
 const beta=await mkdtemp(join(tmpdir(),'uva-browser-'));
 const stack=await startStack({cas:false,env:{ESTAMPES_UVA_BETA:'1',ESTAMPES_UVA_BETA_DIR:beta,ESTAMPES_UVA_BETA_PROFILE:'linux-process-crash-test',ESTAMPES_RATE_LIMIT_PER_MIN:'0'}});
 t.after(async()=>{await stack.close();await rm(beta,{recursive:true,force:true});});
 const call=async(args)=>{const r=await stack.call('experimental_workspace',args);assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
 const bytes=await sharp({create:{width:640,height:400,channels:3,background:'#d2dce4'}}).png().toBuffer(),data=bytes.toString('base64');
 const uploaded=await stack.call('upload_visual_image',{total:data.length,offset:0,data,fileName:'real-test-image.png'}),imageId=uploaded.structuredContent.imageId;
 assert.ok(imageId,JSON.stringify(uploaded));
 const legacyBefore=(await stack.call('get_visual_state',{imageId})).structuredContent;
 const prepare=async(doc,operation)=>call({action:'prepare',requestId:requestId(),...(doc?{documentId:doc.id,expectedRevision:doc.revision}:{}),operation});
 const edit=async(doc,operation)=>{const p=await prepare(doc,operation);return call({action:'commit',prepared:p.prepared});};
 let r=await edit(null,{type:'create',imageIds:[imageId,imageId],title:'Browser Beta'}),d=r.document;
 r=await edit(d,{type:'layer.create',name:'GPT'});d=r.document;
 const layer=d.scenes[0].layers[0].id;
 r=await edit(d,{type:'annotation.add',annotation:{type:'rect',geometry:{x:.1,y:.2,x2:.4,y2:.5},layerId:layer,label:'GPT box',style:{color:'red'}}});d=r.document;
 const annotation=d.scenes[0].annotations[0].id;
 const w=await stack.open({result:()=>stack.call('experimental_workspace',{action:'open',documentId:d.id})}),frame=w.frame;
 await frame.locator('#uva-canvas').waitFor();
 assert.equal(await frame.locator('[data-annotation="'+annotation+'"]').count(),1);
 assert.equal(await frame.locator('#uva-item option').count(),2);
 // User selects, edits geometry/style/label, and GPT reads the same authority.
 await frame.locator('#uva-annotations').selectOption(annotation);
 await frame.locator('#uva-label').fill('Human label');await frame.locator('#uva-x').fill('.25');await frame.locator('#uva-color').selectOption('blue');
 await frame.locator('#uva-save-annotation').click();
 await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor().catch(async e=>{throw new Error(e.message+'; UI: '+await frame.locator('#uva-status').textContent()+'; JS: '+w.errors.join(';'));});
 d=(await call({action:'open',documentId:d.id})).document;
 assert.equal(d.scenes[0].annotations[0].label,'Human label');assert.equal(d.scenes[0].annotations[0].geometry.x,.25);assert.equal(d.scenes[0].annotations[0].style.color,'blue');
 // Two layers, direct pointer creation at zoom, persistent visibility.
 await frame.locator('#uva-layer-name').fill('User ink');await frame.locator('#uva-add-layer').click();await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor().catch(async e=>{throw new Error(e.message+'; UI: '+await frame.locator('#uva-status').textContent()+'; JS: '+w.errors.join(';'));});
 d=(await call({action:'open',documentId:d.id})).document;const userLayer=d.scenes[0].layers[1].id;
 await frame.locator('#uva-layer').selectOption(userLayer);await frame.locator('#uva-mode').selectOption('rect');await frame.locator('#uva-zoom-in').click();
 const box=await frame.locator('#uva-canvas').boundingBox();
 await w.page.mouse.move(box.x+box.width*.5,box.y+box.height*.1);await w.page.mouse.down();await w.page.mouse.move(box.x+box.width*.7,box.y+box.height*.3);await w.page.mouse.up();
 await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor().catch(async e=>{throw new Error(e.message+'; UI: '+await frame.locator('#uva-status').textContent()+'; JS: '+w.errors.join(';'));});
 d=(await call({action:'open',documentId:d.id})).document;const user=d.scenes[0].annotations.find(a=>a.layerId===userLayer);
 assert.ok(user);assert.ok(Math.abs(user.geometry.x-.5)<.01);assert.ok(Math.abs(user.geometry.y-.1)<.01);
 await frame.locator('#uva-visible').uncheck();await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor().catch(async e=>{throw new Error(e.message+'; UI: '+await frame.locator('#uva-status').textContent()+'; JS: '+w.errors.join(';'));});assert.equal(await frame.locator('[data-annotation="'+user.id+'"]').count(),0);
 // GPT commit appears without re-opening the widget.
 d=(await call({action:'open',documentId:d.id})).document;
 r=await edit(d,{type:'annotation.add',annotation:{type:'point',geometry:{x:.8,y:.8},layerId:layer,label:'GPT live'}});d=r.document;
 await frame.locator('[data-annotation="'+d.scenes[0].annotations.at(-1).id+'"]').waitFor({timeout:10000});
 // Existing permission-checked Graph module on the same persistent visual item.
 await stack.enable(['org.estampes.graph']);
 await frame.locator('#uva-modules').evaluate(e=>e.open=true);
 await frame.locator('#uva-refresh').click();await frame.locator('[data-module="org.estampes.graph"]:enabled').waitFor({state:'attached'});
 await frame.locator('#uva-modules').evaluate(e=>e.open=true);
 await frame.locator('textarea[aria-label="org.estampes.graph params"]').fill('{"expression":"x^2"}');await frame.locator('[data-module="org.estampes.graph"]').click();await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor().catch(async e=>{throw new Error(e.message+'; UI: '+await frame.locator('#uva-status').textContent()+'; JS: '+w.errors.join(';'));});
 d=(await call({action:'open',documentId:d.id})).document;assert.ok(d.scenes[0].objects.some(o=>o.type==='function-plot'));
 const stale=await prepare(d,{type:'rename',title:'stale'});r=await edit(d,{type:'rename',title:'current'});d=r.document;
 const conflict=await stack.call('experimental_workspace',{action:'commit',prepared:stale.prepared});assert.equal(conflict.isError,true);
 // Editable state reopens in the actual browser resource, with image pixels.
 await w.reload();await frame.locator('#uva-canvas').waitFor();assert.equal(await frame.locator('#uva-title').inputValue(),'current');assert.equal(await frame.locator('#uva-layer option').count(),3);
 await frame.locator('#uva-annotations').selectOption(annotation);await frame.locator('#uva-label').fill('Stale human draft');
 r=await edit(d,{type:'rename',title:'New authoritative title'});d=r.document;
 await frame.locator('#uva-save-annotation').click();await frame.locator('#uva-status[role="alert"]').waitFor();
 assert.match(await frame.locator('#uva-status').textContent(),/changed|未寫入/);assert.equal((await call({action:'open',documentId:d.id})).document.scenes[0].annotations[0].label,'Human label');
 await w.reload();await frame.locator('#uva-canvas').waitFor();
 await frame.locator('#uva-export').click();await frame.locator('#uva-download a').waitFor();const href=await frame.locator('#uva-download a').getAttribute('href');assert.equal((await fetch(href)).status,200);
 assert.deepEqual((await stack.call('get_visual_state',{imageId})).structuredContent,legacyBefore);
 assert.deepEqual(w.errors,[]);await w.shot('uva-beta-workbench');
});

test('Workbench file chooser creates and extends a persistent multi-image workspace',{skip:noBrowser,timeout:60000},async t=>{
 const beta=await mkdtemp(join(tmpdir(),'uva-upload-'));
 const stack=await startStack({cas:false,env:{ESTAMPES_UVA_BETA:'1',ESTAMPES_UVA_BETA_DIR:beta,ESTAMPES_UVA_BETA_PROFILE:'linux-process-crash-test',ESTAMPES_RATE_LIMIT_PER_MIN:'0'}});
 t.after(async()=>{await stack.close();await rm(beta,{recursive:true,force:true});});
 const w=await stack.open({result:()=>stack.call('experimental_workspace',{action:'list'})}),frame=w.frame;
 const buffer=await sharp({create:{width:320,height:200,channels:3,background:'#ddbb88'}}).png().toBuffer();
 await frame.locator('#uva-files').setInputFiles([{name:'first.png',mimeType:'image/png',buffer},{name:'second.png',mimeType:'image/png',buffer}]);
 await frame.locator('#uva-canvas').waitFor();assert.equal(await frame.locator('#uva-item option').count(),2);
 await frame.locator('#uva-files').setInputFiles({name:'third.png',mimeType:'image/png',buffer});
 await frame.locator('#uva-status').filter({hasText:'已儲存'}).waitFor();assert.equal(await frame.locator('#uva-item option').count(),3);
 const list=await stack.call('experimental_workspace',{action:'list'});assert.equal(list.structuredContent.workspaces[0].items,3);
 assert.deepEqual(w.errors,[]);
});

test('Real high-entropy image fits Host budget and Workbench reassembles bounded pixel chunks',{skip:noBrowser,timeout:90000},async t=>{
 const beta=await mkdtemp(join(tmpdir(),'uva-photo-'));
 const stack=await startStack({cas:false,env:{ESTAMPES_UVA_BETA:'1',ESTAMPES_UVA_BETA_DIR:beta,ESTAMPES_UVA_BETA_PROFILE:'linux-process-crash-test',ESTAMPES_RATE_LIMIT_PER_MIN:'0'}});
 t.after(async()=>{await stack.close();await rm(beta,{recursive:true,force:true});});
 const {randomBytes}=await import('node:crypto');
 const buffer=await sharp(randomBytes(640*480*3),{raw:{width:640,height:480,channels:3}}).jpeg({quality:90}).toBuffer(),data=buffer.toString('base64');
 let uploadId,imageId;for(let offset=0;offset<data.length;offset+=400000){const r=await stack.call('upload_visual_image',{...(uploadId?{uploadId}:{}),total:data.length,offset,data:data.slice(offset,offset+400000)});assert.ok(!r.isError);uploadId=r.structuredContent.uploadId;imageId=r.structuredContent.imageId??imageId;}
 const p=await stack.call('experimental_workspace',{action:'prepare',requestId:requestId(),operation:{type:'create',imageIds:[imageId]}});assert.ok(!p.isError,JSON.stringify(p));
 const c=await stack.call('experimental_workspace',{action:'commit',prepared:p.structuredContent.prepared}),id=c.structuredContent.document.id;assert.ok(id);
 const model=await stack.call('experimental_workspace',{action:'render',documentId:id});assert.ok(!model.isError,JSON.stringify(model));assert.ok(JSON.stringify(model).length<=145000);assert.equal(model.structuredContent.coordinateSystem,'normalized-top-left');assert.ok(model.content.some(c=>c.type==='image'));
 const first=await stack.call('uva_user_command',{action:'render',documentId:id});assert.ok(!first.isError);assert.ok(first.structuredContent.transport);assert.ok(JSON.stringify(first).length<=145000);
 let all=first.structuredContent.transport.data,next=first.structuredContent.transport.next;const tr=first.structuredContent.transport;
 while(next<tr.total){const r=await stack.call('uva_user_command',{action:'read_chunk',transportId:tr.id,offset:next});assert.ok(!r.isError);assert.ok(JSON.stringify(r).length<=145000);assert.equal(r.structuredContent.transport.offset,next);all+=r.structuredContent.transport.data;next=r.structuredContent.transport.next;}
 const pixels=JSON.parse(all);assert.equal(pixels.revision,c.structuredContent.revision);assert.equal((await sharp(Buffer.from(pixels.image.data,'base64')).metadata()).width,640);
 const w=await stack.open({result:()=>stack.call('experimental_workspace',{action:'open',documentId:id})});await w.frame.locator('#uva-canvas').waitFor();
 assert.ok((await w.frame.locator('#uva-canvas image').first().getAttribute('href')).length>145000);assert.deepEqual(w.errors,[]);
});
