// ===== Flow view: the `flow-graph` renderer (#86 F2) =====
// Inlined after module-view.js in the same scope (wb, h, t, wbCall, wbLoad, mv ...). Draws one flow as columns of node cards (a node sits one
// column after the nodes that feed it) with its connections listed as text, and offers what a person can do with it: run it, undo the last
// change, add a step (from the capabilities a flow can run), set each input of a step to a value or to another step's output, remove a step.
// The assistant builds flows with edit_flow; the person sees and edits the same graph. Every action is one of the view's own capabilities through execute_module, so every check
// there applies. Nothing the person is doing (the selected node, a half-typed value) is stored.
const fv=new Map();// panelId -> { flows, id, data, busy, msg, kind, sel, last, loaded }
const fvState=id=>{let s=fv.get(id);if(!s){s={flows:[],id:null,data:null,busy:false,msg:"",kind:"",sel:null,last:null,loaded:false,steps:null,adding:false,pick:"",showArchived:false};fv.set(id,s);}return s;};
const fvCmd=()=>"ui_"+Math.random().toString(16).slice(2,14);
async function fvCall(p,def,key,params){
 const r=await wbCall("execute_module",{module:p.module,capability:def.renderer.payload.actions[key],params});
 return r.data;
}
// Which flow a panel shows is remembered per viewer (a convenience: without storage the newest flow is shown).
const fvKey=p=>"estampes.flowview."+p.panelId;
const fvRemember=(p,id)=>{try{id?localStorage.setItem(fvKey(p),id):localStorage.removeItem(fvKey(p));}catch{}};
const fvRemembered=p=>{try{return localStorage.getItem(fvKey(p));}catch{return null;}};
const fvStepOf=(s,n)=>s.steps?.find(x=>x.module===n.module&&x.capability===n.capability)??null;
const fvDefault={number:0,integer:0,string:"",boolean:false};
// A step id from its capability: lowercase words, unique in the flow (node ids are at most 24 characters).
function fvNodeId(flow,cap){
 const base=(cap.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^[^a-z]+/,"").replace(/-+$/,"")||"step").slice(0,20);
 let id=base,i=1;while(flow.nodes.some(n=>n.id===id))id=base+"-"+(++i);
 return id;
}
async function fvLoadSteps(p,def){
 const s=fvState(p.panelId);
 if(!def?.renderer?.payload?.actions?.steps)return;
 try{s.steps=(await fvCall(p,def,"steps",{})).steps;}catch{s.steps=[];}
}
function fvDepths(flow){
 const depth={};for(const n of flow.nodes)depth[n.id]=0;
 // Edges are acyclic when the flow is valid; the loop is bounded anyway so an invalid (looping) flow still draws.
 for(let i=0;i<flow.nodes.length;i++)for(const e of flow.edges)depth[e.to.node]=Math.max(depth[e.to.node]??0,Math.min((depth[e.from.node]??0)+1,flow.nodes.length));
 return depth;
}
async function fvLoad(p){
 const def=wb.moduleViews?.[p.panelId],s=fvState(p.panelId);
 if(!def||def.unavailable||p.moduleState!=="enabled")return;
 try{
  const list=(await fvCall(p,def,"list",s.showArchived?{includeArchived:true}:{})).flows;
  if(!s.loaded&&!s.id)s.id=fvRemembered(p);
  const id=s.id&&list.some(f=>f.id===s.id)?s.id:list.slice().sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.id??null;
  const data=id?await fvCall(p,def,"get",{id}):null;
  const changed=JSON.stringify([s.flows,s.data])!==JSON.stringify([list,data])||!s.loaded;
  // Not while the person is typing in this view: the next refresh brings it.
  const el=wb.els.get(p.panelId),a=document.activeElement;
  if(changed&&s.loaded&&!s.forceDraw&&el?.contains(a)&&["INPUT","SELECT"].includes(a.tagName)&&a.type!=="checkbox")return;
  s.flows=list;s.id=id;s.data=data;
  if(s.sel&&!s.data?.flow.nodes.some(n=>n.id===s.sel))s.sel=null;
  s.loaded=true;
  if(s.kind==="error")s.msg="";
  if(changed)fvDraw(p);
 }catch(err){if(err.code==="stale")return;s.msg=t("wb.view.failed",{message:String(err.message||err)});s.kind="error";fvDraw(p);}
}
async function fvDo(p,def,fn,ok){
 const s=fvState(p.panelId);if(s.busy)return;
 s.busy=true;s.msg="";s.kind="";fvDraw(p);
 try{const r=await fn();s.msg=ok?ok(r):"";s.kind="";}
 catch(err){if(err.code!=="stale"){s.msg=t("wb.view.failed",{message:String(err.message||err)});s.kind="error";}}
 s.busy=false;s.forceDraw=true;try{await fvLoad(p);}finally{s.forceDraw=false;}fvDraw(p);
}
function fvEdit(p,def,ops){
 const s=fvState(p.panelId),cmd=fvCmd();
 return fvDo(p,def,async()=>{const r=await fvCall(p,def,"edit",{id:s.id,expectedRevision:s.data.revision,ops,commandId:cmd});s.last=cmd;return r;});
}
const fvNodeText=(n,r)=>{
 const d=r?.data!==undefined?JSON.stringify(r.data):r?.dataPreview;
 return d?String(d).slice(0,90):"";
};
// The input element for one literal of a step.
function fvEditor(p,def,s,node,k,uid){
 const params=node.params??{},v=params[k],off=s.busy||p.moduleState!=="enabled"||!!s.data?.archived;
 const set=val=>fvEdit(p,def,[{op:"set_params",id:node.id,paramsJson:JSON.stringify({...params,[k]:val})}]);
 let inp;
 if(typeof v==="boolean"){inp=h("input",{type:"checkbox",id:uid,disabled:off,onchange:e=>set(e.target.checked)});inp.checked=v;}
 else if(typeof v==="number"){inp=h("input",{type:"number",id:uid,disabled:off,step:"any",onchange:e=>{const x=Number(e.target.value);if(Number.isFinite(x))set(x);}});inp.value=String(v);}
 else if(typeof v==="string"){inp=h("input",{type:"text",id:uid,disabled:off,maxlength:200,onchange:e=>set(e.target.value)});inp.value=v;}
 else{inp=h("input",{type:"text",id:uid,disabled:off,onchange:e=>{try{set(JSON.parse(e.target.value));}catch{s.msg=t("wb.flow.notJson");s.kind="error";fvDraw(p);}}});inp.value=JSON.stringify(v);}
 return inp;
}
const fvUid=(p,node,k)=>"fv-"+p.panelId.replace(/[^a-z0-9]/gi,"")+"-"+node.id+"-"+k;
// A step's inputs. For each one: not set, a value typed here, or another step's output. A step whose module is not offered any more still
// shows (and keeps editing) the literals it has.
function fvParams(p,def,s,node){
 const flow=s.data.flow,info=fvStepOf(s,node),params=node.params??{},off=s.busy||p.moduleState!=="enabled"||!!s.data?.archived;
 if(!info){
  const keys=Object.keys(params);
  if(!keys.length)return h("p",{class:"wb-note"},t("wb.flow.noParams"));
  return h("div",{class:"fv-params"},keys.map(k=>h("div",{class:"mv-row"},h("label",{class:"mv-label",for:fvUid(p,node,k)},k),fvEditor(p,def,s,node,k,fvUid(p,node,k)))));
 }
 if(!info.inputs.length)return h("p",{class:"wb-note"},t("wb.flow.noParams"));
 const sources=flow.nodes.filter(n=>n.id!==node.id).flatMap(n=>(fvStepOf(s,n)?.outputs??[]).map(o=>({node:n.id,port:o.name})));
 return h("div",{class:"fv-params"},info.inputs.map(port=>{
  const k=port.name,uid=fvUid(p,node,k),edge=flow.edges.find(e=>e.to.node===node.id&&e.to.port===k),lit=Object.hasOwn(params,k);
  const cur=edge?edge.from.node+"."+edge.from.port:lit?"=literal":"";
  const canLit=lit||port.type in fvDefault;
  const opts=[h("option",{value:"",selected:cur===""},t("wb.flow.srcNone"))];
  if(canLit)opts.push(h("option",{value:"=literal",selected:cur==="=literal"},t("wb.flow.srcLiteral")));
  for(const src of sources){const v=src.node+"."+src.port;opts.push(h("option",{value:v,selected:cur===v},v));}
  const pick=h("select",{id:uid+"-src","aria-label":k,disabled:off,onchange:e=>{
   const v=e.target.value;if(v===cur)return;
   const ops=[];
   if(edge)ops.push({op:"disconnect",from:edge.from,to:edge.to});
   const rest={...params};
   if(lit&&v!=="=literal")delete rest[k];
   if(v==="=literal"&&!lit)rest[k]=fvDefault[port.type]??"";
   if(v!=="=literal"&&v){const[fn,fp]=[v.slice(0,v.indexOf(".")),v.slice(v.indexOf(".")+1)];ops.push({op:"connect",from:{node:fn,port:fp},to:{node:node.id,port:k}});}
   if(JSON.stringify(rest)!==JSON.stringify(params))ops.push({op:"set_params",id:node.id,paramsJson:JSON.stringify(rest)});
   if(ops.length)fvEdit(p,def,ops);
  }},opts);
  return h("div",{class:"mv-row fv-input","data-port":k},
   h("label",{class:"mv-label",for:uid+"-src"},k+(port.required?" *":"")+" · "+port.type),pick,
   lit?fvEditor(p,def,s,node,k,uid):null);
 }));
}
// The "add a step" row: choose from what the enabled modules offer; the new step starts with no inputs set.
function fvAdder(p,def,s){
 const off=s.busy||p.moduleState!=="enabled"||!!s.data?.archived,steps=s.steps??[];
 if(!steps.length)return h("p",{class:"wb-note"},t("wb.flow.noSteps"));
 const key=x=>x.module+" "+x.capability;
 if(!s.pick||!steps.some(x=>key(x)===s.pick))s.pick=key(steps[0]);
 return h("div",{class:"fv-add mv-row"},
  h("select",{"aria-label":t("wb.flow.pickStep"),disabled:off,onchange:e=>{s.pick=e.target.value;}},steps.map(x=>h("option",{value:key(x),selected:key(x)===s.pick},x.title+" — "+x.module+" · "+x.capability))),
  h("button",{class:"wb-mini mv-btn fv-add-go",type:"button",disabled:off,onclick:()=>{
   const x=steps.find(y=>key(y)===s.pick);if(!x)return;
   const id=fvNodeId(s.data.flow,x.capability);s.sel=id;s.adding=false;
   fvEdit(p,def,[{op:"add_node",node:{id,module:x.module,capability:x.capability}}]);
  }},t("wb.flow.addStepGo")));
}
function fvDraw(p){
 const el=wb.els.get(p.panelId);if(!el)return;
 const body=el.querySelector(".wb-body"),def=wb.moduleViews?.[p.panelId],s=fvState(p.panelId);
 const note=text=>body.replaceChildren(h("div",{class:"mv fv"},h("p",{class:"wb-note mv-note",role:"status"},text)));
 if(!def||def.unavailable)return note(t("wb.view.unavailable"));
 if(p.moduleState!=="enabled")return note(t("wb.view.moduleOff"));
 const d=s.data,off=s.busy,ro=off||!!d?.archived;
 const bar=h("div",{class:"mv-bar fv-bar"},
  h("select",{"aria-label":t("wb.flow.pick"),disabled:off||!s.flows.length,onchange:async e=>{s.id=e.target.value;fvRemember(p,s.id);s.sel=null;s.last=null;s.data=null;await fvLoad(p);}},
   s.flows.map(f=>h("option",{value:f.id,selected:f.id===s.id},f.name+(f.archived?" ("+t("wb.flow.archivedTag")+")":"")))),
  h("button",{class:"wb-mini mv-btn",type:"button",disabled:off,onclick:()=>fvDo(p,def,async()=>{const r=await fvCall(p,def,"create",{name:t("wb.flow.newName",{n:s.flows.length+1}),commandId:fvCmd()});s.id=r.id;fvRemember(p,r.id);s.sel=null;s.last=null;return r;})},t("wb.flow.new")),
  def.renderer.payload.actions.steps?h("button",{class:"wb-mini mv-btn fv-add-toggle",type:"button","aria-expanded":String(s.adding),disabled:ro||!d,onclick:async()=>{s.adding=!s.adding;if(s.adding)await fvLoadSteps(p,def);fvDraw(p);}},"+ "+t("wb.flow.addStep")):null,
  def.renderer.payload.actions.archive&&d?h("button",{class:"wb-mini mv-btn fv-archive",type:"button",disabled:s.busy||p.moduleState!=="enabled",onclick:()=>fvDo(p,def,async()=>{const r=await fvCall(p,def,"archive",{id:s.id,archived:!d.archived});s.sel=null;s.last=null;return r;})},d.archived?t("wb.flow.restore"):t("wb.flow.archive")):null,
  h("button",{class:"wb-mini mv-btn fv-run",type:"button",disabled:off||!d||!d.valid||d.archived,onclick:()=>fvDo(p,def,()=>fvCall(p,def,"run",{id:s.id}),r=>t("wb.flow.ran",{ran:r.ran.length,reused:r.reused.length,failed:r.failed.length,blocked:r.blocked.length})+(r.resultsKept?"":" "+t("wb.flow.notKept")))},"▶ "+t("wb.flow.run")),
  h("button",{class:"wb-mini mv-btn",type:"button",disabled:ro||!s.last,onclick:()=>fvDo(p,def,async()=>{const r=await fvCall(p,def,"undo",{id:s.id,of:s.last});s.last=null;return r;})},"↶ "+t("wb.flow.undo")),
  def.renderer.payload.actions.archive?h("label",{class:"fv-showarch"},h("input",{type:"checkbox",class:"fv-showarch-box",checked:s.showArchived,onchange:e=>{s.showArchived=e.target.checked;s.forceDraw=true;fvLoad(p).finally(()=>{s.forceDraw=false;});}}),t("wb.flow.showArchived")):null,
  h("button",{class:"wb-mini mv-refresh",type:"button",title:t("wb.view.refresh"),"aria-label":t("wb.view.refresh"),onclick:async()=>{await fvLoadSteps(p,def);fvLoad(p);}},"↻"));
 const parts=[bar];
 if(!s.loaded)parts.push(h("p",{class:"wb-note mv-note",role:"status"},"…"));
 else if(!d)parts.push(h("p",{class:"wb-note mv-note"},t("wb.flow.none")));
 else{
  const flow=d.flow,depth=fvDepths(flow),cols=[];
  for(const n of flow.nodes)(cols[depth[n.id]]??=[]).push(n);
  parts.push(h("p",{class:"wb-note fv-state","data-valid":String(d.valid)},d.valid?t("wb.flow.valid",{rev:d.revision}):t("wb.flow.problems",{n:(d.errors??[]).length,rev:d.revision})));
  if(!d.valid)parts.push(h("ul",{class:"fv-errors"},(d.errors??[]).slice(0,8).map(e=>h("li",{},e.path+": "+e.message))));
  if(s.adding)parts.push(fvAdder(p,def,s));
  if(!flow.nodes.length)parts.push(h("p",{class:"wb-note"},t("wb.flow.empty")));
  parts.push(h("div",{class:"fv-cols"},cols.filter(Boolean).map((col,i)=>h("div",{class:"fv-col","data-depth":String(i)},col.map(n=>{
   const r=d.results?.[n.id],pl=d.plan?.[n.id],status=r?.status==="error"?"error":(pl?.status??r?.status??"stale");
   return h("button",{class:"fv-node",type:"button","data-node":n.id,"data-status":status,"aria-pressed":String(s.sel===n.id),onclick:()=>{s.sel=s.sel===n.id?null:n.id;fvDraw(p);}},
    h("span",{class:"fv-id"},n.id),h("span",{class:"fv-cap"},n.module+" · "+n.capability),
    h("span",{class:"fv-badge"},t("wb.flow.status."+status)),h("span",{class:"fv-out"},fvNodeText(n,r)));
  })))));
  if(flow.edges.length)parts.push(h("ul",{class:"fv-edges","aria-label":t("wb.flow.connections")},flow.edges.map(e=>h("li",{},e.from.node+"."+e.from.port+" → "+e.to.node+"."+e.to.port))));
  const sel=flow.nodes.find(n=>n.id===s.sel);
  if(sel){
   const r=d.results?.[sel.id];
   parts.push(h("div",{class:"fv-detail",role:"group","aria-label":sel.id},
    h("h4",{},sel.id+" · "+sel.module+" · "+sel.capability),
    fvParams(p,def,s,sel),
    r?.message?h("p",{class:"wb-note","data-kind":"error"},r.message):null,
    r?.data!==undefined||r?.dataPreview?h("pre",{class:"fv-result"},r.data!==undefined?JSON.stringify(r.data,null,1):r.dataPreview):null,
    h("button",{class:"wb-mini mv-btn",type:"button",disabled:ro,onclick:()=>{const id=sel.id;s.sel=null;fvEdit(p,def,[{op:"remove_node",id}]);}},t("wb.flow.remove"))));
  }
 }
 parts.push(h("p",{class:"wb-note mv-note","data-kind":s.kind,role:"status","aria-live":"polite"},s.msg));
 body.replaceChildren(h("div",{class:"mv fv","aria-busy":String(s.busy)},parts));
}
function renderFlowView(p){
 const s=fvState(p.panelId);
 fvDraw(p);
 if(!s.loaded&&!s.loading){s.loading=true;fvLoadSteps(p,wb.moduleViews?.[p.panelId]??{renderer:{payload:{actions:{}}}}).then(()=>fvLoad(p)).finally(()=>{s.loading=false;});}
}
