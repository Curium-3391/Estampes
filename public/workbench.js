// ===== SurfaceLayoutController: panels, window manager, layout sync =====
// The calculator panels (public/calculator.js) are inlined right after this file.
// This file is inlined at the end of visual-surface.html's module script, so
// it shares the widget's scope (request, imageId, ws, status, setObjects,
// render ...). The pure layout rules (clampRect, snapRect, applyOp,
// reconcile, profileFor ...) are inlined from src/surface/geometry.js.
// Everything is drawn with createElement/textContent: server and module text
// never reaches innerHTML, so a result can never inject markup or script.
const wb={surface:null,notebooks:{},profile:"desktop",key:null,loading:false,els:new Map(),calc:new Map(),chain:Promise.resolve(),drag:null,menu:null,domain:[-10,10]};
const wbEl=document.querySelector("#wb"),wbArea=document.querySelector("#wb-area"),wbBar=document.querySelector("#wb-bar");
const h=(tag,attrs={},...kids)=>{const e=document.createElement(tag);
 for(const [k,v] of Object.entries(attrs??{})){if(v===false||v==null)continue;if(k==="class")e.className=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else if(v===true)e.setAttribute(k,"");else e.setAttribute(k,String(v));}
 for(const c of kids.flat()){if(c==null||c===false)continue;e.append(c.nodeType?c:document.createTextNode(String(c)));}
 return e;};
