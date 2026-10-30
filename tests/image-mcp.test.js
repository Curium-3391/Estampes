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

test("image tools are discoverable with ChatGPT file params and fail safely",{timeout:30000},async()=>{
  const port=await freePort();
  const handle=spawn(process.execPath,["server.js"],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},stdio:"ignore"});
  const base="http://127.0.0.1:"+port;
  const client=new Client({name:"image-test",version:"0"},{versionNegotiation:{mode:"auto"}});
  try{
    for(let i=0;i<80;i++){try{if((await fetch(base+"/")).ok)break}catch{}await sleep(100)}
    const version=await (await fetch(base+"/version")).json();
    assert.deepEqual(version.imageTools,["load_image","process_image","overlay_grid","inspect_image","get_derived_view","register_images","compare_images","assess_image","calibrate_scale","measure_image","render_pdf_page","detect_features"]);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));
    const {tools}=await client.listTools();
    const load=tools.find(t=>t.name==="load_image");
    assert.deepEqual(load._meta?.["openai/fileParams"],["image"]);
    // ChatGPT's file object contract: all four fields declared, only url+id required.
    const file=load.inputSchema.properties.image;
    assert.deepEqual(Object.keys(file.properties).sort(),["download_url","file_id","file_name","mime_type"]);
    assert.deepEqual([...file.required].sort(),["download_url","file_id"]);
    assert.equal(file.additionalProperties,false);
    for(const name of ["process_image","overlay_grid","inspect_image","get_derived_view","register_images","compare_images","assess_image","calibrate_scale","measure_image","render_pdf_page","detect_features"]){
      const tool=tools.find(t=>t.name===name);
      assert.ok(tool,name+" missing");
      assert.equal(tool._meta?.ui?.resourceUri,undefined,name+" is model-only");
    }
    const neither=await client.callTool({name:"load_image",arguments:{}});
    assert.equal(neither.isError,true);
    const insecure=await client.callTool({name:"load_image",arguments:{imageUrl:"http://example.com/a.png"}});
    assert.equal(insecure.isError,true);
    assert.match(insecure.content[0].text,/https/);
    const local=await client.callTool({name:"load_image",arguments:{imageUrl:"https://127.0.0.1/a.png"}});
    assert.match(local.content[0].text,/public/);
    const missing=await client.callTool({name:"process_image",arguments:{imageId:"img:0123456789abcdef"}});
    assert.equal(missing.isError,true);
    assert.match(missing.content[0].text,/load_image again/);
  }finally{await client.close().catch(()=>{});handle.kill()}
});
