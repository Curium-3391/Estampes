import test from "node:test";
import assert from "node:assert/strict";
import { inlineWorkbench } from "../src/surface/widget-source.js";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

// GitHub's Ubuntu runners include Chrome; their chromium command may be a
// snap launcher that reports a version but cannot launch a headless browser.
const browser = (process.env.CHROMIUM_BIN ? [process.env.CHROMIUM_BIN] : ["google-chrome", "chromium"])
  .find(candidate => spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0);
const available = !!browser;

test("finding groups: compact rows, detail drilldown, canvas selection and review drafts", { skip: !available && "Chromium unavailable", timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-findings-"));
  try {
    const html = inlineWorkbench(readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8"));
    const probe = String.raw`
(async()=>{
const check=(ok,message)=>{if(!ok)throw Error(message);};
const tick=()=>new Promise(r=>setTimeout(r,40));
try{
 imageId="img:0123456789abcdef";ready=true;photo=null;pair=null;ws=null;frames=null;
 layers=[{id:"L1",name:"YOU 3：框內走線",author:"assistant"}];
 assistantMarks=Array.from({length:22},(_,i)=>({id:"trace-"+i,type:"polyline",author:"assistant",layer:"L1",
   label:"走線 "+(i+1),x:.2,y:.15+i*.03,x2:.7,y2:.15+i*.03,points:[{x:.2,y:.15+i*.03},{x:.7,y:.15+i*.03}],
   confidence:"high",note:"可見走線；".repeat(20),status:"inspected",ambiguities:["未量測電阻"],
   evidence:[{observer:"model",says:"看見路徑",region:[.2,.1,.7,.2],image:imageId}]}));
 priorUserMarks=[];userMarks=[];hiddenLayers.clear();mode="select";
 let reviewCall=null,layerCall=null;
 request=async(method,params)=>{
   if(params?.name==="edit_visual_canvas"){
     layerCall=params.arguments;
     const updated=layers.map(l=>({...l,...layerCall.layers?.find(edit=>edit.id===l.id)}));
     return {structuredContent:{kind:"estampes.canvas_edit",imageId,annotations:[...assistantMarks,...priorUserMarks],layers:updated,edits:[]}};
   }
   if(params?.name==="review_visual_finding"){
     reviewCall=params.arguments;return {structuredContent:{mark:{id:reviewCall.markId,review:reviewCall.review,reviewReason:reviewCall.reason}}};
   }
   return {};
 };
 resetFindings();render();
 check(findingsEl.querySelectorAll(".finding-group").length===1,"one layer group");
 check(!layersEl.querySelector("#layer-manager").open,"collapsed by default");
 check(findingsEl.textContent.includes("22 項 · 22 待確認"),"pending count");
 check(layersEl.getBoundingClientRect().height<65,"collapsed manager is one line");
 check(!findingsEl.querySelector(".finding-detail"),"details are not rendered initially");
 layersEl.querySelector("summary").click();await tick();
 findingsEl.querySelector("[data-act=evidence]").click();await tick();
 check(findingsEl.querySelectorAll(".finding-row").length===22,"22 compact rows");
 check([...findingsEl.querySelectorAll(".finding-row")].every(r=>r.getBoundingClientRect().height<50),"each row stays compact");
 findingRowFor("trace-0").click();
 check(selected==="trace-0"&&viewMode==="annotated"&&cam,"row selects and locates line");
 check(outlineEl.querySelector("path"),"selected ink is highlighted");
 check(!findingsEl.querySelector(".finding-detail"),"first click only locates");
 findingRowFor("trace-0").click();
 check(findingsEl.querySelectorAll(".finding-detail").length===1,"second click opens one detail");
 const reason=findingsEl.querySelector("input.reason");reason.value="線路在此中斷";reason.dispatchEvent(new Event("input",{bubbles:true}));
 reason.focus();reason.setSelectionRange(2,4);render();
 check(findingsEl.querySelector("input.reason").value==="線路在此中斷","draft survives redraw");
 check(document.activeElement.matches("input.reason")&&document.activeElement.selectionStart===2,"typing focus and caret survive");
 findingsEl.querySelector("[data-evidence]").click();
 check(selectedEvidence&&openFinding==="trace-0","evidence action retains detail");
 findingRowFor("trace-1").click();findingRowFor("trace-1").click();
 check(findingsEl.querySelectorAll(".finding-detail").length===1,"only one detail open");
 // A real pointer sequence on the canvas opens the selected mark's group/detail.
 findingGroupsOpen.clear();openFinding=null;cam=null;viewMode="annotated";render();
 const point=svg.createSVGPoint();point.x=.45*VW;point.y=(.15+2*.03)*VH;
 const screen=point.matrixTransform(svg.getScreenCTM());
 for(const type of ["pointerdown","pointerup"])hit.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,clientX:screen.x,clientY:screen.y}));
 await tick();
 check(openFinding==="trace-2"&&layersEl.querySelector("#layer-manager").open&&!findingsEl.querySelector(".layer-evidence").hidden,"canvas click opens matching detail");
 // Return to first row; draft persists even after another mark and canvas clicks.
 findingRowFor("trace-0").click();findingRowFor("trace-0").click();
 check(findingsEl.querySelector("input.reason").value==="線路在此中斷","draft survives changing selection");
 findingsEl.querySelector('[data-review="rejected"]').click();await tick();
 check(reviewCall.markId==="trace-0"&&reviewCall.reason==="線路在此中斷","review keeps mark identity and reason");
 check(findingsEl.textContent.includes("22 項 · 21 待確認"),"pending count updates after review");
 check(findingRowFor("trace-0").textContent.includes("你已否決"),"row reflects verdict");
 check(openFinding==="trace-0","review does not close detail");
 hiddenLayers.add("L1");render();check(!findingsEl.querySelector(".finding-row"),"hidden layer evidence omitted");
 check(findingsEl.querySelector("[data-act=toggle]"),"hidden layer controls remain accessible");
 hiddenLayers.clear();resetFindings();render();check(!layersEl.querySelector("#layer-manager").open,"new canvas resets expansion");
 // Evidence recency does not mutate ink or layer stacking.
 const beforeIds=assistantMarks.map(m=>m.id).join(","),beforeLayers=layers.map(l=>l.id).join(",");
 assistantMarks[3].findingUpdatedAt=100;assistantMarks[7].findingUpdatedAt=200;
 layersExpanded=true;findingGroupsOpen.add("L1");render();
 check(findingsEl.querySelector(".finding-row").dataset.mark==="trace-7","newest evidence first");
 check(assistantMarks.map(m=>m.id).join(",")===beforeIds&&layers.map(l=>l.id).join(",")===beforeLayers,"evidence sorting leaves stacking intact");
 for(const act of ["toggle","rename","opacity","lock","up","down"])check(findingsEl.querySelector("[data-act="+act+"]"),"original layer control: "+act);
 const expandedBefore=findingGroupsOpen.has("L1");
 findingsEl.querySelector("[data-act=toggle]").click();await tick();
 check(layerCall.layers[0].id==="L1"&&layerCall.layers[0].visible===false&&layers.find(l=>l.id==="L1").visible===false,"visibility control persists shared visibility");
 check(!findingsEl.querySelector(".finding-row")&&findingGroupsOpen.has("L1")===expandedBefore,"visibility control hides evidence without changing expansion");
 objects=[{id:"o1",type:"axes-2d",primitives:[],editable:{xRange:[-3,3],yRange:[-2,2],title:"y = sin(x)"}},
   {id:"o2",type:"function-plot",primitives:[],editable:{expression:"sin(2*x)",domain:null,labelMode:"custom",label:"sin(x)"}}];
 render();
 check(objectsPanel.querySelector('[aria-label="圖表標題"]').value==="y = sin(x)","axes title is explicitly editable");
 const labelMode=objectsPanel.querySelector('[aria-label="曲線標籤模式"]');
 check(labelMode.value==="custom","legacy custom label remains explicit");
 labelMode.value="auto";labelMode.dispatchEvent(new Event("change"));
 check(objectsPanel.querySelector('[aria-label="自訂曲線標籤"]').disabled,"auto labels disable custom text field");
 objects=[];canRestoreObjects=true;render();
 check(!objectsPanel.hidden&&objectsPanel.textContent.includes("復原上次刪除的物件"),"restore stays reachable when last object is deleted");
 assistantMarks=[];priorUserMarks=[];userMarks=[];objects=[];hiddenLayers.clear();
 ws={id:"ws:0123456789abcdef",items:[{id:"wi-1",imageId,objects:[{id:"o90",type:"function-plot",layer:"L9",primitives:[{k:"path",pts:[[0,.5],[1,.5]],stroke:"#579DF6",width:3}]}]}]};
 frames={"wi-1":{x0:0,y0:0,w:400,h:300,rot:0}};
 layers=[{id:"W1_L9",name:"Graph",author:"assistant"}];baseAsObject=false;viewMode="annotated";render();
 check(document.querySelector('#unified-layers [data-object="o90"] path'),"workspace renders Graph primitives");
 check(findingsEl.querySelector('[data-layer="W1_L9"]'),"workspace object-only layer controls remain visible");
 document.body.dataset.findingTest="passed";
}catch(error){document.body.dataset.findingTest="failed: "+error.stack;}
})();
`;
    const page = join(dir, "probe.html");
    writeFileSync(page, html.replace("<head>","<head><script>window.addEventListener('error',e=>document.body.dataset.findingTest='error: '+e.message)</script>").replace("// __ESTAMPES_VIEWER_END__", () => probe));
    const server=createServer((req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(readFileSync(page));});
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const child = spawn(browser, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", "--user-data-dir="+join(dir,"profile"), "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore","ignore","pipe"] });
    let socket;
    try {
      const port = await new Promise((resolve,reject)=>{
        let log="";const timer=setTimeout(()=>reject(Error("Browser startup timed out: "+log.slice(-4000))),20000);
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("exit",code=>{clearTimeout(timer);reject(Error("Browser exited before startup ("+code+"): "+log.slice(-4000)));});
        child.stderr.on("data",chunk=>{log+=chunk;const match=log.match(/DevTools listening on ws:\/\/127.0.0.1:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
      });
      const target=await (await fetch("http://127.0.0.1:"+port+"/json/new?"+encodeURIComponent("http://127.0.0.1:"+server.address().port),{method:"PUT"})).json();
      socket=new WebSocket(target.webSocketDebuggerUrl);
      await new Promise(resolve=>socket.addEventListener("open",resolve,{once:true}));
      let seq=0;const pending=new Map();
      socket.addEventListener("message",e=>{const r=JSON.parse(e.data);if(r.id){pending.get(r.id)?.(r);pending.delete(r.id);}});
      const call=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
      let outcome;
      for(let i=0;i<100;i++){
        const r=await call("Runtime.evaluate",{expression:"document.body?.dataset.findingTest",returnByValue:true});
        outcome=r.result?.result?.value;if(outcome)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(outcome,"passed");
    } finally {
      server.close();
      // Let Chrome flush and close its profile before removing the directory.
      if(socket?.readyState===WebSocket.OPEN){
        socket.send(JSON.stringify({id:999999,method:"Browser.close"}));
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      socket?.close();
      // Chrome launchers can exit before their subprocesses. Terminate this
      // test's process group so profile writers cannot outlive teardown.
      if(child.pid){
        try{process.platform!=="win32"?process.kill(-child.pid,"SIGTERM"):child.kill();}
        catch(error){if(error.code!=="ESRCH")throw error;}
      }
      if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once("exit",resolve));
    }

  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
