import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function freePort() {
  const s=createServer();
  await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}

test("MCP discovers tools, calls show_number_line, and reads its inline UI", { timeout:30000 }, async () => {
  const port=await freePort();
  const base="http://127.0.0.1:"+port;
  const processHandle=spawn(process.execPath,["server.js"],{
    cwd:process.cwd(),
    env:{...process.env,PORT:String(port)},
    stdio:["ignore","pipe","pipe"],
  });
  let output="";
  processHandle.stderr.on("data",buf=>{output+=buf.toString()});
  processHandle.stdout.on("data",buf=>{output+=buf.toString()});
  const client=new Client(
    {name:"estampes-smoke-test",version:"0.1.0"},
    {versionNegotiation:{mode:"auto"}}
  );
  try {
    let healthy=false;
    for(let i=0;i<80;i++){
      if(processHandle.exitCode!==null)break;
      try{const r=await fetch(base+"/");if(r.ok){healthy=true;break}}catch{}
      await sleep(100);
    }
    assert.ok(healthy,"server failed to start: "+output);
    const versionResponse=await fetch(base+"/version",{cache:"no-store"});
    assert.equal(versionResponse.status,200);
    const version=await versionResponse.json();
    assert.equal(version.version,"m0.4.5");
    assert.equal(version.visualDisplayTool,"present_visual_evidence");
    assert.equal(version.visualEvidencePresentation,"explicit-render-tool");
    assert.equal(version.visualEvidenceResourceUri,"ui://estampes/visual-evidence-v045.html");
    assert.equal(version.visualEvidencePresentation,"inline-mcp-app");
    assert.equal(version.visualInputTool,"inspect_visual");
    assert.equal(version.visualInputFormat,"mcp-image-content-png");
    assert.equal(version.visualModelVisibility,"host-dependent-unverified");
    assert.equal(version.annotationProtocol,"0.2-draft");
    assert.equal(version.visualResourceUri,"ui://estampes/visual-surface-v043.html");
    assert.equal(version.visualTool,"present_visual");
    assert.equal(version.visualValidationTool,"validate_visual_annotations");
    assert.equal(version.uiResourceUri,"ui://estampes/number-line-v031.html");
    assert.equal(version.selectionTool,"record_number_line_selection");
    await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));
    assert.equal(client.getProtocolEra(),"modern");
    const tools=await client.listTools();
    const number=tools.tools.find(t=>t.name==="show_number_line");
    assert.ok(number,"number-line tool missing");
    assert.equal(number._meta?.ui?.resourceUri,"ui://estampes/number-line-v031.html");
    const result=await client.callTool({name:"show_number_line",arguments:{target:2}});
    assert.equal(result.structuredContent?.target,2);
    assert.equal(result.structuredContent?.x,0.75);
    // M0.3: the previously missing app-scoped tool must be present and callable.
    const selectionTool=tools.tools.find(t=>t.name==="record_number_line_selection");
    assert.ok(selectionTool,"UI selection tool missing from MCP discovery");
    assert.equal(selectionTool._meta?.ui?.resourceUri,undefined,"app-only tool must not advertise a widget");
    assert.equal(selectionTool._meta?.["ui/resourceUri"],undefined,"no legacy UI alias on private tool");
    assert.deepEqual(selectionTool._meta?.ui?.visibility,["app"]);
    const selection=await client.callTool({
      name:"record_number_line_selection",
      arguments:{value:-2}
    });
    assert.notEqual(selection.isError,true);
    assert.equal(selection.structuredContent?.kind,"estampes.user_selection");
    assert.equal(selection.structuredContent?.value,-2);
    assert.equal(selection.structuredContent?.x,0.25);
    assert.equal(selection.structuredContent?.y,0.5);
    // Generic canvas: model annotations, app-only validation, HTML resource.
    const visualTool=tools.tools.find(t=>t.name==="present_visual");
    assert.ok(visualTool,"present_visual tool missing");
    assert.equal(visualTool._meta?.ui?.resourceUri,"ui://estampes/visual-surface-v043.html");
    const visualAnnotation={id:"a1",type:"rect",x:0.10,y:0.20,x2:0.35,y2:0.66,label:"Example"};
    const visual=await client.callTool({name:"present_visual",arguments:{
      scene:"shapes",annotations:[visualAnnotation]
    }});
    assert.equal(visual.structuredContent?.kind,"estampes.visual_surface");
    assert.equal(visual.structuredContent?.scene,"shapes");
    assert.equal(visual.structuredContent?.annotations?.[0]?.id,"a1");
    // Grounded scene landmarks override model-guessed coordinates.
    const grounded=await client.callTool({name:"present_visual",arguments:{
      scene:"landscape",
      annotations:[{id:"mountain-point",type:"point",targetId:"mountain-right",
                    x:0.82,y:0.49,label:"山"}],
      priorUserAnnotations:[{id:"user-old",type:"point",x:0.25,y:0.5,label:"YOU 1"}]
    }});
    assert.notEqual(grounded.isError,true);
    const mountain=grounded.structuredContent?.annotations?.find(a=>a.id==="mountain-point");
    assert.equal(mountain?.x,0.5625);
    assert.ok(Math.abs(mountain?.y-130/360)<1e-9);
    assert.equal(mountain?.targetId,"mountain-right");
    assert.equal(mountain?.author,"assistant");
    assert.equal(mountain?.grounding,"scene-anchor");
    const replayed=grounded.structuredContent?.annotations?.find(a=>a.id==="user-old");
    assert.equal(replayed?.author,"user");
    assert.equal(replayed?.grounding,"replayed-unverified");
    const ungrounded=await client.callTool({name:"present_visual",arguments:{
      scene:"landscape",annotations:[{id:"free-point",type:"point",x:0.82,y:0.49,label:"山"}]
    }});
    assert.equal(ungrounded.structuredContent?.annotations?.[0]?.grounding,"unverified");
    const privateTool=tools.tools.find(t=>t.name==="validate_visual_annotations");
    assert.ok(privateTool,"validation tool missing");
    assert.deepEqual(privateTool._meta?.ui?.visibility,["app"]);
    assert.equal(privateTool._meta?.ui?.resourceUri,undefined);
    const userMarks=[{id:"user-1",type:"point",x:0,y:1,label:"Edge"},
      {id:"user-2",type:"arrow",x:0.1,y:0.3,x2:0.9,y2:0.8,label:"Direction"}];
    const checked=await client.callTool({name:"validate_visual_annotations",arguments:{
      scene:"landscape",annotations:userMarks
    }});
    assert.notEqual(checked.isError,true);
    assert.equal(checked.structuredContent?.count,2);
    assert.equal(checked.structuredContent?.annotations?.length,2);
    assert.deepEqual(checked.structuredContent?.annotations?.map(m=>m.author),["user","user"]);
    assert.deepEqual(checked.structuredContent?.annotations?.map(m=>m.grounding),["user-pointer","user-pointer"]);
    assert.equal(checked.structuredContent?.annotations?.[0]?.x,0);
    assert.equal(checked.structuredContent?.event?.schemaVersion,"0.2-draft");
    assert.equal(checked.structuredContent?.event?.image?.intrinsicSize?.unit,"svg-user-unit");
    assert.equal(checked.structuredContent?.event?.interaction?.replyTo?.messageId,null);
    assert.match(checked.structuredContent?.chatMessage,/這次的目的/);
    const contextReply=await client.callTool({name:"validate_visual_annotations",arguments:{
      scene:"landscape",
      annotations:[userMarks[1]],
      intent:"correct-assistant",
      note:"不是後面的山，是這棵樹",
      replyQuote:"你指的是哪座山？"
    }});
    assert.notEqual(contextReply.isError,true);
    const event=contextReply.structuredContent?.event;
    assert.equal(event?.schemaVersion,"0.2-draft");
    assert.equal(event?.interaction?.intent,"correct-assistant");
    assert.equal(event?.interaction?.userNote,"不是後面的山，是這棵樹");
    assert.equal(event?.interaction?.replyTo?.provenance,"user-entered");
    assert.equal(event?.annotations?.[0]?.arrowhead,"end");
    assert.match(contextReply.structuredContent?.chatMessage,/你指的是哪座山/);
    assert.match(contextReply.structuredContent?.chatMessage,/箭頭尖端/);
    // Some MCP clients represent schema rejection as a tool error result,
    // others raise a protocol error. Both are valid rejections.
    let rejected=false;
    try {
      const bad=await client.callTool({name:"validate_visual_annotations",arguments:{
        scene:"landscape",annotations:[{id:"bad",type:"rect",x:1.5,y:0.2}]
      }});
      rejected=bad.isError===true;
    } catch {
      rejected=true;
    }
    assert.ok(rejected,"out-of-range rectangle must be rejected");
    // Model-only visual input bridge: verify that the MCP response contains
    // actual PNG images, not merely structured coordinate JSON.
    const inspectTool=tools.tools.find(t=>t.name==="inspect_visual");
    assert.ok(inspectTool,"inspect_visual must be model-callable");
    assert.equal(inspectTool._meta?.ui?.resourceUri,undefined);
    const renderTool=tools.tools.find(t=>t.name==="present_visual_evidence");
    assert.ok(renderTool,"presenter must be in tool discovery");
    assert.equal(renderTool._meta?.ui?.resourceUri,"ui://estampes/visual-evidence-v045.html");
    const evidenceUi=await client.readResource({uri:"ui://estampes/visual-evidence-v045.html"});
    const evidenceHtml=evidenceUi.contents.find(c=>c.uri==="ui://estampes/visual-evidence-v045.html");
    assert.ok(evidenceHtml?.text?.includes("Estampes · Visual Evidence"));
    assert.ok(evidenceHtml?.text?.includes("v0.4.5"));
    assert.match(evidenceHtml.text,/ui\/notifications\/tool-result/);
    assert.match(evidenceHtml.text,/data:image\/png;base64/);
    const preview=await client.callTool({name:"present_visual_evidence",arguments:{
      scene:"landscape",imageId:"demo:landscape",revision:"svg-v1",
      focus:{type:"point",x:0.82,y:0.49}
    }});
    assert.notEqual(preview.isError,true);
    assert.equal(preview.structuredContent?.kind,"estampes.visual_evidence_view");
    assert.equal(preview.structuredContent?.rendered?.mimeType,"image/png");
    for(const name of ["original","marked","crop"]){
      const bytes=Buffer.from(preview.structuredContent?.images?.[name]??"","base64");
      assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    }
    const visualEvidence=await client.callTool({name:"inspect_visual",arguments:{
      scene:"landscape",imageId:"demo:landscape",revision:"svg-v1",
      focus:{type:"rect",x:0.1,y:0.42,x2:0.4,y2:0.92}
    }});
    assert.notEqual(visualEvidence.isError,true);
    assert.equal(visualEvidence.structuredContent?.kind,"estampes.visual_evidence");
    assert.equal(visualEvidence.structuredContent?.evidenceCount,3);
    assert.equal(visualEvidence.structuredContent?.source?.logicalSize?.unit,"svg-user-unit");
    assert.equal(visualEvidence.structuredContent?.modelVisionStatus,"host-dependent-unverified");
    const images=visualEvidence.content.filter(item=>item.type==="image");
    assert.equal(images.length,3,"original, marked view and raw crop must be image blocks");
    for(const img of images){
      assert.equal(img.mimeType,"image/png");
      const bytes=Buffer.from(img.data,"base64");
      assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    }
    assert.match(visualEvidence.content[0]?.text,/image pixels|PNG pixels|real PNG pixels/i);
    const chatHelp=checked.structuredContent?.chatMessage??"";
    assert.match(chatHelp,/inspect_visual/);
    const visualResource=await client.readResource({uri:"ui://estampes/visual-surface-v043.html"});
    const visualHtml=visualResource.contents.find(c=>c.uri==="ui://estampes/visual-surface-v043.html");
    assert.equal(visualHtml?.mimeType,"text/html;profile=mcp-app");
    assert.ok(visualHtml?.text?.includes("v0.4.3"));
    assert.ok(visualHtml?.text?.includes('name:"validate_visual_annotations"'));
    const resource=await client.readResource({uri:"ui://estampes/number-line-v031.html"});
    const html=resource.contents.find(c=>c.uri==="ui://estampes/number-line-v031.html");
    assert.ok(html?.text?.includes("Estampes · M0 Number Line"));
    assert.equal(html.mimeType,"text/html;profile=mcp-app");
    assert.ok(html.text.includes("v0.3.1"),"UI resource is stale");
    assert.ok(html.text.includes('name:"record_number_line_selection"'));
    assert.ok(html.text.includes('request("ui/message"'));
  } finally {
    await client.close().catch(()=>{});
    processHandle.kill("SIGTERM");
  }
});
