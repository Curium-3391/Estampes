// ===== Calculator panels: math display and the scientific calculator =====
// Inlined after workbench.js in the same scope; it uses the panel helpers there (wb, h, uuid, ...).
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
const OPS=[["evaluate",t("calc.op.evaluate")],["simplify",t("calc.op.simplify")],["expand",t("calc.op.expand")],["factor",t("calc.op.factor")],["differentiate",t("calc.op.differentiate")],["integrate",t("calc.op.integrate")],["limit",t("calc.op.limit")],["series",t("calc.op.series")],["solve",t("calc.op.solve")],["solve_system",t("calc.op.solve_system")],["nsolve",t("calc.op.nsolve")],["substitute",t("calc.op.substitute")],["matrix",t("calc.op.matrix")],["summation",t("calc.op.summation")],["product",t("calc.op.product")],["together",t("calc.op.together")],["apart",t("calc.op.apart")],["cancel",t("calc.op.cancel")],["collect",t("calc.op.collect")],["trigsimp",t("calc.op.trigsimp")]];
const OP_ZH=Object.fromEntries(OPS);
const STATUS_ZH={exact:t("calc.status.exact"),approximate:t("calc.status.approximate"),complex:t("calc.status.complex"),conditional:t("calc.status.conditional"),partial:t("calc.status.partial"),undefined:t("calc.status.undefined")};
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
 const input=h("textarea",{class:"calc-input",rows:"2",maxlength:"4096",spellcheck:"false",autocomplete:"off",autocapitalize:"off",autocorrect:"off","aria-label":t("calc.input.label"),placeholder:t("calc.input.placeholder")});
 const op=h("select",{"aria-label":t("calc.op.label")},OPS.map(([v,t])=>h("option",{value:v},t)));
 const mode=h("div",{class:"calc-mode",role:"group","aria-label":t("calc.mode.label")},
  h("button",{type:"button","data-m":"text","aria-pressed":"true"},t("calc.mode.text")),h("button",{type:"button","data-m":"latex","aria-pressed":"false",title:t("calc.mode.latexTitle",{a:"\\frac{1}{3}",b:"\\sqrt{x}",c:"x^{2}"})},"LaTeX"));
 const params=h("div",{class:"calc-params"});
 const angle=h("select",{"aria-label":t("calc.angle.label"),title:t("calc.angle.title")},h("option",{value:"rad"},t("calc.angle.rad")),h("option",{value:"deg"},t("calc.angle.deg")));
 const prec=h("input",{type:"number",min:"5",max:"100",value:"15","aria-label":t("calc.prec.label"),title:t("calc.prec.label"),style:"width:4.5em"});
 const go=h("button",{type:"button",class:"primary"},t("calc.go"));
 const stop=h("button",{type:"button",hidden:true,title:t("calc.stop.title"),"aria-label":t("calc.stop.label")},t("calc.stop"));
 const hint=h("small",{class:"calc-hint"},t("calc.hint"));
 const keysBtn=h("button",{type:"button","aria-expanded":"false",class:"wb-chip"},t("calc.keys.button"));
 const keys=h("div",{class:"calc-keys",hidden:true,role:"group","aria-label":t("calc.keys.label")},KEYS.map(([label,ins])=>h("button",{type:"button",onpointerdown:e=>e.preventDefault(),onclick:()=>insertAtCaret(input,ins)},label)));
 const msg=h("div",{class:"calc-msg",role:"status","aria-live":"polite"});
 const defsForm=h("details",{class:"calc-defs"},h("summary",null,t("calc.defs.summary")),
  h("div",{class:"calc-row"},h("input",{class:"d-name",maxlength:"24",placeholder:t("calc.defs.namePlaceholder"),"aria-label":t("calc.defs.nameLabel")}),h("input",{class:"d-params",maxlength:"60",placeholder:t("calc.defs.paramsPlaceholder"),"aria-label":t("calc.defs.paramsLabel")}),h("input",{class:"d-body",maxlength:"200",placeholder:t("calc.defs.bodyPlaceholder"),"aria-label":t("calc.defs.bodyLabel")}),h("button",{type:"button",class:"d-set"},t("calc.defs.define"))),
  h("div",{class:"calc-row"},h("input",{class:"a-name",maxlength:"24",placeholder:t("calc.assume.symbolPlaceholder"),"aria-label":t("calc.assume.symbolLabel")}),h("select",{class:"a-flag","aria-label":t("calc.assume.label")},["","real","positive","negative","nonnegative","integer","rational","nonzero"].map(v=>h("option",{value:v},v||t("calc.assume.none")))),h("button",{type:"button",class:"a-set"},t("calc.assume.set"))),
  h("div",{class:"calc-chips"}));
 const range=h("details",{class:"calc-range"},h("summary",null,t("calc.range.summary")),h("div",{class:"calc-row"},"x ",h("input",{type:"number",class:"x0",value:"-10",step:"any","aria-label":t("calc.range.xmin")}),t("calc.range.to"),h("input",{type:"number",class:"x1",value:"10",step:"any","aria-label":t("calc.range.xmax")})));
 const auto=h("input",{type:"checkbox",class:"calc-auto"});
 const refreshBtn=h("button",{type:"button",hidden:true,title:t("calc.sync.refreshTitle")},t("calc.sync.refreshAll"));
 const syncRow=h("div",{class:"calc-row calc-sync"},h("label",{title:t("calc.sync.autoTitle")},auto,t("calc.sync.auto")),refreshBtn);
 const list=h("div",{class:"calc-cells","aria-label":t("calc.cells.label")});
 const root=h("div",{class:"calc"},
  h("div",{class:"calc-row"},mode,op),input,params,
  h("div",{class:"calc-row calc-go"},go,stop,angle,h("label",{class:"calc-prec"},t("calc.prec.digits"),prec),keysBtn),keys,hint,msg,defsForm,range,syncRow,list);
 const ui={root,input,op,mode,params,angle,prec,go,stop,auto,refreshBtn,keys,keysBtn,msg,list,defsForm,range};
 st.ui=ui;
 mode.addEventListener("click",e=>{const b=e.target.closest("[data-m]");if(!b)return;st.mode=b.dataset.m;for(const x of mode.children)x.setAttribute("aria-pressed",String(x===b));
  input.placeholder=st.mode==="latex"?t("calc.input.example",{example:"\\frac{x^{2}+1}{\\sqrt{x}}"}):t("calc.input.placeholder");});
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
 if(st.op==="solve_system")ui.params.append(h("small",{class:"calc-hint"},t("calc.params.systemHint")));
 if(want.includes("variable"))field("variable",t("calc.param.variable"),txt("x","4.5em"));
 if(want.includes("order"))field("order",t("calc.param.order"),h("input",{type:"number",min:"1",max:"10",value:"1",style:"width:4em"}));
 if(want.includes("lower"))field("lower",t("calc.param.lower"),txt(t("calc.param.lowerPlaceholder"),"9em"));
 if(want.includes("upper"))field("upper",t("calc.param.upper"),txt("1","7em"));
 if(want.includes("point"))field("point",t("calc.param.point"),txt("0","6em"));
 if(want.includes("direction"))field("direction",t("calc.param.direction"),h("select",null,h("option",{value:"+-"},t("calc.direction.both")),h("option",{value:"+"},t("calc.direction.right")),h("option",{value:"-"},t("calc.direction.left"))));
 if(want.includes("n"))field("n",t("calc.param.n"),h("input",{type:"number",min:"1",max:"30",value:"6",style:"width:4em"}));
 if(want.includes("guess"))field("guess",t("calc.param.guess"),txt("1","6em"));
 if(want.includes("domain"))field("domain",t("calc.param.domain"),h("select",null,h("option",{value:"complex"},t("calc.domain.complex")),h("option",{value:"real"},t("calc.domain.real"))));
 if(want.includes("subs"))field("subs",t("calc.param.subs"),txt("x=3, y=2","12em"));
 if(want.includes("mode"))field("mode",t("calc.param.mode"),h("select",null,[["determinant",t("calc.matrix.determinant")],["inverse",t("calc.matrix.inverse")],["transpose",t("calc.matrix.transpose")],["rank",t("calc.matrix.rank")],["rref",t("calc.matrix.rref")],["trace",t("calc.matrix.trace")],["eigenvalues",t("calc.matrix.eigenvalues")],["add",t("calc.matrix.add")],["multiply",t("calc.matrix.multiply")]].map(([v,t])=>h("option",{value:v},t))));
 if(want.includes("other"))field("other",t("calc.param.other"),txt(t("calc.param.otherPlaceholder"),"14em"));
 ui.input.placeholder=st.op==="solve_system"?"x+y=3\nx-y=1":(st.mode==="latex"?t("calc.input.example",{example:"\\frac{x^{2}+1}{\\sqrt{x}}"}):t("calc.input.placeholder"));
}
function calcParams(ui,st){
 const text=ui.input.value.trim(),p={operation:st.op,angle:ui.angle.value,precision:Math.max(5,Math.min(100,Math.round(Number(ui.prec.value))||15))};
 if(st.op==="solve_system"){p.equations=text.split(/\n|;/).map(s=>s.trim()).filter(Boolean).slice(0,8);if(!p.equations.length)throw Error(t("calc.err.noEquations"));}
 else{if(!text)throw Error(t("calc.err.noInput"));p[st.mode==="latex"?"latex":"text"]=text;}
 for(const [k,el] of Object.entries(ui.fields??{})){
  const v=el.value.trim();if(!v)continue;
  if(k==="order"||k==="n")p[k]=Number(v);
  else if(k==="subs"){p.subs=v.split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(s=>{const m=/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(s);if(!m)throw Error(t("calc.err.subsFormat"));return{name:m[1],value:m[2]};}).slice(0,8);}
  else p[k]=v;
 }
 if(st.op==="nsolve"&&!p.guess)throw Error(t("calc.err.nsolveGuess"));
 return p;
}
async function runCalc(id){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id),ui=st.ui;
 if(!p||st.busy)return;
 let params;try{params=calcParams(ui,st);}catch(err){setMsg(st,String(err.message),"error");return;}
 params.notebook=p.notebook;if(st.editing)params.cell=st.editing;
 params.job=newJob(st);
 st.busy=true;ui.go.disabled=true;ui.stop.hidden=false;ui.root.setAttribute("aria-busy","true");setMsg(st,t("calc.msg.computing"),"");
 try{
  const r=await wbCall("surface_cas",{...(imageId?{imageId}:ws?{imageId:ws.items[0].imageId}:{}),capability:"calculate",params});
  const cell=r.data?.cell;
  if(cell?.state==="error")setMsg(st,ERR_ZH(cell.error),"error");
  else{setMsg(st,"","");st.editing=null;ui.input.value="";applyRefresh(st,r);}
  await wbRefresh();
 }catch(err){if(st.cancelled)setMsg(st,t("calc.msg.stoppedNoResult"),"");else setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;st.job=null;st.cancelled=false;ui.go.disabled=false;ui.stop.hidden=true;ui.root.removeAttribute("aria-busy");ui.input.focus();}
}
// A calculation carries an id so the Stop button can end it in the service.
const newJob=st=>{st.job=uuid().replace(/[^0-9a-f]/g,"").padEnd(16,"0").slice(0,16);return st.job;};
async function stopCalc(id){
 const st=calcState(id);if(!st.job)return;
 st.cancelled=true;setMsg(st,t("calc.msg.stopping"),"");
 try{await wbCall("surface_cas_cancel",{job:st.job});}catch(err){st.cancelled=false;setMsg(st,String(err.message||err),"error");}
}
// Results of a calculation that also redrew linked plots.
function applyRefresh(st,r){
 if(Array.isArray(r.objects)){setObjects(r.objects);render();}
 const f=r.refresh;if(!f)return;
 if(f.failed.length)setMsg(st,t("calc.msg.refreshPartial",{updated:f.updated.length,failed:f.failed.length,reason:f.failed[0].reason}),"error");
 else if(f.updated.length)setMsg(st,t("calc.msg.refreshed",{count:f.updated.length}),"");
}
async function setAuto(id,on){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);
 try{await wbCall("surface_cas",{capability:"set_options",params:{notebook:p.notebook,autoRefresh:on}});await wbRefresh();setMsg(st,on?t("calc.msg.autoOn"):t("calc.msg.autoOff"),"");}
 catch(err){setMsg(st,String(err.message||err),"error");await wbRefresh();}
}
async function refreshLinks(id){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);if(st.busy||!imageId)return;
 st.busy=true;renderCalc(p);setMsg(st,t("calc.msg.refreshing"),"");
 try{const r=await wbCall("surface_cas",{imageId,capability:"refresh_links",params:{notebook:p.notebook}});applyRefresh(st,r);if(!r.refresh?.updated.length&&!r.refresh?.failed.length)setMsg(st,t("calc.msg.upToDate"),"");await wbRefresh();}
 catch(err){setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;renderCalc(p);}
}
const ERR_ZH=e=>({syntax:t("calc.err.code.syntax"),unsupported:t("calc.err.code.unsupported"),domain:t("calc.err.code.domain"),timeout:t("calc.err.code.timeout"),resource_limit:t("calc.err.code.resource_limit"),worker_unavailable:t("calc.err.code.worker_unavailable"),cancelled:t("calc.err.code.cancelled"),internal:t("calc.err.code.internal")}[e?.code]??"")+(e?.message??"");
async function runDefine(id,d){
 const p=wb.surface.panels.find(x=>x.panelId===id),st=calcState(id);
 try{
  const params={notebook:p.notebook,name:d.name};
  if(d.assumptions)params.assumptions=d.assumptions;
  else if(d.body){params.text=d.body;params.params=d.params?d.params.split(",").map(s=>s.trim()).filter(Boolean):[];}
  const r=await wbCall("surface_cas",{...(imageId?{imageId}:{}),capability:"define",params});
  setMsg(st,t("calc.msg.defined",{name:d.name}),"");applyRefresh(st,r);await wbRefresh();
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
 ui.refreshBtn.hidden=!imageId||!staleLinks;ui.refreshBtn.disabled=disabled||st.busy;ui.refreshBtn.textContent=t("calc.sync.refreshAllCount",{count:staleLinks});
 if(disabled)setMsg(st,t("calc.msg.moduleDisabled"),"error");
 else if(st.message==="" )ui.msg.textContent="";
 // definitions
 const chips=ui.defsForm.querySelector(".calc-chips");chips.replaceChildren();
 for(const d of nb?.definitions??[])chips.append(h("span",{class:"calc-chip"},d.name+(d.params.length?"("+d.params.join(",")+")":"")+" = "+d.text,h("button",{type:"button","aria-label":t("calc.chip.removeNamed",{name:d.name}),title:t("calc.chip.remove"),disabled,onclick:()=>runDefine(p.panelId,{name:d.name})},"×")));
 for(const [name,flags] of Object.entries(nb?.assumptions??{}))chips.append(h("span",{class:"calc-chip"},t("calc.chip.assumption",{name,flags:flags.join(", ")}),h("button",{type:"button","aria-label":t("calc.chip.removeAssumption",{name}),disabled,onclick:()=>runDefine(p.panelId,{name,assumptions:[]})},"×")));
 // cells, newest first
 ui.list.replaceChildren();
 const cells=[...(nb?.cells??[])].reverse();
 if(!cells.length)ui.list.append(h("p",{class:"calc-empty"},t("calc.cells.empty")));
 for(const c of cells)ui.list.append(cellView(p,c,nb,disabled));
}
function cellView(p,c,nb,disabled){
 const st=calcState(p.panelId),r=c.result,src=c.input.text??c.input.latex??(c.input.equations??[]).join("; ");
 const art=h("article",{class:"cell","data-state":c.state});
 art.append(h("div",{class:"cell-in"},h("code",null,src.length>160?src.slice(0,160)+"…":src),h("span",{class:"calc-chip"},OP_ZH[c.operation]??c.operation),
  c.state==="stale"?h("span",{class:"calc-chip warn",title:c.staleReason??""},t("calc.cell.stale")):null,
  r&&c.state!=="error"?h("span",{class:"calc-chip st-"+r.status},STATUS_ZH[r.status]??r.status):null));
 if(c.state==="error"){art.append(h("p",{class:"cell-err",role:"alert"},ERR_ZH(c.error)));}
 else if(r){
  const mathBox=h("div",{class:"cell-math",role:"img","aria-label":r.plain},texToMathML(r.latex??r.plain));
  art.append(mathBox,h("div",{class:"cell-plain"},h("code",null,r.plain)));
  if(r.approx)art.append(h("div",{class:"cell-approx"},"≈ ",h("code",null,r.approx.length>120?r.approx.slice(0,120)+"…":r.approx)));
  for(const w of r.warnings??[])art.append(h("p",{class:"cell-warn"},"⚠ "+w));
  if(c.state==="stale")art.append(h("p",{class:"cell-warn"},t("calc.cell.staleWarn",{reason:c.staleReason??t("calc.cell.upstreamChanged")})));
 }
 const here=(c.links??[]).filter(l=>l.canvas===imageId||ws?.items.some(i=>i.imageId===l.canvas));
 if(here.length)art.append(h("p",{class:"cell-link"},here.map(l=>t("calc.link.line",{object:l.object,status:l.status==="fresh"?t("calc.link.fresh"):l.status==="stale"?t("calc.link.stale"):l.status==="removed"?t("calc.link.removed"):l.status})).join(t("calc.link.sep"))));
 const plottable=r&&["exact","approximate"].includes(r.status)&&c.state==="fresh";
 const linkHere=here.find(l=>l.status!=="removed");
 const acts=h("div",{class:"cell-acts"},
  h("button",{type:"button",class:"primary",disabled:disabled||!plottable||(!imageId&&!ws),title:plottable?t("calc.plot.title"):t("calc.plot.unplottable"),onclick:()=>plotCell(p,c,linkHere)},linkHere?t("calc.plot.update"):t("calc.plot.draw")),
  c.state==="stale"||c.state==="error"?h("button",{type:"button",disabled,onclick:()=>recompute(p,c)},t("calc.cell.recompute")):null,
  h("button",{type:"button",onclick:()=>{st.editing=c.cellId;st.ui.input.value=src;st.ui.input.focus();setMsg(st,t("calc.msg.editing"),"");}},t("calc.cell.edit")),
  r?h("button",{type:"button",onclick:async()=>setMsg(st,(await copyText(r.latex))?t("calc.copy.latexDone"):t("calc.copy.latexFailed"),""),title:r.latex},t("calc.copy.latex")):null,
  r?h("button",{type:"button",onclick:async()=>setMsg(st,(await copyText(r.plain))?t("calc.copy.textDone"):t("calc.copy.failed"),""),},t("calc.copy.text")):null);
 art.append(acts);
 return art;
}
async function recompute(p,c){
 const st=calcState(p.panelId);if(st.busy)return;
 st.busy=true;st.ui.stop.hidden=false;setMsg(st,t("calc.msg.recomputing"),"");
 try{const r=await wbCall("surface_cas",{...(imageId?{imageId}:{}),capability:"recompute",params:{notebook:p.notebook,cell:c.cellId,job:newJob(st)}});setMsg(st,"","");applyRefresh(st,r);await wbRefresh();}
 catch(err){if(st.cancelled)setMsg(st,t("calc.msg.stoppedKept"),"");else setMsg(st,String(err.message||err),"error");}
 finally{st.busy=false;st.job=null;st.cancelled=false;st.ui.stop.hidden=true;renderCalc(p);}
}
async function plotCell(p,c,link){
 const st=calcState(p.panelId);
 const canvas=imageId??ws?.items[0]?.imageId;
 try{
  const params={notebook:p.notebook,cell:c.cellId,domain:wb.domain,...(link?{object:link.object}:{})};
  const r=await wbCall("surface_cas",{imageId:canvas,capability:"plot_result",params});
  if(Array.isArray(r.objects)){setObjects(r.objects);render();}
  setMsg(st,link?t("calc.msg.plotUpdated",{object:link.object}):t("calc.msg.plotted",{expression:r.data?.expression??""}),"");
  status.textContent=t("calc.msg.plottedStatus");
  await wbRefresh();
 }catch(err){setMsg(st,t("calc.msg.plotFailed",{message:String(err.message||err)}),"error");}
}
