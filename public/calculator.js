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