const uuid=()=>(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2)).slice(0,40);
const wbKeyNow=()=>ws?ws.id:imageId;
const wbArgs=()=>ws?{workspaceId:ws.id}:{imageId};
const wbProfileNow=()=>profileFor(window.innerWidth,1000);
async function wbCall(name,args){
 const result=await request("tools/call",{name,arguments:args});
 const r=result?.structuredContent;
 if(result?.isError||!r)throw Object.assign(Error(r?.message||result?.content?.[0]?.text||"失敗"),{code:r?.code});
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
 try{setSurface(await wbCall("surface_get_state",wbArgs()));}
 catch(err){wbEl.hidden=false;wbBar.replaceChildren(h("span",{class:"wb-note"},"工作台暫時無法使用："+String(err.message||err)));}
}
function setSurface(r){
 if(r.kind!=="estampes.surface")return;
 wb.surface={surfaceId:r.surfaceId,revision:r.revision,panels:r.panels,layouts:r.layouts,available:r.available};
 wb.notebooks=r.notebooks??{};
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
  const key=uuid();
  try{
   const r=await wbCall("surface_apply",{...wbArgs(),expectedRevision:wb.surface.revision,idempotencyKey:key,ops});
   setSurface(r);return r;
  }catch(err){
   if(again&&/changed since revision/.test(String(err.message))){await wbLoad();return attempt(false);}
   status.textContent="沒有套用："+String(err.message||err);await wbLoad();
  }
 };
 const run=()=>attempt(retry);
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
 for(const [id,el] of wb.els){if(!open.some(p=>p.panelId===id)&&id!=="p:canvas"){el.remove();wb.els.delete(id);wb.calc.delete(id);}}
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
}
function decoratePanel(el,p){
 const lay=layoutNow(),pl=lay.placements[p.panelId];
 const title=el.querySelector(".wb-title");if(title)title.textContent=p.title==="Canvas"?"畫布與函數圖":wbTitle(p);
 const max=el.querySelector("[data-act=maximize]");if(max){max.setAttribute("aria-pressed",String(pl?.mode==="maximized"));max.title=pl?.mode==="maximized"?"還原大小":"在工作台內最大化";}
 el.dataset.state=p.moduleState??"enabled";
 const solo=openPanels().length<=1;el.querySelector(".wb-head").hidden=solo&&p.panelId==="p:canvas";
}
function renderBar(open,lay,mobile,solo){
 const bar=[];
 if(mobile&&!solo){
  const tabs=h("div",{class:"wb-tabs",role:"tablist","aria-label":"面板"});
  lay.order.filter(id=>open.some(p=>p.panelId===id)).forEach((id,i,arr)=>{
   const p=open.find(x=>x.panelId===id);
   tabs.append(h("button",{role:"tab","aria-selected":String(lay.active===id),class:"wb-tab",onclick:()=>{wbLayout({op:"focus",panelId:id});}},wbTitle(p)));
  });
  const a=lay.order.indexOf(lay.active);
  tabs.append(h("button",{class:"wb-mini",title:"把這個分頁往前移","aria-label":"往前移",disabled:a<=0,onclick:()=>wbReorder(-1)},"◀"),
   h("button",{class:"wb-mini",title:"把這個分頁往後移","aria-label":"往後移",disabled:a<0||a>=lay.order.length-1,onclick:()=>wbReorder(1)},"▶"));
  bar.push(tabs);
 }
 // Launcher: panels the enabled modules offer.
 const launch=h("div",{class:"wb-launch",role:"group","aria-label":"開啟面板"});
 for(const a of wb.surface.available){
  if(a.kind!=="calculator")continue;
  const openCount=wb.surface.panels.filter(p=>p.module===a.module&&p.panel===a.panel&&p.open).length;
  const full=openCount>=a.maxInstances,off=!a.enabled;
  launch.append(h("button",{class:"wb-open",disabled:off||full,title:off?"到 Store 啟用「"+a.moduleName+"」後才能使用":full?"已經開啟":"開啟"+a.title,onclick:()=>wbApply([{op:"open-panel",module:a.module,panel:a.panel}])},
   "＋ "+(a.kind==="calculator"?"科學計算機":a.title)+(off?"（未啟用）":"")));
 }
 // The canvas (photo + Graph) is always open; when it is minimized or covered
 // by a maximized window this button lays the windows out side by side again.
 const cv=open.find(p=>p.kind==="canvas"),cpl=cv&&lay.placements[cv.panelId];
 const covered=cv&&!mobile&&(cpl?.mode==="minimized"||open.some(p=>p!==cv&&lay.placements[p.panelId]?.mode==="maximized"));
 if(covered)launch.prepend(h("button",{class:"wb-open",title:"把畫布與函數圖叫回來，和其他視窗並排",onclick:()=>wbLayout({op:"reset",profile:wb.profile,panelIds:open.map(p=>p.panelId)})},"＋ 函數圖／畫布"));
 bar.push(launch);
 for(const p of open){const pl=lay.placements[p.panelId];
  if(!mobile&&pl?.mode==="minimized"&&p.kind!=="canvas")bar.push(h("button",{class:"wb-chip",onclick:()=>wbLayout({op:"restore",panelId:p.panelId})},"還原："+wbTitle(p)));}
 if(!solo){bar.push(h("button",{class:"wb-chip",title:"把目前這個裝置的面板排回預設位置",onclick:()=>wbLayout({op:"reset",profile:wb.profile,panelIds:openPanels().map(p=>p.panelId)})},"重設版面"));}
 wbBar.replaceChildren(...bar);
}
const wbTitle=p=>p.kind==="canvas"?"畫布":p.kind==="calculator"?"科學計算機"+(/(\d+)$/.exec(p.panelId)?.[1]>1?" "+/(\d+)$/.exec(p.panelId)[1]:""):p.title;
function wbReorder(dir){
 const lay=layoutNow(),ids=lay.order.filter(id=>openPanels().some(p=>p.panelId===id)),i=ids.indexOf(lay.active),j=i+dir;
 if(i<0||j<0||j>=ids.length)return;const next=[...ids];[next[i],next[j]]=[next[j],next[i]];
 wbLayout({op:"reorder",order:next});
}
// The photo/graph canvas is static markup; it moves into a panel frame once.
function canvasPanel(p){const main=document.querySelector("#panel-canvas"),el=buildPanel(p);el.querySelector(".wb-body").append(main);return el;}
function buildPanel(p){
 const head=h("div",{class:"wb-head"},
  h("span",{class:"wb-grip",tabindex:"0",role:"button","aria-label":wbTitle(p)+"：按住拖曳移動；Alt＋方向鍵移動，Alt＋Shift＋方向鍵調整大小","aria-describedby":"wb-help",title:"拖曳移動"},"⠿ ",h("span",{class:"wb-title"},wbTitle(p))),
  h("button",{class:"wb-mini","data-act":"menu","aria-haspopup":"menu",title:"停靠與位置","aria-label":"停靠與位置選單"},"☰"),
  h("button",{class:"wb-mini","data-act":"minimize",title:"縮到列上","aria-label":"縮小"},"–"),
  h("button",{class:"wb-mini","data-act":"maximize",title:"在工作台內最大化","aria-label":"最大化","aria-pressed":"false"},"▢"),
  p.kind!=="canvas"?h("button",{class:"wb-mini","data-act":"close",title:"關閉面板（資料會保留）","aria-label":"關閉"},"✕"):null);
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
 const menu=h("div",{class:"wb-menu",role:"menu","aria-label":"停靠與位置"},
  item("靠左停靠",{op:"arrange",panelId:id,rect:{x:0,y:0,w:0.5,h:1},dock:"left"}),
  item("靠右停靠",{op:"arrange",panelId:id,rect:{x:0.5,y:0,w:0.5,h:1},dock:"right"}),
  item("靠上停靠",{op:"arrange",panelId:id,rect:{x:0,y:0,w:1,h:0.5},dock:"top"}),
  item("靠下停靠",{op:"arrange",panelId:id,rect:{x:0,y:0.5,w:1,h:0.5},dock:"bottom"}),
  item("浮動在上方",{op:"arrange",panelId:id,rect:{x:0.3,y:0.1,w:0.45,h:0.7},dock:"free"}),
  item("移到最上層",{op:"focus",panelId:id}));
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
new ResizeObserver(()=>{if(!wb.surface)return;const p=wbProfileNow();if(p!==wb.profile){wb.profile=p;renderWB();}}).observe(document.body);
// A grip under the panel area: ChatGPT gives an inline widget no resize handle, so the
// area height is the user's to set. Drag to resize, double-click to go back to the default.
{
 const KEY="estampes.wbHeight",MIN=360,MAX=3000;
 const grip=h("div",{id:"wb-height-grip",role:"separator","aria-orientation":"horizontal",tabindex:"0",title:"拖曳調整視窗高度，雙擊還原；鍵盤：上下方向鍵"});
 wbArea.after(grip);
 const apply=px=>{if(px==null)wbArea.style.removeProperty("height");else wbArea.style.height=Math.round(Math.min(MAX,Math.max(MIN,px)))+"px";};
 const save=()=>{try{const v=wbArea.style.height;v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch{}};
 try{const v=parseFloat(localStorage.getItem(KEY));if(v>0)apply(v)}catch{}
 let drag=null;
 grip.addEventListener("pointerdown",e=>{drag={y:e.clientY,h:wbArea.getBoundingClientRect().height};grip.setPointerCapture(e.pointerId);e.preventDefault();});
 grip.addEventListener("pointermove",e=>{if(drag)apply(drag.h+e.clientY-drag.y);});
 const end=()=>{if(drag){drag=null;save()}};
 grip.addEventListener("pointerup",end);grip.addEventListener("pointercancel",end);
 grip.addEventListener("dblclick",()=>{apply(null);save()});
 grip.addEventListener("keydown",e=>{if(e.key!=="ArrowUp"&&e.key!=="ArrowDown")return;e.preventDefault();apply(wbArea.getBoundingClientRect().height+(e.key==="ArrowDown"?40:-40));save();});
}
