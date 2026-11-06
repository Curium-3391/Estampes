// Inlined into the existing Workbench resource. State edits always use the
// signed prepare/CommitRoot path; view, selection, zoom and pan stay local.
const uvaUuid=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const x=Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');return x.slice(0,8)+'-'+x.slice(8,12)+'-'+x.slice(12,16)+'-'+x.slice(16,20)+'-'+x.slice(20);};
const uva={doc:null,scene:null,layer:null,selected:null,mode:'select',zoom:1,pending:null,busy:false,shown:false,renderKey:null,renderData:null,drag:null};
let uvaRoot=null;
function uvaLauncher(){
 if(!UVA_BETA_ENABLED||document.querySelector('#uva-launch'))return;
 wbBar.append(h('button',{id:'uva-launch',onclick:()=>uvaShow()},'UVA Experimental Beta'));
}
function uvaNode(tag,attrs={}){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))if(v!==undefined)n.setAttribute(k,String(v));return n;}
function uvaScene(){return uva.doc?.scenes.find(s=>s.id===uva.scene)??uva.doc?.scenes[0];}
function uvaStatus(message,error=false){const el=document.querySelector('#uva-status');if(el){el.textContent=message;el.setAttribute('role',error?'alert':'status');}}
async function uvaDecode(r){
 if(!r.transport)return r;
 if(r.transport.offset!==0)return uvaDecode(await wbCall('uva_user_command',{action:'read_chunk',transportId:r.transport.id,offset:0}));
 const first=r.transport;let data=first.data,next=first.next;
 while(next<first.total){const part=(await wbCall('uva_user_command',{action:'read_chunk',transportId:first.id,offset:next})).transport;
  if(!part||part.id!==first.id||part.offset!==next||part.total!==first.total||part.next<=next)throw Error('分段資料不一致；請重新開啟');data+=part.data;next=part.next;
 }
 return JSON.parse(data);
}
async function uvaCall(args){return uvaDecode(await wbCall('uva_user_command',args));}
function uvaShow(){
 if(!UVA_BETA_ENABLED)return;
 uva.shown=true;wbEl.hidden=false;wbArea.hidden=true;
 if(!uvaRoot){uvaRoot=h('section',{id:'uva-workspace','aria-label':'UVA Experimental Beta',style:'padding:12px;border:1px solid #8886;border-radius:10px;overflow:auto;max-height:85vh'});wbEl.append(uvaRoot);}
 uvaRoot.hidden=false;uvaDraw();uvaList();
}
function uvaAccept(r){
 if(r?.kind!=='estampes.uva/1'||r.code)return;
 if(r.transport){uvaDecode(r).then(uvaAccept).catch(e=>uvaStatus(e.message,true));return;}
 if(r.document&&!r.prepared){uva.doc=r.document;uva.pending=null;uva.renderKey=null;}
 uvaShow();
}
async function uvaList(){try{
 const r=await uvaCall({action:'list'}),select=document.querySelector('#uva-list');
 if(select){select.replaceChildren(h('option',{value:''},'選擇實驗工作區'));for(const w of r.workspaces)select.append(h('option',{value:w.id,selected:w.id===uva.doc?.id},w.title+' · r'+w.revision));}
 if(r.diagnostics){const el=document.querySelector('#uva-diagnostics');if(el)el.textContent=r.diagnostics.durability+' · Production NOT QUALIFIED · '+r.diagnostics.state;}
 }catch(e){uvaStatus(e.message,true);}}
