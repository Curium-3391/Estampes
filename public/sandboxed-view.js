// ===== Sandboxed view: the `sandboxed-web` renderer (U3) =====
// Inlined after flow-view.js in the same scope (wb, h, t, wbCall, wbLoad, mvPointer, i18nLocale ...). A module draws one of its views with its own
// HTML and JavaScript, in an isolated frame this file builds. What makes it isolated is fixed here, never taken from the module:
//   - the frame is `sandbox="allow-scripts"` and nothing else (no same-origin, forms, popups, top navigation); it is read back and a different
//     value discards the frame;
//   - its document carries a CSP with no network (connect-src, frame-src, worker-src and form-action are 'none') and lets only scripts run whose
//     sha256 the host computed from bytes it checked against the package digest. CSP does not cover the frame navigating itself, so the widget also
//     adds frame-src about: to its own document (svLockFrames) and stops a frame that loads a second time;
//   - the only way out is one MessageChannel (estampes.ui/1): ready, action, report in; init, changed, result, error out. Messages are size- and
//     rate-limited and anything unknown is dropped and counted. An action can only be one of the view's own `actions`, through execute_module
//     with every check that has; the frame sees no session, no other module and no other capability.
// The files arrive through a loader (svLoadFiles). The default asks the module's host capability ui.get chunk by chunk; another transport only has
// to give the same { path -> bytes } map, which is checked against the digests the server sent for the view.
const SV={msgBytes:65536,perSecond:30,queue:8,readyMs:10000,paramBytes:32768,resultBytes:32768,minHeight:240};
const SV_CSP="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
const SV_SHIMS={
 "no-service-worker":"(function(){try{delete Navigator.prototype.serviceWorker;}catch(e){}try{if('serviceWorker' in navigator)Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:true});}catch(e){}})();",
 "memory-storage":"(function(){function mk(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;},setItem:function(k,v){d[String(k)]=String(v);},removeItem:function(k){delete d[k];},clear:function(){d={};},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k;},get length(){return Object.keys(d).length;}};}['localStorage','sessionStorage'].forEach(function(n){try{Object.defineProperty(window,n,{value:mk(),configurable:true});}catch(e){}});})();",
};
const SV_BRIDGE="(function(){var port=null,handlers={},seq=0,pending={},q=[];"+
 "function send(type,body){var m=body||{};m.schema='estampes.ui/1';m.type=type;m.id='f'+(++seq);if(port)port.postMessage(m);else q.push(m);return m.id;}"+
 "window.addEventListener('message',function(e){var d=e.data;if(port||e.source!==parent||!d||d.type!=='estampes.ui/port'||!e.ports[0])return;port=e.ports[0];"+
 "port.onmessage=function(ev){var m=ev.data;if(!m||m.schema!=='estampes.ui/1')return;"+
 "if((m.type==='result'||m.type==='error')&&pending[m.replyTo]){var p=pending[m.replyTo];delete pending[m.replyTo];if(m.type==='result')p.ok(m);else{var er=new Error(m.message||'failed');er.code=m.code;p.no(er);}return;}"+
 "(handlers[m.type]||[]).forEach(function(f){try{f(m);}catch(x){}});};q.splice(0).forEach(function(m){port.postMessage(m);});});"+
 "window.estampes={on:function(t,f){(handlers[t]=handlers[t]||[]).push(f);},ready:function(){send('ready',{});},"+
 "action:function(action,params,expectedRevision){return new Promise(function(ok,no){var id=send('action',{action:action,params:params||{},expectedRevision:expectedRevision});pending[id]={ok:ok,no:no};});},"+
 "report:function(data){send('report',{data:data});}};})();";
