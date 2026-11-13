// ===== Workbench: panels, window manager, scientific calculator =====
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

// ---------- math display: LaTeX subset -> MathML (no innerHTML) ----------
const MNS="http://www.w3.org/1998/Math/MathML";
const mk=(tag,text,...kids)=>{const e=document.createElementNS(MNS,tag);if(text!=null)e.textContent=text;for(const k of kids)e.append(k);return e;};
const TEX_SYM={pi:"π",infty:"∞",cdot:"·",times:"×",div:"÷",pm:"±",le:"≤",leq:"≤",ge:"≥",geq:"≥",ne:"≠",neq:"≠",alpha:"α",beta:"β",gamma:"γ",delta:"δ",epsilon:"ε",theta:"θ",lambda:"λ",mu:"μ",sigma:"σ",phi:"φ",omega:"ω",rho:"ρ",tau:"τ",int:"∫",sum:"∑",prod:"∏",to:"→",ldots:"…",partial:"∂",nabla:"∇",in:"∈",cup:"∪",cap:"∩",emptyset:"∅",mathrm:"",quad:" ",qquad:" "};
const TEX_FN=new Set(["sin","cos","tan","sec","csc","cot","arcsin","arccos","arctan","sinh","cosh","tanh","log","ln","exp","min","max","lim","det","gcd","Re","Im","arg","mod"]);
function texToMathML(tex){
 const toks=[];const re=/\\([A-Za-z]+|.)|(\d+\.?\d*|\.\d+)|(\s+)|(.)/gs;let m;
 while((m=re.exec(String(tex).slice(0,6000)))&&toks.length<3000){if(m[3])continue;toks.push(m[1]!==undefined?{c:m[1]}:m[2]?{n:m[2]}:{ch:m[4]});}
 let i=0,depth=0;
 const peek=()=>toks[i],isCh=(t,c)=>t&&t.ch===c;
 function group(){ // {...} or one atom
  if(isCh(peek(),"{")){i++;depth++;if(depth>30)throw Error("deep");const r=seq(t=>isCh(t,"}"));i++;depth--;return mk("mrow",null,...r);}
  const a=atom();return a??mk("mrow");
 }
 function seq(stop){const out=[];while(i<toks.length&&!stop(peek())){const a=script(atom());if(a)out.push(a);}return out;}
 function script(base){
  if(!base)return base;let sub=null,sup=null;
  for(let k=0;k<2;k++){if(isCh(peek(),"^")){i++;sup=group();}else if(isCh(peek(),"_")){i++;sub=group();}else break;}
  if(sub&&sup)return mk("msubsup",null,base,sub,sup);if(sup)return mk("msup",null,base,sup);if(sub)return mk("msub",null,base,sub);return base;
 }
 function atom(){
  const t=toks[i++];if(!t)return null;
  if(t.n)return mk("mn",t.n);
  if(t.ch!==undefined){
   if(t.ch==="{"){i--;return group();}
   if("+-=<>,;:!|/".includes(t.ch))return mk("mo",t.ch==="-"?"−":t.ch);
   if("()[]".includes(t.ch))return mk("mo",t.ch);
   if(t.ch==="&"||t.ch==="}")return null;
   return mk("mi",t.ch);
  }
  const c=t.c;
  if(c==="frac"||c==="dfrac"){const a=group(),b=group();return mk("mfrac",null,a,b);}
  if(c==="sqrt"){if(isCh(peek(),"[")){i++;const n=seq(x=>isCh(x,"]"));i++;return mk("mroot",null,group(),mk("mrow",null,...n));}return mk("msqrt",null,group());}
  if(c==="left"||c==="right"){const d=toks[i++];const ch=d?.ch??(d?.c==="vert"||d?.c==="lvert"||d?.c==="rvert"?"|":".");return ch==="."?null:mk("mo",ch);}
  if(c==="operatorname"||c==="mathrm"||c==="text"){const g=group();return mk("mi",g.textContent);}
  if(c==="begin"){return matrix();}
  if(c==="end"){group();return null;}
  if(c==="\\")return null;
  if(c===","||c===";"||c===" "||c===":"||c==="!")return null;
  if(TEX_FN.has(c))return mk("mi",c);
  if(c in TEX_SYM)return TEX_SYM[c]===""?null:(["int","sum","prod"].includes(c)?mk("mo",TEX_SYM[c]):(/^[a-z]$/i.test(TEX_SYM[c])||"αβγδεθλμσφωρτπ".includes(TEX_SYM[c])?mk("mi",TEX_SYM[c]):mk("mo",TEX_SYM[c])));
  return mk("mtext","\\"+c);
 }
 function matrix(){
  const env=group().textContent;const rows=[[]];let cell=[];
  const end=()=>{rows.at(-1).push(mk("mtd",null,...cell));cell=[];};
  while(i<toks.length){
   const t=peek();
   if(t.c==="end"){i++;group();break;}
   if(t.ch==="&"){i++;end();continue;}
   if(t.c==="\\"){i++;end();rows.push([]);continue;}
   const a=script(atom());if(a)cell.push(a);
  }
  end();
  const table=mk("mtable",null,...rows.filter(r=>r.length).map(r=>mk("mtr",null,...r)));
  const [l,r]=env==="pmatrix"?["(",")"]:env==="bmatrix"?["[","]"]:env==="vmatrix"?["|","|"]:["(",")"];
  return mk("mrow",null,mk("mo",l),table,mk("mo",r));
 }
 const math=document.createElementNS(MNS,"math");math.setAttribute("display","inline");
 try{for(const n of seq(()=>false))math.append(n);}catch{math.replaceChildren(mk("mtext",tex));}
 return math;
}