async function uvaOpen(id){if(!id)return;try{const r=await uvaCall({action:'open',documentId:id});uva.doc=r.document;uva.selected=null;uva.pending=null;uva.renderKey=null;uvaDraw();uvaList();if(r.assetErrors?.length)uvaStatus(r.assetErrors.map(e=>e.message).join('; '),true);}catch(e){uvaStatus(e.message,true);}}
async function uvaEdit(operation){
 if(uva.busy)return;uva.busy=true;uvaStatus('儲存中…');
 try{
  const args={action:'prepare',requestId:'req:'+uvaUuid(),operation};
  if(uva.doc&&!['create','import'].includes(operation.type)){args.documentId=uva.doc.id;args.expectedRevision=uva.doc.revision;}
  const r=await uvaCall(args);uva.pending=r.prepared;
  await uvaCommit();
 }catch(e){uvaStatus('未寫入：'+e.message+'。請重新整理後檢查；交易失敗可用「重試原交易」。',true);}
 finally{uva.busy=false;}
}
async function uvaCommit(){
 if(!uva.pending)return;
 const r=await uvaCall({action:'commit',prepared:uva.pending});
 uva.pending=null;uva.doc=r.document;uva.renderKey=null;uvaDraw();uvaList();uvaStatus('已儲存 r'+r.document.revision+' · '+r.ack.commitId+' · '+r.ack.durability);
}
function uvaDraw(){
 if(!uvaRoot)return;
 const scene=uvaScene();if(scene)uva.scene=scene.id;
 if(scene&&!scene.layers.some(l=>l.id===uva.layer))uva.layer=scene.layers.find(l=>!l.locked)?.id??scene.layers[0]?.id;
 const imageIds=h('input',{id:'uva-images',placeholder:'img:…，多張以逗號分隔',value:typeof imageId==='string'?imageId:'','aria-label':'圖片 IDs'});
 const source=h('input',{id:'uva-source',placeholder:'ws:… 或 img:…','aria-label':'舊工作區 ID'});
 const title=h('input',{id:'uva-title',value:uva.doc?.title??'Experimental workspace','aria-label':'工作區名稱',maxlength:80});
 uvaRoot.replaceChildren(
  h('strong',{},'UVA Experimental Beta'),h('span',{},' · 獨立實驗副本'),
  h('button',{id:'uva-close',onclick:()=>{uva.shown=false;uvaRoot.hidden=true;wbArea.hidden=false;}},'關閉／返回原工作台'),
  h('div',{id:'uva-diagnostics'},'載入環境…'),h('div',{id:'uva-status',role:'status'},'就緒；變更需成功儲存才生效。'),
  h('div',{},h('select',{id:'uva-list','aria-label':'工作區',onchange:e=>uvaOpen(e.target.value)}),h('button',{id:'uva-refresh',onclick:()=>uva.doc?uvaOpen(uva.doc.id):uvaList()},'重新整理'),h('button',{onclick:()=>uva.pending&&uvaCommit().catch(e=>uvaStatus(e.message,true))},'重試原交易')),
  h('div',{},title,h('button',{id:'uva-rename',onclick:()=>uvaEdit({type:'rename',title:title.value})},'重新命名')),
  h('details',{},h('summary',{},'進階：現有圖片或舊工作區參照'),imageIds,h('button',{id:'uva-create',onclick:()=>uvaEdit({type:'create',title:title.value,imageIds:imageIds.value.split(',').map(x=>x.trim()).filter(Boolean)})},'從圖片建立'),source,h('button',{id:'uva-import',onclick:()=>uvaEdit({type:'import',title:title.value,sourceRef:source.value})},'匯入舊工作區副本')),
  h('div',{},h('button',{id:'uva-export',onclick:async()=>{try{const r=await uvaCall({action:'export',documentId:uva.doc.id});document.querySelector('#uva-download').replaceChildren(h('a',{href:r.url,target:'_blank',rel:'noopener'},'下載可編輯備份'));uvaStatus('已保存匯出檔；停用 Beta 後連結仍可讀取。');}catch(e){uvaStatus(e.message,true);}}},'保存／匯出'),h('span',{id:'uva-download'})),
 );
 const file=h('input',{id:'uva-files',type:'file',accept:'image/*',multiple:true,'aria-label':'上傳圖片',onchange:async()=>{
  try{
   const ids=[];for(const f of file.files){
    if(f.size>8*1024**2)throw Error('單張圖片上限 8 MiB');
    uvaStatus('上傳 '+f.name+'…');const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));const data=btoa(binary);let uploadId;
    for(let offset=0;offset<data.length;offset+=400000){const r=await wbCall('upload_visual_image',{...(uploadId?{uploadId}:{}),fileName:f.name,total:data.length,offset,data:data.slice(offset,offset+400000)});uploadId=r.uploadId;if(r.imageId)ids.push(r.imageId);}
   }
   await uvaEdit({type:uva.doc?'item.add':'create',title:title.value,imageIds:ids});
  }catch(e){uvaStatus('上傳未加入工作區：'+e.message,true);}
 }});
 uvaRoot.append(h('div',{},h('label',{},uva.doc?'加入圖片（保留各自圖層）':'從裝置圖片建立工作區',file)));
 if(!scene){uvaRoot.append(h('p',{},'選擇一到四張圖片建立工作區。也可在進階選項匯入舊工作區副本；原始資料會保留。'));return;}
 const items=h('select',{id:'uva-item','aria-label':'視覺項目',onchange:e=>{uva.scene=e.target.value;uva.selected=null;uva.renderKey=null;uvaDraw();uvaList();}});
 for(const [i,s]of uva.doc.scenes.entries())items.append(h('option',{value:s.id,selected:s.id===scene.id},'圖片 '+(i+1)+' · '+s.extent.width+'×'+s.extent.height));
 const layerSelect=h('select',{id:'uva-layer','aria-label':'作用圖層',onchange:e=>{uva.layer=e.target.value;uvaDraw();uvaList();}});
 for(const l of scene.layers)layerSelect.append(h('option',{value:l.id,selected:l.id===uva.layer},l.name+(l.locked?' 🔒':'')));
 const l=scene.layers.find(l=>l.id===uva.layer),layerName=h('input',{id:'uva-layer-name',placeholder:'圖層名稱',value:l?.name??'Ink','aria-label':'圖層名稱'});
 const toggle=(id,label,field,checked)=>h('label',{},h('input',{type:'checkbox',id,checked,onchange:e=>uvaEdit({type:'layer.update',sceneId:scene.id,id:l.id,patch:{[field]:e.target.checked}})}),label);
 uvaRoot.append(h('div',{},items,layerSelect,layerName,h('button',{id:'uva-add-layer',onclick:()=>uvaEdit({type:'layer.create',sceneId:scene.id,name:layerName.value})},'新增圖層'),h('button',{onclick:()=>uvaEdit({type:'layer.update',sceneId:scene.id,id:l.id,patch:{name:layerName.value}})},'改圖層名稱'),...(l?[toggle('uva-visible','顯示','visible',l.visible),toggle('uva-locked','鎖定','locked',l.locked),h('input',{id:'uva-opacity',type:'range',min:0,max:1,step:.1,value:l.opacity,'aria-label':'圖層透明度',onchange:e=>uvaEdit({type:'layer.update',sceneId:scene.id,id:l.id,patch:{opacity:Number(e.target.value)}})})]:[])));
 const mode=h('select',{id:'uva-mode','aria-label':'標註工具',onchange:e=>{uva.mode=e.target.value;}});
 for(const [v,label]of [['select','選取／移動'],['rect','方框'],['point','點'],['arrow','箭頭'],['polyline','自由線'],['pan','平移']])mode.append(h('option',{value:v,selected:uva.mode===v},label));
 uvaRoot.append(h('div',{},mode,h('button',{id:'uva-zoom-in',onclick:()=>{uva.zoom=Math.min(4,uva.zoom*1.25);uvaPaint();}},'＋ 放大'),h('button',{onclick:()=>{uva.zoom=Math.max(.25,uva.zoom/1.25);uvaPaint();}},'－ 縮小')));
 const select=h('select',{id:'uva-annotations','aria-label':'標註',onchange:e=>{uva.selected=e.target.value;uvaDraw();uvaList();}});
 select.append(h('option',{value:''},'選取標註'));for(const a of scene.annotations)select.append(h('option',{value:a.id,selected:a.id===uva.selected},a.label||a.id));
 uvaRoot.append(select);
 const a=scene.annotations.find(a=>a.id===uva.selected);
 if(a){
  const label=h('input',{id:'uva-label',value:a.label??'','aria-label':'標註標籤'}),color=h('select',{id:'uva-color','aria-label':'標註顏色'});
  for(const c of ['blue','red','green','gold','white','black'])color.append(h('option',{value:c,selected:c===a.style.color},c));
  const fields=['x','y',...(a.type==='rect'||a.type==='arrow'?['x2','y2']:[])].filter(k=>a.geometry[k]!==undefined).map(k=>h('input',{id:'uva-'+k,type:'number',step:.01,min:0,max:1,value:a.geometry[k],'aria-label':k,style:'width:85px'}));
  uvaRoot.append(h('div',{},label,color,...fields,h('button',{id:'uva-save-annotation',onclick:()=>{const geometry={...a.geometry};for(const f of fields)geometry[f.id.slice(4)]=Number(f.value);uvaEdit({type:'annotation.update',sceneId:scene.id,id:a.id,annotation:{label:label.value,style:{...a.style,color:color.value},geometry}});}},'儲存標註'),h('button',{id:'uva-delete-annotation',onclick:()=>uvaEdit({type:'annotation.remove',sceneId:scene.id,id:a.id})},'刪除標註')));
 }
 uvaRoot.append(h('div',{id:'uva-stage',style:'overflow:auto;max-height:54vh;border:1px solid #8885;background:#ddd;touch-action:none'}));uvaPaint();
 const modules=h('details',{id:'uva-modules'},h('summary',{},'模組／共享視覺項目'),h('div',{id:'uva-module-content'},'載入模組…'));uvaRoot.append(modules);
 uvaCall({action:'modules'}).then(r=>{
  const content=document.querySelector('#uva-module-content');if(!content)return;content.replaceChildren();
  for(const m of r.modules){
   const cap=h('select',{'aria-label':m.id+' action'});for(const c of m.capabilities)cap.append(h('option',{value:c.id},c.id));
   const params=h('textarea',{'aria-label':m.id+' params',rows:2},'{}');
   content.append(h('div',{},h('span',{},m.id+' · '+m.state),cap,h('details',{},h('summary',{},'參數格式'),h('pre',{},JSON.stringify(m.capabilities.map(c=>({id:c.id,inputSchema:c.inputSchema})),null,2))),params,h('button',{'data-module':m.id,disabled:m.state!=='enabled',onclick:()=>{try{uvaEdit({type:'module',sceneId:scene.id,module:m.id,capability:cap.value,params:JSON.parse(params.value)});}catch(e){uvaStatus(e.message,true);}}},'執行模組')));
  }
 }).catch(e=>uvaStatus(e.message,true));
}
async function uvaPaint(){
 const s=uvaScene(),stage=document.querySelector('#uva-stage');if(!s||!stage)return;
 const docId=uva.doc.id,revision=uva.doc.revision,key=docId+':'+s.id+':'+revision;
 if(uva.renderKey!==key){
  try{const fetched=await uvaCall({action:'render',documentId:docId,sceneId:s.id});if(!uva.shown||uva.doc?.id!==docId||uvaScene()?.id!==s.id||uva.doc.revision!==revision||stage!==document.querySelector('#uva-stage'))return;
   if(fetched.revision!==revision){uvaStatus('工作區已變更；請重新整理後檢查。',true);return;}uva.renderData=fetched;uva.renderKey=key;}catch(e){uvaStatus(e.message,true);return;}
 }
 const svg=uvaNode('svg',{id:'uva-canvas',viewBox:'0 0 '+s.extent.width+' '+s.extent.height,width:Math.min(760,s.extent.width)*uva.zoom,height:Math.min(760,s.extent.width)*uva.zoom*s.extent.height/s.extent.width,style:'display:block;touch-action:none;user-select:none'});
 svg.append(uvaNode('image',{href:'data:'+uva.renderData.image.mimeType+';base64,'+uva.renderData.image.data,width:s.extent.width,height:s.extent.height}));
 svg.append(uvaNode('image',{href:'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(uva.renderData.objectsSvg))),width:s.extent.width,height:s.extent.height}));
 for(const l of s.layers){
  if(!l.visible)continue;const group=uvaNode('g',{'data-layer':l.id,opacity:l.opacity});svg.append(group);
  for(const a of s.annotations.filter(a=>a.layerId===l.id)){
   const g=a.geometry,W=s.extent.width,H=s.extent.height;let n;
   if(a.type==='point')n=uvaNode('circle',{cx:g.x*W,cy:g.y*H,r:6/uva.zoom});
   else if(a.type==='polyline')n=uvaNode(g.closed?'polygon':'polyline',{points:g.points.map(p=>p.x*W+','+p.y*H).join(' ')});
   else if(a.type==='arrow')n=uvaNode('path',{d:`M ${g.x*W} ${g.y*H} L ${g.x2*W} ${g.y2*H} m ${-12*Math.cos(Math.atan2((g.y2-g.y)*H,(g.x2-g.x)*W)-.5)} ${-12*Math.sin(Math.atan2((g.y2-g.y)*H,(g.x2-g.x)*W)-.5)} M ${g.x2*W} ${g.y2*H} l ${-12*Math.cos(Math.atan2((g.y2-g.y)*H,(g.x2-g.x)*W)+.5)} ${-12*Math.sin(Math.atan2((g.y2-g.y)*H,(g.x2-g.x)*W)+.5)}`});
   else n=uvaNode('rect',{x:Math.min(g.x,g.x2)*W,y:Math.min(g.y,g.y2)*H,width:Math.abs(g.x2-g.x)*W,height:Math.abs(g.y2-g.y)*H});
   n.setAttribute('data-annotation',a.id);n.setAttribute('fill',a.type==='point'?(a.style.color??'gold'):'none');n.setAttribute('stroke',a.style.color??'gold');n.setAttribute('stroke-width',(a.id===uva.selected?4:2)/uva.zoom);n.setAttribute('pointer-events','all');group.append(n);
   if(a.label){const t=uvaNode('text',{x:g.x!==undefined?g.x*W:g.points[0].x*W,y:(g.y!==undefined?g.y*H:g.points[0].y*H)-5,fill:a.style.color??'gold','font-size':14/uva.zoom,'pointer-events':'none'});t.textContent=a.label;group.append(t);}
  }
 }
 stage.replaceChildren(svg);
 const point=e=>{const r=svg.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
 svg.addEventListener('pointerdown',e=>{
  if(uva.busy)return;const target=e.target.getAttribute('data-annotation'),p=point(e);uva.drag={start:p,last:p,points:[p],target,px:e.clientX,py:e.clientY,left:stage.scrollLeft,top:stage.scrollTop};svg.setPointerCapture(e.pointerId);
 });
 svg.addEventListener('pointermove',e=>{if(!uva.drag)return;uva.drag.last=point(e);if(uva.drag.points.length<128)uva.drag.points.push(uva.drag.last);if(uva.mode==='pan'){stage.scrollLeft=uva.drag.left+uva.drag.px-e.clientX;stage.scrollTop=uva.drag.top+uva.drag.py-e.clientY;}});
 svg.addEventListener('pointercancel',()=>{uva.drag=null;});
 svg.addEventListener('pointerup',e=>{
  const d=uva.drag;uva.drag=null;if(!d)return;if(uva.doc.revision!==revision){uvaStatus('工作區已變更；這次拖曳尚未儲存，請重新整理。',true);return;}const p=point(e);
  if(uva.mode==='pan')return;
  if(uva.mode==='select'){
   if(!d.target)return;uva.selected=d.target;const a=s.annotations.find(a=>a.id===d.target),dx=p.x-d.start.x,dy=p.y-d.start.y;
   if(Math.abs(dx)+Math.abs(dy)>.005){const g=structuredClone(a.geometry);if(g.points)g.points=g.points.map(q=>({x:q.x+dx,y:q.y+dy}));for(const k of ['x','x2'])if(g[k]!==undefined)g[k]+=dx;for(const k of ['y','y2'])if(g[k]!==undefined)g[k]+=dy;uvaEdit({type:'annotation.update',sceneId:s.id,id:a.id,annotation:{geometry:g}});}else{uvaDraw();uvaList();}return;
  }
  if(!uva.layer){uvaStatus('請先新增圖層',true);return;}
  const geometry=uva.mode==='point'?p:uva.mode==='polyline'?{points:[...d.points,p].slice(0,128)}:{x:d.start.x,y:d.start.y,x2:p.x,y2:p.y};
  uvaEdit({type:'annotation.add',sceneId:s.id,annotation:{type:uva.mode,geometry,layerId:uva.layer,style:{color:'blue'},label:''}});
 });
}
// Poll the authoritative model, without replacing a draft or an input the user
// is editing. GPT commits become visible through this same read operation.
setInterval(async()=>{
 if(!uva.shown||!uva.doc||uva.busy||uva.drag||uvaRoot?.contains(document.activeElement)&&/INPUT|TEXTAREA/.test(document.activeElement.tagName))return;
 try{const id=uva.doc.id,r=await uvaCall({action:'open',documentId:id});if(uva.doc?.id===id&&r.revision!==uva.doc.revision){uva.doc=r.document;uva.renderKey=null;uvaDraw();uvaList();}}catch(e){uvaStatus(e.message,true);}
},1500);
