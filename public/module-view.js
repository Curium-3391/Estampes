// ===== Module views: the declarative renderer (#85 V2-3) =====
// Inlined after workbench.js in the same scope (wb, h, t, wbCall, wbLoad ...). A view is drawn from the tree in its manifest
// (estampes.renderer.declarative/1, checked again here before anything is drawn); the module ships no script, markup or style.
// Everything is created with createElement/textContent. Values come from the module's stored instances through the host's
// models.get capability; a control runs one of the view's actions through execute_module, with every check that has. Nothing
// the person is doing (a half-typed number, focus) is stored: only an action writes, and only through the module.
const mv=new Map();// panelId -> { values:{model:{id,revision,value}|null}, loaded:key|null, busy, msg, kind }
const MV_TYPES=new Set(["stack","text","readout","toggle","number","select","button"]);
const mvState=id=>{let s=mv.get(id);if(!s){s={values:{},loaded:null,busy:false,msg:"",kind:""};mv.set(id,s);}return s;};
const mvPointer=(value,path)=>{let v=value;for(const seg of String(path).slice(1).split("/")){if(v==null||typeof v!=="object"||!Object.prototype.hasOwnProperty.call(v,seg))return undefined;v=v[seg];}return v;};
const mvText=(node,field)=>{const loc=node[field+"I18n"];const lang=(typeof i18nLocale==="function"?i18nLocale():"")||"";return (loc&&(loc[lang]??loc[lang.split("-")[0]]))??node[field]??"";};
function mvBoundKey(def){return JSON.stringify(def?.bound??{});}
async function mvLoad(p){
 const def=wb.moduleViews?.[p.panelId],s=mvState(p.panelId);
 if(!def||def.unavailable||p.moduleState!=="enabled")return;
 const next={};let failed="";
 for(const name of def.reads){
  const id=def.bound?.[name];if(!id){next[name]=null;continue;}
  try{const r=await wbCall("execute_module",{module:p.module,capability:"models.get",params:{model:name,id}});
   const inst=r.data?.instance;next[name]=inst?{id:inst.id,revision:inst.revision,value:inst.value}:null;}
  catch(err){if(err.code==="stale")return;next[name]=s.values[name]??null;failed=String(err.message||err);}
 }
 const changed=JSON.stringify(next)!==JSON.stringify(s.values);
 s.loaded=mvBoundKey(def);
 if(failed){s.msg=t("wb.view.failed",{message:failed});s.kind="error";}else if(s.kind==="error")s.msg="";
 // Not while the person is typing in this view: the next refresh brings it.
 const el=wb.els.get(p.panelId);
 if(changed&&el?.contains(document.activeElement)&&["INPUT","SELECT"].includes(document.activeElement.tagName)&&document.activeElement.type!=="checkbox"){return;}
 s.values=next;
 if(changed||failed)mvDraw(p);
}
async function mvAct(p,def,node,value){
 const s=mvState(p.panelId);if(s.busy)return;
 const model=node.model??def.reads[0],cur=s.values[model]??null,params={};
 for(const [k,v] of Object.entries(node.params??{})){
  params[k]=v&&typeof v==="object"?(v.$==="value"?value:v.$==="instance"?cur?.id:cur?.revision):v;
 }
 if(Object.values(params).some(v=>v===undefined)){s.msg=t("wb.view.noInstance");s.kind="error";mvDraw(p);return;}
 s.busy=true;s.msg="";s.kind="";mvDraw(p);
 try{await wbCall("execute_module",{module:p.module,capability:node.action,params});}
 catch(err){if(err.code!=="stale"){s.msg=t("wb.view.failed",{message:String(err.message||err)});s.kind="error";}}
 s.busy=false;
 // The action may have made the instance this view shows: read the surface again (which also reloads the values).
 s.loaded=null;await wbLoad();
 mvDraw(p);
}
function mvNode(p,def,s,node,depth){
 if(!node||typeof node!=="object"||!MV_TYPES.has(node.type)||depth>6)return h("span",{class:"mv-inert"},"…");
 const off=s.busy||p.moduleState!=="enabled";
 if(node.type==="stack"){
  return h("div",{class:"mv-stack","data-dir":node.direction==="row"?"row":"column"},(Array.isArray(node.children)?node.children.slice(0,24):[]).map(c=>mvNode(p,def,s,c,depth+1)));
 }
 if(node.type==="text")return h("p",{class:"mv-text"},mvText(node,"text"));
 const label=mvText(node,"label");
 if(node.type==="button")return h("button",{class:"mv-btn",type:"button",disabled:off,onclick:()=>mvAct(p,def,node,undefined)},label);
 const inst=s.values[node.model]??null,raw=inst?mvPointer(inst.value,node.path):undefined,uid="mv-"+p.panelId.replace(/[^a-z0-9]/gi,"")+"-"+(s.n=(s.n??0)+1);
 if(node.type==="readout"){
  const shown=raw===undefined?"—":node.format==="bit"?(raw?"1":"0"):node.format==="yes-no"?(raw?t("wb.view.yes"):t("wb.view.no")):typeof raw==="boolean"?(raw?"1":"0"):String(raw);
  return h("div",{class:"mv-row"},h("span",{class:"mv-label",id:uid},label),h("output",{class:"mv-out","aria-labelledby":uid,"data-path":node.path},shown));
 }
 const dis=off||!inst;
 if(node.type==="toggle"){
  const box=h("input",{type:"checkbox",id:uid,disabled:dis,checked:raw===true,onchange:e=>mvAct(p,def,node,e.target.checked)});
  box.checked=raw===true;
  return h("div",{class:"mv-row"},h("label",{class:"mv-label",for:uid},label),box);
 }
 if(node.type==="number"){
  const inp=h("input",{type:"number",id:uid,disabled:dis,min:node.min,max:node.max,step:node.step,onchange:e=>{const v=Number(e.target.value);if(Number.isFinite(v))mvAct(p,def,node,v);}});
  inp.value=raw===undefined?"":String(raw);
  return h("div",{class:"mv-row"},h("label",{class:"mv-label",for:uid},label),inp);
 }
 if(node.type==="select"){
  const sel=h("select",{id:uid,disabled:dis,onchange:e=>{const o=(node.options??[]).find(x=>String(x.value)===e.target.value);if(o)mvAct(p,def,node,o.value);}},
   (Array.isArray(node.options)?node.options.slice(0,16):[]).map(o=>h("option",{value:String(o.value)},mvText(o,"label"))));
  sel.value=raw===undefined?"":String(raw);
  return h("div",{class:"mv-row"},h("label",{class:"mv-label",for:uid},label),sel);
 }
 return h("span",{class:"mv-inert"},"…");
}
function mvDraw(p){
 const el=wb.els.get(p.panelId);if(!el)return;
 const body=el.querySelector(".wb-body"),def=wb.moduleViews?.[p.panelId],s=mvState(p.panelId);s.n=0;
 const note=text=>body.replaceChildren(h("div",{class:"mv"},h("p",{class:"wb-note mv-note",role:"status"},text)));
 if(!def||def.unavailable)return note(t("wb.view.unavailable"));
 if(p.moduleState!=="enabled")return note(t("wb.view.moduleOff"));
 const root=def.renderer?.type==="declarative"?def.renderer.payload?.root:null;
 if(!root)return note(t("wb.view.none"));
 const missing=def.reads.some(m=>!def.bound?.[m]);
 body.replaceChildren(h("div",{class:"mv","aria-busy":String(s.busy)},
  h("div",{class:"mv-bar"},h("button",{class:"wb-mini mv-refresh",type:"button",title:t("wb.view.refresh"),"aria-label":t("wb.view.refresh"),onclick:async()=>{s.loaded=null;await wbLoad();}},"↻")),
  mvNode(p,def,s,root,1),
  missing?h("p",{class:"wb-note mv-note"},t("wb.view.noInstance")):null,
  h("p",{class:"wb-note mv-note","data-kind":s.kind,role:"status","aria-live":"polite"},s.msg)));
}
function renderModuleView(p){
 const def=wb.moduleViews?.[p.panelId],s=mvState(p.panelId);
 if(def?.renderer?.type==="flow-graph")return renderFlowView(p);// the Flow view (public/flow-view.js)
 mvDraw(p);
 if(def&&!def.unavailable&&p.moduleState==="enabled"&&s.loaded!==mvBoundKey(def)){s.loaded=mvBoundKey(def);mvLoad(p);}
}
// Values are refreshed every few seconds while a view is open and the page is visible (the assistant or another window may change them).
setInterval(()=>{
 if(document.visibilityState!=="visible"||!wb.surface)return;
 const open=openPanels().filter(p=>p.kind==="module-view");
 if(!open.length)return;
 if(open.some(p=>{const d=wb.moduleViews?.[p.panelId];return d&&!d.unavailable&&p.moduleState==="enabled"&&d.reads.some(m=>!d.bound?.[m]);}))return void wbLoad();
 for(const p of open){
  if(wb.moduleViews?.[p.panelId]?.renderer?.type==="flow-graph"){if(!fvState(p.panelId).busy)fvLoad(p);continue;}
  if(!mvState(p.panelId).busy)mvLoad(p);
 }
},5000);