// ---------- scientific calculator panel ----------
const OPS=[["evaluate","計算"],["simplify","化簡"],["expand","展開"],["factor","因式分解"],["differentiate","微分"],["integrate","積分"],["limit","極限"],["series","級數展開"],["solve","解方程式"],["solve_system","解方程組"],["nsolve","數值解"],["substitute","代入"],["matrix","矩陣"],["summation","求和"],["product","連乘"],["together","通分"],["apart","部分分式"],["cancel","約分"],["collect","依變數整理"],["trigsimp","三角化簡"]];
const OP_ZH=Object.fromEntries(OPS);
const STATUS_ZH={exact:"精確",approximate:"近似",complex:"複數",conditional:"有條件",partial:"無封閉解",undefined:"未定義"};
const PARAM_ROWS={differentiate:["variable","order"],integrate:["variable","lower","upper"],limit:["variable","point","direction"],series:["variable","point","n"],solve:["variable","domain"],solve_system:[],nsolve:["variable","guess"],
 substitute:["subs"],matrix:["mode","other"],summation:["variable","lower","upper"],product:["variable","lower","upper"],collect:["variable"],apart:["variable"]};
const KEYS=[["π","pi"],["e","e"],["i","I"],["√","sqrt("],["^","^"],["( )","()"],["|x|","abs()"],["sin","sin("],["cos","cos("],["tan","tan("],["ln","ln("],["exp","exp("],["×","*"],["÷","/"],["∞","oo"],["!","!"]];
function calcState(id){if(!wb.calc.has(id))wb.calc.set(id,{mode:"text",op:"evaluate",editing:null,busy:false,message:"",messageKind:"",values:{},ui:null,keys:false});return wb.calc.get(id);}
function insertAtCaret(ta,text){
 const s=ta.selectionStart??ta.value.length,e=ta.selectionEnd??ta.value.length;
 ta.setRangeText(text,s,e,"end");
 if(text.endsWith("()")||text.endsWith("(")){const back=text.endsWith("()")?1:0;ta.setSelectionRange(ta.selectionStart-back,ta.selectionStart-back);}
 ta.dispatchEvent(new Event("input",{bubbles:true}));ta.focus();
}
async function copyText(text){
 try{await navigator.clipboard.writeText(text);return true;}catch{}
 const ta=h("textarea",{style:"position:fixed;opacity:0"});ta.value=text;document.body.append(ta);ta.select();
 let ok=false;try{ok=document.execCommand("copy");}catch{}ta.remove();return ok;
}
function buildCalcUI(p){
 const st=calcState(p.panelId);
 const input=h("textarea",{class:"calc-input",rows:"2",maxlength:"4096",spellcheck:"false",autocomplete:"off",autocapitalize:"off",autocorrect:"off","aria-label":"算式",placeholder:"例如 sin(x^2)　或　x^2-4=0"});
 const op=h("select",{"aria-label":"運算"},OPS.map(([v,t])=>h("option",{value:v},t)));
 const mode=h("div",{class:"calc-mode",role:"group","aria-label":"輸入格式"},
  h("button",{type:"button","data-m":"text","aria-pressed":"true"},"文字"),h("button",{type:"button","data-m":"latex","aria-pressed":"false",title:"直接貼上 LaTeX，例如 \\frac{1}{3}、\\sqrt{x}、x^{2}"},"LaTeX"));
 const params=h("div",{class:"calc-params"});
 const angle=h("select",{"aria-label":"角度單位",title:"度：只有純數字的 sin/cos/tan 引數會當成度；sin(x) 不會被改寫"},h("option",{value:"rad"},"弧度"),h("option",{value:"deg"},"度"));
 const prec=h("input",{type:"number",min:"5",max:"100",value:"15","aria-label":"近似值位數",title:"近似值位數",style:"width:4.5em"});
 const go=h("button",{type:"button",class:"primary"},"計算");
 const stop=h("button",{type:"button",hidden:true,title:"停止這次計算","aria-label":"停止計算"},"停止");
 const hint=h("small",{class:"calc-hint"},"Enter 計算 · Shift+Enter 換行 · Ctrl/⌘+Enter 一律計算");
 const keysBtn=h("button",{type:"button","aria-expanded":"false",class:"wb-chip"},"符號鍵");
 const keys=h("div",{class:"calc-keys",hidden:true,role:"group","aria-label":"符號鍵（選用）"},KEYS.map(([label,ins])=>h("button",{type:"button",onpointerdown:e=>e.preventDefault(),onclick:()=>insertAtCaret(input,ins)},label)));
 const msg=h("div",{class:"calc-msg",role:"status","aria-live":"polite"});
 const defsForm=h("details",{class:"calc-defs"},h("summary",null,"變數、函數與假設"),
  h("div",{class:"calc-row"},h("input",{class:"d-name",maxlength:"24",placeholder:"名稱 f 或 a","aria-label":"名稱"}),h("input",{class:"d-params",maxlength:"60",placeholder:"參數 x,y（變數留空）","aria-label":"函數參數"}),h("input",{class:"d-body",maxlength:"200",placeholder:"內容 sin(x^2)+a","aria-label":"定義內容"}),h("button",{type:"button",class:"d-set"},"定義")),
  h("div",{class:"calc-row"},h("input",{class:"a-name",maxlength:"24",placeholder:"符號 x","aria-label":"符號"}),h("select",{class:"a-flag","aria-label":"假設"},["","real","positive","negative","nonnegative","integer","rational","nonzero"].map(v=>h("option",{value:v},v||"（無假設）"))),h("button",{type:"button",class:"a-set"},"設定假設")),
  h("div",{class:"calc-chips"}));
 const range=h("details",{class:"calc-range"},h("summary",null,"畫圖範圍"),h("div",{class:"calc-row"},"x ",h("input",{type:"number",class:"x0",value:"-10",step:"any","aria-label":"x 最小"}),"到",h("input",{type:"number",class:"x1",value:"10",step:"any","aria-label":"x 最大"})));
 const auto=h("input",{type:"checkbox",class:"calc-auto"});
 const refreshBtn=h("button",{type:"button",hidden:true,title:"重算過期的格子並重畫連到它們的圖形"},"更新所有連結");
 const syncRow=h("div",{class:"calc-row calc-sync"},h("label",{title:"改了變數、函數或假設時，自動重算並重畫連結的 Graph 圖形"},auto," 自動更新 Graph"),refreshBtn);
 const list=h("div",{class:"calc-cells","aria-label":"計算紀錄"});
 const root=h("div",{class:"calc"},
  h("div",{class:"calc-row"},mode,op),input,params,
  h("div",{class:"calc-row calc-go"},go,stop,angle,h("label",{class:"calc-prec"},"位數 ",prec),keysBtn),keys,hint,msg,defsForm,range,syncRow,list);
 const ui={root,input,op,mode,params,angle,prec,go,stop,auto,refreshBtn,keys,keysBtn,msg,list,defsForm,range};
 st.ui=ui;
 mode.addEventListener("click",e=>{const b=e.target.closest("[data-m]");if(!b)return;st.mode=b.dataset.m;for(const x of mode.children)x.setAttribute("aria-pressed",String(x===b));
  input.placeholder=st.mode==="latex"?"例如 \\frac{x^{2}+1}{\\sqrt{x}}":"例如 sin(x^2)　或　x^2-4=0";});
 op.addEventListener("change",()=>{st.op=op.value;buildParams(ui,st);});
 buildParams(ui,st);
 // Enter calculates a one-line expression; Shift+Enter is a newline; IME
 // composition is never interrupted; the host's chat composer never sees these keys.
 input.addEventListener("keydown",e=>{
  e.stopPropagation();
  if(e.key!=="Enter"||e.isComposing||e.keyCode===229)return;
  if(e.shiftKey&&!e.ctrlKey&&!e.metaKey)return;
  e.preventDefault();runCalc(p.panelId);
 });
 go.addEventListener("click",()=>runCalc(p.panelId));
 stop.addEventListener("click",()=>stopCalc(p.panelId));
 auto.addEventListener("change",()=>setAuto(p.panelId,auto.checked));
 refreshBtn.addEventListener("click",()=>refreshLinks(p.panelId));
 keysBtn.addEventListener("click",()=>{keys.hidden=!keys.hidden;keysBtn.setAttribute("aria-expanded",String(!keys.hidden));});
 input.addEventListener("focus",()=>setTimeout(()=>input.scrollIntoView({block:"center",behavior:"smooth"}),250));
 if(window.visualViewport)window.visualViewport.addEventListener("resize",()=>{if(document.activeElement===input)input.scrollIntoView({block:"center"});});
 defsForm.querySelector(".d-set").addEventListener("click",()=>runDefine(p.panelId,{name:defsForm.querySelector(".d-name").value.trim(),params:defsForm.querySelector(".d-params").value,body:defsForm.querySelector(".d-body").value.trim()}));
 defsForm.querySelector(".a-set").addEventListener("click",()=>{const f=defsForm.querySelector(".a-flag").value;runDefine(p.panelId,{name:defsForm.querySelector(".a-name").value.trim(),assumptions:f?[f]:[]});});
 const rg=()=>{const a=Number(range.querySelector(".x0").value),b=Number(range.querySelector(".x1").value);if(Number.isFinite(a)&&Number.isFinite(b)&&a<b)wb.domain=[a,b];};
 range.addEventListener("input",rg);
 return root;
}
function buildParams(ui,st){
 const want=PARAM_ROWS[st.op]??[];ui.params.replaceChildren();ui.fields={};
 const field=(name,label,el)=>{ui.fields[name]=el;ui.params.append(h("label",null,label,el));};
 const txt=(ph,w)=>h("input",{type:"text",maxlength:"256",placeholder:ph,style:w?"width:"+w:"",autocomplete:"off",spellcheck:"false"});
 if(st.op==="solve_system")ui.params.append(h("small",{class:"calc-hint"},"每行一個方程式，例如 x+y=3"));
 if(want.includes("variable"))field("variable","變數 ",txt("x","4.5em"));
 if(want.includes("order"))field("order","次數 ",h("input",{type:"number",min:"1",max:"10",value:"1",style:"width:4em"}));
 if(want.includes("lower"))field("lower","下限 ",txt("0（不填＝不定積分）","9em"));
 if(want.includes("upper"))field("upper","上限 ",txt("1","7em"));
 if(want.includes("point"))field("point","在 ",txt("0","6em"));
 if(want.includes("direction"))field("direction","方向 ",h("select",null,h("option",{value:"+-"},"雙邊"),h("option",{value:"+"},"右極限"),h("option",{value:"-"},"左極限")));
 if(want.includes("n"))field("n","項數 ",h("input",{type:"number",min:"1",max:"30",value:"6",style:"width:4em"}));
 if(want.includes("guess"))field("guess","起始猜測 ",txt("1","6em"));
 if(want.includes("domain"))field("domain","範圍 ",h("select",null,h("option",{value:"complex"},"複數"),h("option",{value:"real"},"實數")));
 if(want.includes("subs"))field("subs","代入 ",txt("x=3, y=2","12em"));
 if(want.includes("mode"))field("mode","矩陣運算 ",h("select",null,[["determinant","行列式"],["inverse","反矩陣"],["transpose","轉置"],["rank","秩"],["rref","列簡化"],["trace","跡"],["eigenvalues","特徵值"],["add","加"],["multiply","乘"]].map(([v,t])=>h("option",{value:v},t))));
 if(want.includes("other"))field("other","第二個矩陣 ",txt("[[1,0],[0,1]]（加／乘才需要）","14em"));
 ui.input.placeholder=st.op==="solve_system"?"x+y=3\nx-y=1":(st.mode==="latex"?"例如 \\frac{x^{2}+1}{\\sqrt{x}}":"例如 sin(x^2)　或　x^2-4=0");
}
function calcParams(ui,st){
 const text=ui.input.value.trim(),p={operation:st.op,angle:ui.angle.value,precision:Math.max(5,Math.min(100,Math.round(Number(ui.prec.value))||15))};
 if(st.op==="solve_system"){p.equations=text.split(/\n|;/).map(s=>s.trim()).filter(Boolean).slice(0,8);if(!p.equations.length)throw Error("請輸入方程式，每行一個");}
 else{if(!text)throw Error("請先輸入算式");p[st.mode==="latex"?"latex":"text"]=text;}
 for(const [k,el] of Object.entries(ui.fields??{})){
  const v=el.value.trim();if(!v)continue;
  if(k==="order"||k==="n")p[k]=Number(v);
  else if(k==="subs"){p.subs=v.split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(s=>{const m=/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(s);if(!m)throw Error("代入請寫成 x=3, y=2");return{name:m[1],value:m[2]};}).slice(0,8);}
  else p[k]=v;
 }
 if(st.op==="nsolve"&&!p.guess)throw Error("數值解需要起始猜測");
 return p;
}
async function runCalc(id){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id),ui=st.ui;
 if(!p||st.busy)return;
 let params;try{params=calcParams(ui,st);}catch(err){setMsg(st,String(err.message),"error");return;}
 params.notebook=p.notebook;if(st.editing)params.cell=st.editing;
 params.job=newJob(st);
 st.busy=true;ui.go.disabled=true;ui.stop.hidden=false;ui.root.setAttribute("aria-busy","true");setMsg(st,"SymPy 計算中…","");
 try{
  const r=await wbCall("surface_cas",{...(imageId?{imageId}:ws?{imageId:ws.items[0].imageId}:{}),capability:"calculate",params});
  const cell=r.data?.cell;
  if(cell?.state==="error")setMsg(st,ERR_ZH(cell.error),"error");
  else{setMsg(st,"","");st.editing=null;ui.input.value="";applyRefresh(st,r);}
  await wbRefresh();
 }catch(err){if(st.cancelled)setMsg(st,"已停止，沒有留下任何結果。","");else setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;st.job=null;st.cancelled=false;ui.go.disabled=false;ui.stop.hidden=true;ui.root.removeAttribute("aria-busy");ui.input.focus();}
}
// A calculation carries an id so the Stop button can end it in the service.
const newJob=st=>{st.job=uuid().replace(/[^0-9a-f]/g,"").padEnd(16,"0").slice(0,16);return st.job;};
async function stopCalc(id){
 const st=calcState(id);if(!st.job)return;
 st.cancelled=true;setMsg(st,"正在停止…","");
 try{await wbCall("surface_cas_cancel",{job:st.job});}catch(err){st.cancelled=false;setMsg(st,String(err.message||err),"error");}
}
// Results of a calculation that also redrew linked plots.
function applyRefresh(st,r){
 if(Array.isArray(r.objects)){setObjects(r.objects);render();}
 const f=r.refresh;if(!f)return;
 if(f.failed.length)setMsg(st,"已更新 "+f.updated.length+" 個圖形；"+f.failed.length+" 個沒有更新（"+f.failed[0].reason+"）","error");
 else if(f.updated.length)setMsg(st,"已重算並更新 "+f.updated.length+" 個 Graph 圖形。","");
}
async function setAuto(id,on){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);
 try{await wbCall("surface_cas",{capability:"set_options",params:{notebook:p.notebook,autoRefresh:on}});await wbRefresh();setMsg(st,on?"之後改定義時會自動更新連結的圖形。":"改為手動更新連結。","");}
 catch(err){setMsg(st,String(err.message||err),"error");await wbRefresh();}
}
async function refreshLinks(id){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);if(st.busy||!imageId)return;
 st.busy=true;renderCalc(p);setMsg(st,"正在更新連結…","");
 try{const r=await wbCall("surface_cas",{imageId,capability:"refresh_links",params:{notebook:p.notebook}});applyRefresh(st,r);if(!r.refresh?.updated.length&&!r.refresh?.failed.length)setMsg(st,"連結都是最新的。","");await wbRefresh();}
 catch(err){setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;renderCalc(p);}
}
const ERR_ZH=e=>({syntax:"算式看不懂：",unsupported:"目前不支援：",domain:"數學上不成立：",timeout:"算太久，已停止：",resource_limit:"超過限制：",worker_unavailable:"計算服務沒有啟動：",cancelled:"已取消：",internal:"計算引擎發生錯誤："}[e?.code]??"")+(e?.message??"");
async function runDefine(id,d){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);
 try{
  const params={notebook:p.notebook,name:d.name};
  if(d.assumptions)params.assumptions=d.assumptions;
  else if(d.body){params.text=d.body;params.params=d.params?d.params.split(",").map(s=>s.trim()).filter(Boolean):[];}
  const r=await wbCall("surface_cas",{...(imageId?{imageId}:{}),capability:"define",params});
  setMsg(st,"已更新 "+d.name+"；用到它的舊結果已標示為過期，可按「重算」。","");applyRefresh(st,r);await wbRefresh();
 }catch(err){setMsg(st,String(err.message||err),"error");}
}
function setMsg(st,text,kind){st.message=text;st.messageKind=kind;if(st.ui){st.ui.msg.textContent=text;st.ui.msg.dataset.kind=kind;}}
async function wbRefresh(){setSurface(await wbCall("surface_get_state",wbArgs()));}
function renderCalc(p){
 const el=wb.els.get(p.panelId),st=calcState(p.panelId);
 if(!st.ui){const ui=buildCalcUI(p);el.querySelector(".wb-body").replaceChildren(ui);}
 const ui=st.ui,nb=wb.notebooks[p.panelId],disabled=p.moduleState!=="enabled";
 ui.root.classList.toggle("off",disabled);
 for(const e of ui.root.querySelectorAll(".calc-row button,.calc-go button,.calc-keys button"))if(e!==ui.keysBtn&&e!==ui.stop)e.disabled=disabled||st.busy;
 ui.go.disabled=disabled||st.busy;
 ui.auto.checked=!!nb?.autoRefresh;ui.auto.disabled=disabled||st.busy;
 const staleLinks=(nb?.cells??[]).filter(c=>(c.links??[]).some(l=>l.status!=="fresh"&&l.status!=="removed")).length;
 ui.refreshBtn.hidden=!imageId||!staleLinks;ui.refreshBtn.disabled=disabled||st.busy;ui.refreshBtn.textContent="更新所有連結（"+staleLinks+"）";
 if(disabled)setMsg(st,"「科學計算機」模組已停用：舊結果仍可閱讀；請到 Store 重新啟用後再計算。","error");
 else if(st.message==="" )ui.msg.textContent="";
 // definitions
 const chips=ui.defsForm.querySelector(".calc-chips");chips.replaceChildren();
 for(const d of nb?.definitions??[])chips.append(h("span",{class:"calc-chip"},d.name+(d.params.length?"("+d.params.join(",")+")":"")+" = "+d.text,h("button",{type:"button","aria-label":"移除 "+d.name,title:"移除",disabled,onclick:()=>runDefine(p.panelId,{name:d.name})},"×")));
 for(const [name,flags] of Object.entries(nb?.assumptions??{}))chips.append(h("span",{class:"calc-chip"},name+"："+flags.join(", "),h("button",{type:"button","aria-label":"移除 "+name+" 的假設",disabled,onclick:()=>runDefine(p.panelId,{name,assumptions:[]})},"×")));
 // cells, newest first
 ui.list.replaceChildren();
 const cells=[...(nb?.cells??[])].reverse();
 if(!cells.length)ui.list.append(h("p",{class:"calc-empty"},"還沒有計算。輸入算式後按「計算」；結果由 SymPy 算出，可以直接畫到 Graph。"));
 for(const c of cells)ui.list.append(cellView(p,c,nb,disabled));
}
function cellView(p,c,nb,disabled){
 const st=calcState(p.panelId),r=c.result,src=c.input.text??c.input.latex??(c.input.equations??[]).join("; ");
 const art=h("article",{class:"cell","data-state":c.state});
 art.append(h("div",{class:"cell-in"},h("code",null,src.length>160?src.slice(0,160)+"…":src),h("span",{class:"calc-chip"},OP_ZH[c.operation]??c.operation),
  c.state==="stale"?h("span",{class:"calc-chip warn",title:c.staleReason??""},"已過期"):null,
  r&&c.state!=="error"?h("span",{class:"calc-chip st-"+r.status},STATUS_ZH[r.status]??r.status):null));
 if(c.state==="error"){art.append(h("p",{class:"cell-err",role:"alert"},ERR_ZH(c.error)));}
 else if(r){
  const mathBox=h("div",{class:"cell-math",role:"img","aria-label":r.plain},texToMathML(r.latex??r.plain));
  art.append(mathBox,h("div",{class:"cell-plain"},h("code",null,r.plain)));
  if(r.approx)art.append(h("div",{class:"cell-approx"},"≈ ",h("code",null,r.approx.length>120?r.approx.slice(0,120)+"…":r.approx)));
  for(const w of r.warnings??[])art.append(h("p",{class:"cell-warn"},"⚠ "+w));
  if(c.state==="stale")art.append(h("p",{class:"cell-warn"},"⚠ 這個結果和目前的定義不一致（"+(c.staleReason??"上游已變更")+"）。按「重算」更新。"));
 }
 const here=(c.links??[]).filter(l=>l.canvas===imageId||ws?.items.some(i=>i.imageId===l.canvas));
 if(here.length)art.append(h("p",{class:"cell-link"},here.map(l=>"Graph 物件 "+l.object+"："+(l.status==="fresh"?"同步":l.status==="stale"?"已過期":l.status==="removed"?"圖形已刪除":l.status)).join("　")));
 const plottable=r&&["exact","approximate"].includes(r.status)&&c.state==="fresh";
 const linkHere=here.find(l=>l.status!=="removed");
 const acts=h("div",{class:"cell-acts"},
  h("button",{type:"button",class:"primary",disabled:disabled||!plottable||(!imageId&&!ws),title:plottable?"把這個結果畫成可編輯的函數圖":"只有精確或近似的實數單變數結果能畫圖；過期的結果要先重算",onclick:()=>plotCell(p,c,linkHere)},linkHere?"更新 Graph 圖形":"畫在 Graph"),
  c.state==="stale"||c.state==="error"?h("button",{type:"button",disabled,onclick:()=>recompute(p,c)},"重算"):null,
  h("button",{type:"button",onclick:()=>{st.editing=c.cellId;st.ui.input.value=src;st.ui.input.focus();setMsg(st,"正在修改這一格；按「計算」會覆蓋它的結果。","");}},"修改"),
  r?h("button",{type:"button",onclick:async()=>setMsg(st,(await copyText(r.latex))?"已複製 LaTeX":"無法複製；請手動選取 LaTeX",""),title:r.latex},"複製 LaTeX"):null,
  r?h("button",{type:"button",onclick:async()=>setMsg(st,(await copyText(r.plain))?"已複製文字":"無法複製",""),},"複製文字"):null);
 art.append(acts);
 return art;
}
async function recompute(p,c){
 const st=calcState(p.panelId);if(st.busy)return;
 st.busy=true;st.ui.stop.hidden=false;setMsg(st,"SymPy 重算中…","");
 try{const r=await wbCall("surface_cas",{...(imageId?{imageId}:{}),capability:"recompute",params:{notebook:p.notebook,cell:c.cellId,job:newJob(st)}});setMsg(st,"","");applyRefresh(st,r);await wbRefresh();}
 catch(err){if(st.cancelled)setMsg(st,"已停止，原來的結果沒有改變。","");else setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;st.job=null;st.cancelled=false;st.ui.stop.hidden=true;renderCalc(p);}
}
async function plotCell(p,c,link){
 const st=calcState(p.panelId);
 const canvas=imageId??ws?.items[0]?.imageId;
 try{
  const params={notebook:p.notebook,cell:c.cellId,domain:wb.domain,...(link?{object:link.object}:{})};
  const r=await wbCall("surface_cas",{imageId:canvas,capability:"plot_result",params});
  if(Array.isArray(r.objects)){setObjects(r.objects);render();}
  setMsg(st,link?"已更新 Graph 上的圖形 "+link.object+"。":"已畫在 Graph："+(r.data?.expression??""),"");
  status.textContent="計算機的結果已畫成可編輯的函數圖；AI 下一次讀取畫布時會看到。";
  await wbRefresh();
 }catch(err){setMsg(st,"沒有畫出圖：" + String(err.message||err),"error");}
}
