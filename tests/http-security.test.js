import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

async function freePort() {
  const s=createServer();
  await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}

async function startServer(env) {
  const port=await freePort();
  const handle=spawn(process.execPath,["server.js"],{
    cwd:process.cwd(),env:{...process.env,PORT:String(port),...env},stdio:"ignore",
  });
  const base="http://127.0.0.1:"+port;
  for(let i=0;i<80;i++){
    try{if((await fetch(base+"/")).ok)return {base,handle}}catch{}
    await sleep(100);
  }
  handle.kill();
  throw new Error("server failed to start");
}

const initialize=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
  protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"security-test",version:"0"}
}});
const post=(url,headers={})=>fetch(url,{method:"POST",body:initialize,headers:{
  "content-type":"application/json",accept:"application/json, text/event-stream",...headers
}});

test("access key gates /mcp but not health or version",{timeout:30000},async()=>{
  const {base,handle}=await startServer({ESTAMPES_ACCESS_KEY:"s3cret"});
  try{
    assert.equal((await fetch(base+"/")).status,200);
    const version=await (await fetch(base+"/version")).json();
    assert.equal(version.accessKeyRequired,true);
    assert.equal((await post(base+"/mcp")).status,401);
    assert.equal((await post(base+"/mcp?key=wrong")).status,401);
    assert.notEqual((await post(base+"/mcp?key=s3cret")).status,401);
    assert.notEqual((await post(base+"/mcp",{authorization:"Bearer s3cret"})).status,401);
  }finally{handle.kill()}
});

test("rate limit returns 429 and CORS follows the allowlist",{timeout:30000},async()=>{
  const {base,handle}=await startServer({
    ESTAMPES_RATE_LIMIT_PER_MIN:"2",ESTAMPES_CORS_ORIGINS:"https://ok.example"
  });
  try{
    const allowed=await fetch(base+"/mcp",{method:"OPTIONS",headers:{origin:"https://ok.example"}});
    assert.equal(allowed.headers.get("access-control-allow-origin"),"https://ok.example");
    const denied=await fetch(base+"/mcp",{method:"OPTIONS",headers:{origin:"https://evil.example"}});
    assert.equal(denied.headers.get("access-control-allow-origin"),null);
    assert.notEqual((await post(base+"/mcp")).status,429);
    assert.notEqual((await post(base+"/mcp")).status,429);
    const limited=await post(base+"/mcp");
    assert.equal(limited.status,429);
    assert.equal(limited.headers.get("retry-after"),"60");
  }finally{handle.kill()}
});
