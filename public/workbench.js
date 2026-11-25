// ===== SurfaceLayoutController: panels, window manager, layout sync =====
// The calculator panels (public/calculator.js) are inlined right after this file.
// This file is inlined at the end of visual-surface.html's module script, so
// it shares the widget's scope (request, imageId, ws, status, setObjects,
// render ...). The pure layout rules (clampRect, snapRect, applyOp,
// reconcile, profileFor ...) are inlined from src/surface/geometry.js.
// Everything is drawn with createElement/textContent: server and module text
// never reaches innerHTML, so a result can never inject markup or script.
const wb={surface:null,notebooks:{},moduleViews:{},profile:"desktop",key:null,loading:false,els:new Map(),calc:new Map(),chain:Promise.resolve(),drag:null,menu:null,domain:[-10,10]};
const wbEl=document.querySelector("#wb"),wbArea=document.querySelector("#wb-area"),wbBar=document.querySelector("#wb-bar");
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);
 for(const [k,v] of Object.entries(attrs??{})){if(v===false||v==null)continue;if(k==="class")e.className=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else if(v===true)e.setAttribute(k,"");else e.setAttribute(k,String(v));}
 for(const c of kids.flat()){if(c==null||c===false)continue;e.append(c.nodeType?c:document.createTextNode(String(c)));}
 return e;};
const uuid=()=>(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2)).slice(0,40);
const wbKeyNow=()=>ws?ws.id:imageId;
const wbArgs=()=>ws?{workspaceId:ws.id}:{imageId};
const wbProfileNow=()=>profileFor(window.innerWidth,1000);
// An answer that comes back after the widget moved to another canvas belongs
// to the old one: it is refused (code "stale") so no caller applies it.
async function wbCall(name,args){
 const key=wbKeyNow();
 const result=await request("tools/call",{name,arguments:args});
 if(key!==wbKeyNow())throw Object.assign(Error(t("wb.err.stale")),{code:"stale"});
 const r=result?.structuredContent;
 if(result?.isError||!r)throw Object.assign(Error(r?.message||result?.content?.[0]?.text||t("wb.err.failed")),{code:r?.code});
 return r;
}
function wbSync(){
 if(!ready)return;const key=wbKeyNow();
 if(!key||key===wb.key)return;
 wb.key=key;wbLoad();
}
// Rotating a tablet or resizing the window switches to that device's own layout.
let wbResizeTimer=0;
window.addEventListener("resize",()=>{clearTimeout(wbResizeTimer);wbResizeTimer=setTimeout(()=>{
 if(!wb.surface)return;const next=wbProfileNow();if(next===wb.profile)return;wb.profile=next;renderWB();},150);});
async function wbLoad(){
 const key=wb.key;
 try{const r=await wbCall("surface_get_state",wbArgs());if(key===wb.key)setSurface(r);}
 catch(err){if(key!==wb.key)return;wbEl.hidden=false;wbBar.replaceChildren(h("span",{class:"wb-note"},t("wb.err.unavailable",{message:String(err.message||err)})));}
}
function setSurface(r){
 if(r.kind!=="estampes.surface")return;
 wb.surface={surfaceId:r.surfaceId,revision:r.revision,panels:r.panels,layouts:r.layouts,available:r.available};
 wb.notebooks=r.notebooks??{};
 wb.moduleViews=r.moduleViews??{};
 wb.profile=wbProfileNow();
 renderWB();
}
// Layout and panel changes are serialised, carry the revision they were
// based on and a key, and retry once on top of a newer revision (a layout
// move never overwrites someone else's notebook; those have their own revisions).
// The retry runs inside the same queued job: queueing it behind the current
// job would make the job wait for itself and stall every later change.
function wbApply(ops,{retry=true}={}){
 const attempt=async(again)=>{
  const key=uuid(),canvas=wb.key;
  try{
   const r=await wbCall("surface_apply",{...wbArgs(),expectedRevision:wb.surface.revision,idempotencyKey:key,ops});
   // The widget moved to another canvas meanwhile: this answer is the old one's.
   if(canvas!==wb.key)return;
   setSurface(r);return r;
  }catch(err){
   if(canvas!==wb.key)return;
   if(again&&/changed since revision/.test(String(err.message))){await wbLoad();return attempt(false);}
   status.textContent=t("wb.err.notApplied",{message:String(err.message||err)});await wbLoad();
  }
 };
 const run=()=>wb.surface?attempt(retry):undefined;
 wb.chain=wb.chain.then(run,run);return wb.chain;
}
const wbLayout=(layout,profile=wb.profile)=>wbApply([{op:"layout",profile,layout}]);
const openPanels=()=>(wb.surface?.panels??[]).filter(p=>p.open);
const layoutNow=()=>wb.surface.layouts[wb.profile];

