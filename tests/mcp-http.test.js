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
  const client=new Client({name:"estampes-smoke-test",version:"0.1.0"});
  try {
    let healthy=false;
    for(let i=0;i<80;i++){
      if(processHandle.exitCode!==null)break;
      try{const r=await fetch(base+"/");if(r.ok){healthy=true;break}}catch{}
      await sleep(100);
    }
    assert.ok(healthy,"server failed to start: "+output);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));
    assert.equal(client.getProtocolEra(),"modern");
    const tools=await client.listTools();
    const number=tools.tools.find(t=>t.name==="show_number_line");
    assert.ok(number,"number-line tool missing");
    assert.equal(number._meta?.ui?.resourceUri,"ui://estampes/number-line.html");
    const result=await client.callTool({name:"show_number_line",arguments:{target:2}});
    assert.equal(result.structuredContent?.target,2);
    assert.equal(result.structuredContent?.x,0.75);
    const resource=await client.readResource({uri:"ui://estampes/number-line.html"});
    const html=resource.contents.find(c=>c.uri==="ui://estampes/number-line.html");
    assert.ok(html?.text?.includes("Estampes · M0 Number Line"));
    assert.equal(html.mimeType,"text/html;profile=mcp-app");
  } finally {
    await client.close().catch(()=>{});
    processHandle.kill("SIGTERM");
  }
});