// CSP cannot stop a frame from navigating itself (location.href = "https://...?" + data). The navigation of a nested frame is checked against the frame-src of the
// document that holds it, so the widget adds a frame-src that allows only about: (the srcdoc page) to itself, once, before the first frame exists. A second load
// of a frame means it navigated anyway (a host that ignores the policy): the frame is then stopped.
let svLocked=false;
function svLockFrames(){
 if(svLocked)return;
 const m=document.createElement("meta");m.setAttribute("http-equiv","Content-Security-Policy");m.setAttribute("content","frame-src about:");
 document.head.append(m);svLocked=true;
}
const sv=new Map();// panelId -> state of one frame
const svState=id=>{let s=sv.get(id);if(!s){s={key:null,phase:"idle",stopped:false,frame:null,port:null,root:null,status:null,msg:"",inst:null,basis:null,own:false,ready:false,times:[],dropped:{rate:0,size:0,shape:0,type:0,denied:0},queue:0,chain:Promise.resolve(),report:null,reportAt:0,timer:null,watchdog:null,gen:0};sv.set(id,s);}return s;};
const svPanel=id=>openPanels().find(p=>p.panelId===id);
const svKey=def=>JSON.stringify([def.module,def.view,def.frame?.files,def.renderer?.payload]);
function svDispose(id){
 const s=sv.get(id);if(!s)return;
 s.gen++;clearTimeout(s.timer);clearTimeout(s.watchdog);
 try{s.port?.close();}catch{}
 s.frame?.remove();
 s.frame=null;s.port=null;s.ready=false;s.phase="idle";s.report=null;s.root=null;s.status=null;s.queue=0;s.chain=Promise.resolve();
}
const svHex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
// SHA-256 of bytes as a Uint8Array. The browser's own implementation when the host page has one (it needs a secure context); otherwise a plain one, so a
// host that withholds crypto.subtle does not silently skip the digest check.
function svSha256Plain(data){
 const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
 const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
 const len=data.length,padded=new Uint8Array(((len+9+63)>>6)<<6);padded.set(data);padded[len]=0x80;
 const dv=new DataView(padded.buffer);dv.setUint32(padded.length-8,Math.floor(len/0x20000000));dv.setUint32(padded.length-4,(len<<3)>>>0);
 const w=new Uint32Array(64),r=(x,n)=>(x>>>n)|(x<<(32-n));
 for(let o=0;o<padded.length;o+=64){
  for(let i=0;i<16;i++)w[i]=dv.getUint32(o+i*4);
  for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0;}
  let [a,b,c,d,e,f,g,hh]=H;
  for(let i=0;i<64;i++){
   const t1=(hh+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
   hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
  }
  H[0]+=a;H[1]+=b;H[2]+=c;H[3]+=d;H[4]+=e;H[5]+=f;H[6]+=g;H[7]+=hh;
 }
 const out=new Uint8Array(32),ov=new DataView(out.buffer);for(let i=0;i<8;i++)ov.setUint32(i*4,H[i]);
 return out;
}
async function svSha256Bytes(bytes){
 if(globalThis.crypto?.subtle){try{return new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));}catch{}}
 return svSha256Plain(bytes);
}
const svSha256=async bytes=>svHex(await svSha256Bytes(bytes));
// The default transport: one execute_module call of the module's own host capability ui.get per chunk.
async function svFetchViaHost(p,def,file){
 const parts=[];let offset=0,total=0;
 for(let i=0;i<4096;i++){
  const r=await wbCall("execute_module",{module:p.module,capability:def.frame.capability,params:{path:file.path,offset}});
  const d=r.data;
  if(!d||typeof d.chunk!=="string"||d.offset!==offset)throw new Error("bad chunk for "+file.path);
  const bin=atob(d.chunk),bytes=new Uint8Array(bin.length);for(let k=0;k<bin.length;k++)bytes[k]=bin.charCodeAt(k);
  parts.push(bytes);offset+=bytes.length;total+=bytes.length;
  if(d.done)break;
  if(!bytes.length||total>file.bytes)throw new Error("bad chunk for "+file.path);
 }
 const out=new Uint8Array(total);let at=0;for(const b of parts){out.set(b,at);at+=b.length;}
 return out;
}
// Returns Map path -> Uint8Array, every file checked against the size and digest the server named. Replaceable: wb.svTransport(p,def,file) -> bytes.
async function svLoadFiles(p,def){
 const get=typeof wb.svTransport==="function"?wb.svTransport:svFetchViaHost,out=new Map();
 for(const file of def.frame.files){
  const bytes=await get(p,def,file);
  if(bytes.length!==file.bytes||await svSha256(bytes)!==file.sha256)throw new Error(t("wb.sv.mismatch",{path:file.path}));
  out.set(file.path,bytes);
 }
 return out;
}
const svMime={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",svg:"image/svg+xml",woff2:"font/woff2"};
const svEsc=(txt,tag)=>txt.replace(new RegExp("</("+tag+")","gi"),"<\\/$1");
function svB64(bytes){let s="";for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));return btoa(s);}
// Builds the frame document: the entry page with its named scripts, styles and images inlined, the host's CSP first, then the shims and the bridge.
async function svBuild(def,files){
 const pl=def.renderer.payload,dec=new TextDecoder("utf-8"),base=pl.entry.replace(/[^/]*$/,"");
 const resolve=ref=>{if(!ref||/^([a-z][a-z0-9+.-]*:|\/)/i.test(ref))return null;const o=[];for(const seg of (base+ref.split(/[?#]/)[0]).split("/")){if(seg==="..")o.pop();else if(seg&&seg!==".")o.push(seg);}return o.join("/");};
 const doc=new DOMParser().parseFromString(dec.decode(files.get(pl.entry)),"text/html");
 for(const el of [...doc.querySelectorAll("base,meta[http-equiv],link[rel~=icon],link[rel~=preload],link[rel~=prefetch],iframe,object,embed")])el.remove();
 for(const el of [...doc.querySelectorAll("script[src]")]){
  const path=resolve(el.getAttribute("src")),bytes=path&&files.get(path);
  if(!bytes){el.remove();continue;}
  const s=doc.createElement("script");
  if(el.getAttribute("type"))s.setAttribute("type",el.getAttribute("type"));
  s.textContent=svEsc(dec.decode(bytes),"script");el.replaceWith(s);
 }
 for(const el of [...doc.querySelectorAll("link[rel~=stylesheet][href]")]){
  const path=resolve(el.getAttribute("href")),bytes=path&&files.get(path);
  if(!bytes){el.remove();continue;}
  const s=doc.createElement("style");s.textContent=svEsc(dec.decode(bytes),"style");el.replaceWith(s);
 }
 for(const el of [...doc.querySelectorAll("img[src]")]){
  const path=resolve(el.getAttribute("src")),bytes=path&&files.get(path),ext=(path||"").split(".").pop();
  if(bytes&&svMime[ext])el.setAttribute("src","data:"+svMime[ext]+";base64,"+svB64(bytes));else el.removeAttribute("src");
 }
 const head=doc.head,first=head.firstChild;
 const add=text=>{const s=doc.createElement("script");s.textContent=text;head.insertBefore(s,first);return s;};
 // Each is put before the module's own first head node, so the order in the document is: CSP, shims, bridge, then the module's own head content.
 for(const name of pl.shims??[])if(SV_SHIMS[name])add(SV_SHIMS[name]);
 add(SV_BRIDGE);
 const hashes=[];
 for(const s of doc.querySelectorAll("script")){
  const type=(s.getAttribute("type")||"").toLowerCase();
  if(s.hasAttribute("src")){s.remove();continue;}
  if(type&&!["text/javascript","application/javascript","module"].includes(type))continue;
  hashes.push("'sha256-"+btoa(String.fromCharCode(...await svSha256Bytes(new TextEncoder().encode(s.textContent))))+"'");
 }
 const meta=doc.createElement("meta");meta.setAttribute("http-equiv","Content-Security-Policy");
 meta.setAttribute("content",SV_CSP.replace("default-src 'none';","default-src 'none'; script-src "+(hashes.join(" ")||"'none'")+";"));
 head.insertBefore(meta,head.firstChild);
 return "<!doctype html>"+doc.documentElement.outerHTML;
}
function svSay(id,text,kind){const s=svState(id);s.msg=text;if(s.status){s.status.textContent=text;s.status.dataset.kind=kind||"";}}
function svSend(s,type,body){try{s.port?.postMessage({schema:"estampes.ui/1",id:"h"+Math.random().toString(16).slice(2,10),type,...body});}catch{}}
const svModel=def=>def.renderer.payload.state?.model??def.reads[0]??null;
async function svRead(p,def){
 const name=svModel(def),id=name&&def.bound?.[name];
 if(!id)return null;
 const r=await wbCall("execute_module",{module:p.module,capability:"models.get",params:{model:name,id}});
 const i=r.data?.instance;return i?{id:i.id,revision:i.revision,value:i.value}:null;
}
// Reads the bound instance and tells the frame when it changed (own: the change came from this frame's own action or report).
async function svSync(id){
 const s=sv.get(id),p=svPanel(id),def=wb.moduleViews?.[id];
 if(!s||!s.ready||!p||!def||def.unavailable||p.moduleState!=="enabled")return;
 const gen=s.gen;let inst;
 try{inst=await svRead(p,def);}catch(err){if(err.code!=="stale")svSay(id,t("wb.view.failed",{message:String(err.message||err)}),"error");return;}
 if(s.gen!==gen)return;
 if((inst?.revision??null)===(s.inst?.revision??null)&&(inst?.id??null)===(s.inst?.id??null))return;
 // A report waiting in the throttle window was based on the revision before this frame's own write; when this change is exactly that write (next revision of the same
 // instance), the report moves on to it. Any other change leaves the report on its old revision, so the store refuses it as stale.
 if(s.own&&inst&&s.report?.basis&&s.report.basis.id===inst.id&&s.report.basis.revision===s.basis?.revision&&inst.revision===s.basis.revision+1)s.report.basis={id:inst.id,revision:inst.revision};
 s.inst=inst;s.basis=inst?{id:inst.id,revision:inst.revision}:null;svSend(s,"changed",{revision:inst?.revision??null,data:inst?.value??null,own:s.own});s.own=false;
}
async function svRefreshAfter(id){const s=sv.get(id);if(!s)return;s.own=true;await wbLoad();await svSync(id);}
// Actions and reports run one at a time, in order; at most SV.queue wait. A job belongs to the frame it was queued for: after that frame is stopped,
// closed or reloaded it does not run, and what it was doing is not delivered to a newer frame. job(live) gets live(), true while its frame is current.
function svEnqueue(id,job,onFull){
 const s=sv.get(id);if(!s)return;
 if(s.queue>=SV.queue){onFull?.();return;}
 const gen=s.gen,live=()=>s.gen===gen&&s.port!==null;
 s.queue++;
 s.chain=s.chain.then(()=>live()?job(live):undefined).catch(()=>{}).finally(()=>{if(s.gen===gen)s.queue--;});
}
// What was dropped is counted per frame and shown as data-dropped on the view (for support and tests; it is not a message to the frame).
function svDrop(s,kind){s.dropped[kind]++;if(s.root)s.root.dataset.dropped=JSON.stringify(s.dropped);}
const svPlain=v=>v&&typeof v==="object"&&!Array.isArray(v);
function svDeny(id,s,m,code,message){svDrop(s,"denied");svSend(s,"error",{replyTo:m.id,code,message});}
function svAction(id,m){
 const s=sv.get(id),def=wb.moduleViews?.[id],p=svPanel(id);if(!s||!def||!p)return;
 if(typeof m.action!=="string"||!def.actions.includes(m.action))return svDeny(id,s,m,"not-allowed","this view cannot run "+JSON.stringify(m.action));
 const params=m.params??{};
 if(!svPlain(params)||JSON.stringify(params).length>SV.paramBytes)return svDeny(id,s,m,"input","params must be a plain object of at most "+SV.paramBytes+" characters");
 if(m.expectedRevision!==undefined&&m.expectedRevision!==null&&m.expectedRevision!==(s.inst?.revision??null))return svDeny(id,s,m,"conflict","the stored data changed since the frame read it");
 svEnqueue(id,async live=>{
  try{
   const r=await wbCall("execute_module",{module:p.module,capability:m.action,params});
   const data=r.data!==undefined&&JSON.stringify(r.data).length<=SV.resultBytes?r.data:undefined;
   if(live())svSend(s,"result",{replyTo:m.id,...(data!==undefined?{data}:{})});
  }catch(err){if(err.code!=="stale"&&live())svSend(s,"error",{replyTo:m.id,code:String(err.code||"failed"),message:String(err.message||err).slice(0,300)});}
  if(live())await svRefreshAfter(id);
 },()=>svDeny(id,s,m,"busy","too many actions waiting"));
}
// A report: the frame's latest state, kept at most once per minIntervalMs, written by the view's own action (never by the host directly).
function svReport(id,m){
 const s=sv.get(id),def=wb.moduleViews?.[id];if(!s||!def||!def.renderer.payload.state)return;
 // The report is based on the instance and revision the frame was last told about, not on what the host has seen since: a later edit then makes it conflict instead of being overwritten.
 s.report={data:m.data,basis:s.basis};
 const rp=def.renderer.payload.state.report,wait=Math.max(0,(rp.minIntervalMs??2000)-(Date.now()-s.reportAt));
 if(s.timer)return;
 s.timer=setTimeout(()=>{s.timer=null;svFlushReport(id);},wait);
}
function svFlushReport(id){
 const s=sv.get(id),def=wb.moduleViews?.[id],p=svPanel(id);
 if(!s||!def||!p||!s.report||p.moduleState!=="enabled")return;
 const {data,basis}=s.report;s.report=null;s.reportAt=Date.now();
 const rp=def.renderer.payload.state.report;
 let value=data;
 if(rp.path!==""){value=mvPointer(data,rp.path);}
 if(value===undefined)return;
 // A report based on "no instance yet" must not create a second one when an instance has appeared since; the frame is told about it and reports again.
 if(!basis&&s.inst){svSay(id,t("wb.sv.staleReport"),"error");return;}
 const params={[rp.param??"data"]:value};
 if(basis){params.id=basis.id;params.revision=basis.revision;}
 if(JSON.stringify(params).length>SV.paramBytes*2){svDrop(s,"size");return;}
 svEnqueue(id,async live=>{
  try{await wbCall("execute_module",{module:p.module,capability:rp.action,params});}
  catch(err){if(err.code!=="stale"&&live())svSay(id,t("wb.view.failed",{message:String(err.message||err)}),"error");}
  if(live())await svRefreshAfter(id);
 });
}
function svOnMessage(id,ev){
 const s=sv.get(id),def=wb.moduleViews?.[id];if(!s||!def||ev.target!==s.port)return;
 const now=Date.now();
 s.times=s.times.filter(x=>now-x<1000);
 if(s.times.length>=SV.perSecond){svDrop(s,"rate");return;}
 s.times.push(now);
 const m=ev.data;let size=0;
 try{size=JSON.stringify(m).length;}catch{svDrop(s,"shape");return;}
 if(size>SV.msgBytes){svDrop(s,"size");return;}
 if(!svPlain(m)||m.schema!=="estampes.ui/1"||typeof m.id!=="string"||m.id.length>64||typeof m.type!=="string"){svDrop(s,"shape");return;}
 if(m.type==="ready"){
  if(s.ready)return;
  s.ready=true;clearTimeout(s.watchdog);svSay(id,"","");
  s.basis=s.inst?{id:s.inst.id,revision:s.inst.revision}:null;
  svSend(s,"init",{locale:(typeof i18nLocale==="function"?i18nLocale():"")||"",view:def.view,title:def.title,actions:def.actions,revision:s.inst?.revision??null,instance:s.inst?{id:s.inst.id,revision:s.inst.revision}:null,data:s.inst?.value??null});
  return;
 }
 if(!s.ready){svDrop(s,"type");return;}
 if(m.type==="action")return svAction(id,m);
 if(m.type==="report")return svReport(id,m);
 svDrop(s,"type");
}
async function svStart(id){
 const s=svState(id),p=svPanel(id),def=wb.moduleViews?.[id];
 if(!p||!def||def.unavailable||!def.frame||s.phase!=="idle"||s.stopped)return;
 const el=wb.els.get(id),body=el?.querySelector(".wb-body");if(!body)return;
 const gen=++s.gen;s.phase="loading";s.msg="";
 const bar=h("div",{class:"sv-bar"},
  h("button",{class:"wb-mini sv-reload",type:"button",title:t("wb.sv.reload"),"aria-label":t("wb.sv.reload"),onclick:()=>{svDispose(id);const q=svState(id);q.stopped=false;q.inst=null;svStart(id);}},"↻"),
  h("button",{class:"wb-mini sv-stop",type:"button",title:t("wb.sv.stop"),"aria-label":t("wb.sv.stop"),onclick:()=>{svDispose(id);const q=svState(id);q.stopped=true;svDraw(id);}},"■"));
 s.status=h("p",{class:"wb-note mv-note sv-status",role:"status","aria-live":"polite"},t("wb.sv.loading"));
 s.root=h("div",{class:"sv"},bar,s.status);
 body.replaceChildren(s.root);
 try{
  const files=await svLoadFiles(p,def);
  if(s.gen!==gen)return;
  const html=await svBuild(def,files);
  if(s.gen!==gen)return;
  try{s.inst=await svRead(p,def);}catch{s.inst=null;}
  if(s.gen!==gen)return;
  const frame=h("iframe",{class:"sv-frame",title:def.title||def.view,referrerpolicy:"no-referrer"});
  frame.setAttribute("sandbox","allow-scripts");
  // Read back: anything but exactly allow-scripts means the frame is not what the host meant to build.
  if([...frame.sandbox].join(" ")!=="allow-scripts")throw new Error(t("wb.sv.badSandbox"));
  const ch=new MessageChannel();
  s.port=ch.port1;s.frame=frame;s.phase="running";
  ch.port1.onmessage=ev=>svOnMessage(id,ev);
  let loads=0;
  frame.addEventListener("load",()=>{
   if(s.gen!==gen)return;
   if(++loads>1){svDispose(id);const q=svState(id);q.stopped=true;q.msg=t("wb.sv.navigated");svDraw(id);return;}
   try{frame.contentWindow.postMessage({type:"estampes.ui/port"},"*",[ch.port2]);}catch{}
  });
  svLockFrames();
  frame.srcdoc=html;
  s.root.insertBefore(frame,s.status);
  s.watchdog=setTimeout(()=>{if(s.gen===gen&&!s.ready){svSay(id,t("wb.sv.noReady"),"error");}},SV.readyMs);
 }catch(err){
  if(s.gen!==gen)return;
  s.phase="failed";svSay(id,t("wb.view.failed",{message:String(err.message||err)}),"error");
 }
}
function svDraw(id){
 const el=wb.els.get(id),body=el?.querySelector(".wb-body"),s=svState(id);if(!body)return;
 if(s.stopped){
  body.replaceChildren(h("div",{class:"sv"},h("p",{class:"wb-note mv-note",role:"status"},s.msg||t("wb.sv.stopped")),
   h("button",{class:"wb-mini sv-reload",type:"button",onclick:()=>{s.stopped=false;s.inst=null;svStart(id);}},t("wb.sv.reload"))));
}
}
function renderSandboxedView(p){
 const id=p.panelId,def=wb.moduleViews?.[id],s=svState(id),el=wb.els.get(id),body=el?.querySelector(".wb-body");
 if(!body)return;
 const note=text=>{svDispose(id);body.replaceChildren(h("div",{class:"sv"},h("p",{class:"wb-note mv-note",role:"status"},text)));};
 if(!def||def.unavailable)return note(t("wb.view.unavailable"));
 if(p.moduleState!=="enabled")return note(t("wb.view.moduleOff"));
 if(!def.frame)return note(t("wb.view.none"));
 const key=svKey(def);
 if(s.key!==key){svDispose(id);s.key=key;s.stopped=false;s.inst=null;}
 if(s.phase==="idle"&&!s.stopped)svStart(id);
 else if(s.stopped&&!body.querySelector(".sv-reload"))svDraw(id);
 else if(s.root&&s.root.parentNode!==body)body.replaceChildren(s.root);
}