// ---------- window manager ----------
function renderWB(){
 if(!wb.surface)return;
 wbEl.hidden=false;
 const open=openPanels(),lay=layoutNow(),mobile=wb.profile==="mobile";
 const solo=open.length<=1;
 wbEl.classList.toggle("solo",solo);wbEl.classList.toggle("mobile",mobile);wbEl.classList.toggle("windows",!solo&&!mobile);
 // Panels that closed leave the DOM; the canvas panel is static markup.
 for(const [id,el] of wb.els){if(!open.some(p=>p.panelId===id)&&id!=="p:canvas"){el.remove();wb.els.delete(id);wb.calc.delete(id);mv.delete(id);}}
 for(const p of open){
  if(!wb.els.has(p.panelId))wb.els.set(p.panelId,p.panelId==="p:canvas"?canvasPanel(p):buildPanel(p));
  const el=wb.els.get(p.panelId);if(el.parentNode!==wbArea)wbArea.append(el);
  decoratePanel(el,p);
  const pl=lay.placements[p.panelId];
  if(solo){el.style.cssText="";el.hidden=false;continue;}
  if(mobile){el.style.cssText="";el.hidden=lay.active!==p.panelId;continue;}
  const rect=pl.mode==="maximized"?{x:0,y:0,w:1,h:1}:pl.rect;
  el.hidden=pl.mode==="minimized";
  el.style.left=rect.x*100+"%";el.style.top=rect.y*100+"%";el.style.width=rect.w*100+"%";el.style.height=rect.h*100+"%";el.style.zIndex=String(pl.z);
 }
 renderBar(open,lay,mobile,solo);
 for(const p of open)if(p.kind==="calculator")renderCalc(p);
 for(const p of open)if(p.kind==="module-view")renderModuleView(p);
}
function decoratePanel(el,p){
 const lay=layoutNow(),pl=lay.placements[p.panelId];
 const title=el.querySelector(".wb-title");if(title)title.textContent=p.title==="Canvas"?t("wb.canvasAndGraph"):wbTitle(p);
 const max=el.querySelector("[data-act=maximize]");if(max){max.setAttribute("aria-pressed",String(pl?.mode==="maximized"));max.title=pl?.mode==="maximized"?t("wb.restoreSize"):t("wb.maximize.title");}
 el.dataset.state=p.moduleState??"enabled";
 const solo=openPanels().length<=1;el.querySelector(".wb-head").hidden=solo&&p.panelId==="p:canvas";
}
function renderBar(open,lay,mobile,solo){
 const bar=[];
 if(mobile&&!solo){
  const tabs=h("div",{class:"wb-tabs",role:"tablist","aria-label":t("wb.tabs.label")});
  lay.order.filter(id=>open.some(p=>p.panelId===id)).forEach((id,i,arr)=>{
   const p=open.find(x=>x.panelId===id);
   tabs.append(h("button",{role:"tab","aria-selected":String(lay.active===id),class:"wb-tab",onclick:()=>{wbLayout({op:"focus",panelId:id});}},wbTitle(p)));
  });
  const a=lay.order.indexOf(lay.active);
  tabs.append(h("button",{class:"wb-mini",title:t("wb.tab.moveBackTitle"),"aria-label":t("wb.tab.moveBack"),disabled:a<=0,onclick:()=>wbReorder(-1)},"◀"),
   h("button",{class:"wb-mini",title:t("wb.tab.moveForwardTitle"),"aria-label":t("wb.tab.moveForward"),disabled:a<0||a>=lay.order.length-1,onclick:()=>wbReorder(1)},"▶"));
  bar.push(tabs);
 }
 // Launcher: panels the enabled modules offer.
 const launch=h("div",{class:"wb-launch",role:"group","aria-label":t("wb.launch.label")});
 for(const a of wb.surface.available){
  if(a.kind==="graph"){
   // Graph is the canvas panel's own view: this brings the canvas forward (also from minimized or under a maximized window).
   launch.append(h("button",{class:"wb-graph","data-graph":"show",title:t("wb.graph.showTitle"),onclick:()=>wbApply([{op:"open-panel",module:a.module,panel:a.panel}])},t("wb.graph.show")));
   continue;
  }
  if(a.kind!=="calculator"&&a.kind!=="module-view")continue;
  const openCount=wb.surface.panels.filter(p=>p.module===a.module&&p.panel===a.panel&&p.open).length;
  const full=openCount>=a.maxInstances,off=!a.enabled;
  launch.append(h("button",{class:"wb-open",disabled:off||full,title:off?t("wb.launch.disabled",{module:a.moduleName}):full?t("wb.launch.alreadyOpen"):t("wb.launch.open",{title:a.title}),onclick:()=>wbApply([{op:"open-panel",module:a.module,panel:a.panel}])},
   t("wb.launch.button",{title:a.kind==="calculator"?t("wb.calculator"):a.title})+(off?t("wb.launch.notEnabled"):"")));
 }
 // The canvas (photo + Graph) is always open; when it is minimized or covered
 // by a maximized window this button lays the windows out side by side again.
 const cv=open.find(p=>p.kind==="canvas"),cpl=cv&&lay.placements[cv.panelId];
 const covered=cv&&!mobile&&(cpl?.mode==="minimized"||open.some(p=>p!==cv&&lay.placements[p.panelId]?.mode==="maximized"));
 if(covered)launch.prepend(h("button",{class:"wb-open",title:t("wb.launch.recallTitle"),onclick:()=>wbLayout({op:"reset",profile:wb.profile,panelIds:open.map(p=>p.panelId)})},t("wb.launch.recall")));
 bar.push(launch);
 for(const p of open){const pl=lay.placements[p.panelId];
  if(!mobile&&pl?.mode==="minimized"&&p.kind!=="canvas")bar.push(h("button",{class:"wb-chip",onclick:()=>wbLayout({op:"restore",panelId:p.panelId})},t("wb.restore",{title:wbTitle(p)})));}
 if(!solo){bar.push(h("button",{class:"wb-chip",title:t("wb.resetTitle"),onclick:()=>{window.dispatchEvent(new Event("estampes-wb-reset-height"));wbLayout({op:"reset",profile:wb.profile,panelIds:openPanels().map(p=>p.panelId)})}},t("wb.reset")));}
 wbBar.replaceChildren(...bar);
}
const wbTitle=p=>p.kind==="canvas"?t("wb.canvas"):p.kind==="calculator"?t("wb.calculator")+(/(\d+)$/.exec(p.panelId)?.[1]>1?" "+/(\d+)$/.exec(p.panelId)[1]:""):p.title;
function wbReorder(dir){
 const lay=layoutNow(),ids=lay.order.filter(id=>openPanels().some(p=>p.panelId===id)),i=ids.indexOf(lay.active),j=i+dir;
 if(i<0||j<0||j>=ids.length)return;const next=[...ids];[next[i],next[j]]=[next[j],next[i]];
 wbLayout({op:"reorder",order:next});
}
// The photo/graph canvas is static markup; it moves into a panel frame once.
function canvasPanel(p){const main=document.querySelector("#panel-canvas"),el=buildPanel(p);el.querySelector(".wb-body").append(main);return el;}
function buildPanel(p){
 const head=h("div",{class:"wb-head"},
  h("span",{class:"wb-grip",tabindex:"0",role:"button","aria-label":t("wb.grip.label",{title:wbTitle(p)}),"aria-describedby":"wb-help",title:t("wb.grip.title")},"⠿ ",h("span",{class:"wb-title"},wbTitle(p))),
  h("button",{class:"wb-mini","data-act":"menu","aria-haspopup":"menu",title:t("wb.menu.title"),"aria-label":t("wb.menu.label")},"☰"),
  h("button",{class:"wb-mini","data-act":"minimize",title:t("wb.minimize.title"),"aria-label":t("wb.minimize.label")},"–"),
  h("button",{class:"wb-mini","data-act":"maximize",title:t("wb.maximize.title"),"aria-label":t("wb.maximize.label"),"aria-pressed":"false"},"▢"),
  p.kind!=="canvas"?h("button",{class:"wb-mini","data-act":"close",title:t("wb.close.title"),"aria-label":t("wb.close.label")},"✕"):null);
 const body=h("div",{class:"wb-body"});
 const el=h("section",{class:"wb-panel","data-panel":p.panelId,"aria-label":wbTitle(p)},head,body,
  h("span",{class:"wb-resize r","data-edge":"e","aria-hidden":"true"}),h("span",{class:"wb-resize b","data-edge":"s","aria-hidden":"true"}),h("span",{class:"wb-resize rb","data-edge":"se","aria-hidden":"true"}));
 wirePanel(el,p.panelId);
 return el;
}
function wirePanel(el,id){
 const head=el.querySelector(".wb-head"),grip=el.querySelector(".wb-grip");
 el.addEventListener("pointerdown",()=>{const z=Math.max(0,...[...wb.els.values()].map(e=>+e.style.zIndex||0))+1;if(openPanels().length>1)el.style.zIndex=String(z);},true);
 head.addEventListener("click",e=>{
  const act=e.target.closest("[data-act]")?.dataset.act;if(!act)return;
  if(act==="close")wbApply([{op:"close-panel",panelId:id}]);
  else if(act==="minimize")wbLayout({op:"minimize",panelId:id});
  else if(act==="maximize")wbLayout(layoutNow().placements[id]?.mode==="maximized"?{op:"restore",panelId:id}:{op:"maximize",panelId:id});
  else if(act==="menu")openMenu(id,e.target.closest("[data-act]"));
 });
 // Dragging starts only on the grip, never inside inputs, canvases or results.
 grip.addEventListener("pointerdown",e=>{if(e.button!==0||wb.profile==="mobile"||openPanels().length<=1)return;startDrag(e,id,"move",el);});
 for(const g of el.querySelectorAll(".wb-resize"))g.addEventListener("pointerdown",e=>{if(e.button!==0||wb.profile==="mobile")return;startDrag(e,id,g.dataset.edge,el);});
 grip.addEventListener("keydown",e=>{
  if(!e.altKey||!e.key.startsWith("Arrow")||wb.profile==="mobile")return;
  e.preventDefault();const pl=layoutNow().placements[id];if(!pl)return;
  const step=0.02,d={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];
  const r={...pl.rect};
  if(e.shiftKey){r.w+=d[0];r.h+=d[1];}else{r.x+=d[0];r.y+=d[1];}
  wbLayout({op:"arrange",panelId:id,rect:clampRect(r),dock:"free",snap:false});
 });
 grip.addEventListener("dblclick",()=>wbLayout(layoutNow().placements[id]?.mode==="maximized"?{op:"restore",panelId:id}:{op:"maximize",panelId:id}));
}
function startDrag(e,id,edge,el){
 const area=wbArea.getBoundingClientRect(),pl=layoutNow().placements[id];if(!pl||!area.width)return;
 e.preventDefault();e.target.setPointerCapture?.(e.pointerId);
 const start={x:e.clientX,y:e.clientY,rect:{...pl.rect}};
 const others=Object.entries(layoutNow().placements).filter(([k,p])=>k!==id&&p.mode!=="minimized").map(([,p])=>p.rect);
 let last=pl.rect;
 const move=ev=>{
  const dx=(ev.clientX-start.x)/area.width,dy=(ev.clientY-start.y)/area.height,r={...start.rect};
  if(edge==="move"){r.x+=dx;r.y+=dy;}else{if(edge.includes("e"))r.w+=dx;if(edge.includes("s"))r.h+=dy;}
  last=snapRect(clampRect(r),others);
  el.style.left=last.x*100+"%";el.style.top=last.y*100+"%";el.style.width=last.w*100+"%";el.style.height=last.h*100+"%";
 };
 const up=ev=>{
  e.target.removeEventListener("pointermove",move);e.target.removeEventListener("pointerup",up);e.target.removeEventListener("pointercancel",up);
  e.target.releasePointerCapture?.(ev.pointerId);
  // One commit when the pointer is released, not one per frame.
  if(JSON.stringify(last)!==JSON.stringify(pl.rect))wbLayout({op:"arrange",panelId:id,rect:last,dock:"free",snap:false});
 };
 e.target.addEventListener("pointermove",move);e.target.addEventListener("pointerup",up);e.target.addEventListener("pointercancel",up);
}
function openMenu(id,anchor){
 closeMenu();
 const item=(label,layout)=>h("button",{role:"menuitem",onclick:()=>{closeMenu();wbLayout(layout);}},label);
 const menu=h("div",{class:"wb-menu",role:"menu","aria-label":t("wb.menu.title")},
  item(t("wb.dock.left"),{op:"arrange",panelId:id,rect:{x:0,y:0,w:0.5,h:1},dock:"left"}),
  item(t("wb.dock.right"),{op:"arrange",panelId:id,rect:{x:0.5,y:0,w:0.5,h:1},dock:"right"}),
  item(t("wb.dock.top"),{op:"arrange",panelId:id,rect:{x:0,y:0,w:1,h:0.5},dock:"top"}),
  item(t("wb.dock.bottom"),{op:"arrange",panelId:id,rect:{x:0,y:0.5,w:1,h:0.5},dock:"bottom"}),
  item(t("wb.dock.free"),{op:"arrange",panelId:id,rect:{x:0.3,y:0.1,w:0.45,h:0.7},dock:"free"}),
  item(t("wb.focus"),{op:"focus",panelId:id}));
 anchor.after(menu);wb.menu=menu;menu.querySelector("button").focus();
 menu.addEventListener("keydown",ev=>{
  const bs=[...menu.querySelectorAll("button")],i=bs.indexOf(document.activeElement);
  if(ev.key==="Escape"){closeMenu();anchor.focus();}
  else if(ev.key==="ArrowDown"){ev.preventDefault();bs[(i+1)%bs.length].focus();}
  else if(ev.key==="ArrowUp"){ev.preventDefault();bs[(i-1+bs.length)%bs.length].focus();}
 });
}
function closeMenu(){wb.menu?.remove();wb.menu=null;}
document.addEventListener("pointerdown",e=>{if(wb.menu&&!wb.menu.contains(e.target))closeMenu();});
i18nOnChange(()=>{if(wb.surface)renderWB();});
new ResizeObserver(()=>{if(!wb.surface)return;const p=wbProfileNow();if(p!==wb.profile){wb.profile=p;renderWB();}}).observe(document.body);
// One grip, one height, shared by every layout (window mode sets the panel area, the single canvas sets the picture). A grip under the panel area: ChatGPT gives an inline widget no resize handle, so the
// area height is the user's to set. Drag to resize, double-click to go back to the default.
{
 const KEY="estampes.wbHeight",MIN=320,MAX=3000;
 const grip=h("div",{id:"wb-height-grip",role:"separator","aria-orientation":"horizontal",tabindex:"0",title:t("wb.height.title")});
 wbArea.after(grip);
 i18nOnChange(()=>{grip.title=t("wb.height.title");});
 // The height lives in a CSS variable that only the window layout reads, so going back to the
 // single-canvas or phone layout never inherits it.
 const apply=px=>{if(px==null)wbEl.style.removeProperty("--wb-h");else wbEl.style.setProperty("--wb-h",Math.round(Math.min(MAX,Math.max(MIN,px)))+"px");};
 const save=()=>{try{const v=wbEl.style.getPropertyValue("--wb-h");v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch{}};
 window.addEventListener("estampes-wb-reset-height",()=>{apply(null);save()});
 try{const v=parseFloat(localStorage.getItem(KEY));if(v>0)apply(v)}catch{}
 let drag=null;
 const syncGrip=()=>{const el=wbEl.classList.contains("windows")?wbArea:document.querySelector("#surface");grip.style.visibility=el&&el.getBoundingClientRect().height>0?"":"hidden"};
 new ResizeObserver(syncGrip).observe(wbEl);syncGrip();
 const current=()=>{const el=wbEl.classList.contains("windows")?wbArea:document.querySelector("#surface");return el.getBoundingClientRect().height};
 grip.addEventListener("pointerdown",e=>{const h0=current();if(!(h0>0))return;drag={y:e.clientY,h:h0};grip.setPointerCapture(e.pointerId);e.preventDefault();});
 grip.addEventListener("pointermove",e=>{if(drag)apply(drag.h+e.clientY-drag.y);});
 const end=()=>{if(drag){drag=null;save()}};
 grip.addEventListener("pointerup",end);grip.addEventListener("pointercancel",end);
 grip.addEventListener("dblclick",()=>{apply(null);save()});
 grip.addEventListener("keydown",e=>{if(e.key!=="ArrowUp"&&e.key!=="ArrowDown")return;e.preventDefault();const h0=current();if(!(h0>0))return;apply(h0+(e.key==="ArrowDown"?40:-40));save();});
}
