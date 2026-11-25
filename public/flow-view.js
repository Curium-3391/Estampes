// ===== Flow view: the `flow-graph` renderer (#86 F2) =====
// Inlined after module-view.js in the same scope (wb, h, t, wbCall, wbLoad, mv ...). Draws one flow as columns of node cards (a node sits one
// column after the nodes that feed it) with its connections listed as text, and offers what a person can do with it: run it, undo the last
// change, change a node's literal inputs, remove a node. Building a flow (adding nodes, connecting them) is done by the assistant with
// edit_flow; the person sees the same graph. Every action is one of the view's own capabilities through execute_module, so every check
// there applies. Nothing the person is doing (the selected node, a half-typed value) is stored.
const fv=new Map();// panelId -> { flows, id, data, busy, msg, kind, sel, last, loaded }
const fvState=id=>{let s=fv.get(id);if(!s){s={flows:[],id:null,data:null,busy:false,msg:"",kind:"",sel:null,last:null,loaded:false};fv.set(id,s);}return s;};
const fvCmd=()=>"ui_"+Math.random().toString(16).slice(2,14);
async function fvCall(p,def,key,params){
 const r=await wbCall("execute_module",{module:p.module,capability:def.renderer.payload.actions[key],params});
 return r.data;
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
  const list=(await fvCall(p,def,"list",{})).flows;
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
function fvParams(p,def,s,node){
 const params=node.params??{},keys=Object.keys(params);
 if(!keys.length)return h("p",{class:"wb-note"},t("wb.flow.noParams"));
 return h("div",{class:"fv-params"},keys.map(k=>{
  const v=params[k],uid="fv-"+p.panelId.replace(/[^a-z0-9]/gi,"")+"-"+node.id+"-"+k,off=s.busy||p.moduleState!=="enabled";
  const set=val=>fvEdit(p,def,[{op:"set_params",id:node.id,paramsJson:JSON.stringify({...params,[k]:val})}]);
  let inp;
  if(typeof v==="boolean"){inp=h("input",{type:"checkbox",id:uid,disabled:off,onchange:e=>set(e.target.checked)});inp.checked=v;}
  else if(typeof v==="number"){inp=h("input",{type:"number",id:uid,disabled:off,step:"any",onchange:e=>{const x=Number(e.target.value);if(Number.isFinite(x))set(x);}});inp.value=String(v);}
  else if(typeof v==="string"){inp=h("input",{type:"text",id:uid,disabled:off,maxlength:200,onchange:e=>set(e.target.value)});inp.value=v;}
  else{inp=h("input",{type:"text",id:uid,disabled:off,onchange:e=>{try{set(JSON.parse(e.target.value));}catch{s.msg=t("wb.flow.notJson");s.kind="error";fvDraw(p);}}});inp.value=JSON.stringify(v);}
  return h("div",{class:"mv-row"},h("label",{class:"mv-label",for:uid},k),inp);
 }));
}
function fvDraw(p){
 const el=wb.els.get(p.panelId);if(!el)return;
 const body=el.querySelector(".wb-body"),def=wb.moduleViews?.[p.panelId],s=fvState(p.panelId);
 const note=text=>body.replaceChildren(h("div",{class:"mv fv"},h("p",{class:"wb-note mv-note",role:"status"},text)));
 if(!def||def.unavailable)return note(t("wb.view.unavailable"));
 if(p.moduleState!=="enabled")return note(t("wb.view.moduleOff"));
 const d=s.data,off=s.busy;
 const bar=h("div",{class:"mv-bar fv-bar"},
  h("select",{"aria-label":t("wb.flow.pick"),disabled:off||!s.flows.length,onchange:async e=>{s.id=e.target.value;s.sel=null;s.last=null;s.data=null;await fvLoad(p);}},
   s.flows.map(f=>h("option",{value:f.id,selected:f.id===s.id},f.name))),
  h("button",{class:"wb-mini mv-btn",type:"button",disabled:off,onclick:()=>fvDo(p,def,async()=>{const r=await fvCall(p,def,"create",{name:t("wb.flow.newName",{n:s.flows.length+1}),commandId:fvCmd()});s.id=r.id;s.sel=null;s.last=null;return r;})},t("wb.flow.new")),
  h("button",{class:"wb-mini mv-btn fv-run",type:"button",disabled:off||!d||!d.valid,onclick:()=>fvDo(p,def,()=>fvCall(p,def,"run",{id:s.id}),r=>t("wb.flow.ran",{ran:r.ran.length,reused:r.reused.length,failed:r.failed.length,blocked:r.blocked.length})+(r.resultsKept?"":" "+t("wb.flow.notKept")))},"▶ "+t("wb.flow.run")),
  h("button",{class:"wb-mini mv-btn",type:"button",disabled:off||!s.last,onclick:()=>fvDo(p,def,async()=>{const r=await fvCall(p,def,"undo",{id:s.id,of:s.last});s.last=null;return r;})},"↶ "+t("wb.flow.undo")),
  h("button",{class:"wb-mini mv-refresh",type:"button",title:t("wb.view.refresh"),"aria-label":t("wb.view.refresh"),onclick:()=>fvLoad(p)},"↻"));
 const parts=[bar];
 if(!s.loaded)parts.push(h("p",{class:"wb-note mv-note",role:"status"},"…"));
 else if(!d)parts.push(h("p",{class:"wb-note mv-note"},t("wb.flow.none")));
 else{
  const flow=d.flow,depth=fvDepths(flow),cols=[];
  for(const n of flow.nodes)(cols[depth[n.id]]??=[]).push(n);
  parts.push(h("p",{class:"wb-note fv-state","data-valid":String(d.valid)},d.valid?t("wb.flow.valid",{rev:d.revision}):t("wb.flow.problems",{n:(d.errors??[]).length,rev:d.revision})));
  if(!d.valid)parts.push(h("ul",{class:"fv-errors"},(d.errors??[]).slice(0,8).map(e=>h("li",{},e.path+": "+e.message))));
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
    h("button",{class:"wb-mini mv-btn",type:"button",disabled:off,onclick:()=>{const id=sel.id;s.sel=null;fvEdit(p,def,[{op:"remove_node",id}]);}},t("wb.flow.remove"))));
  }
 }
 parts.push(h("p",{class:"wb-note mv-note","data-kind":s.kind,role:"status","aria-live":"polite"},s.msg));
 body.replaceChildren(h("div",{class:"mv fv","aria-busy":String(s.busy)},parts));
}
function renderFlowView(p){
 const s=fvState(p.panelId);
 fvDraw(p);
 if(!s.loaded&&!s.loading){s.loading=true;fvLoad(p).finally(()=>{s.loading=false;});}
}
