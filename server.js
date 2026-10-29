import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {registerAppTool,registerAppResource,RESOURCE_MIME_TYPE} from "@modelcontextprotocol/ext-apps/server";
import {z} from "zod";
import {valueToX} from "./src/geometry.js";

const WIDGET="ui://estampes/number-line.html";
const html=readFileSync(join(dirname(fileURLToPath(import.meta.url)),"public/number-line.html"),"utf8");
function makeServer(){
  const server=new McpServer({name:"estampes",version:"0.1.0"});
  registerAppResource(server,"Estampes number line",WIDGET,{},async()=>({contents:[{uri:WIDGET,mimeType:RESOURCE_MIME_TYPE,text:html}]}));
  registerAppTool(server,"show_number_line",{
    title:"Show interactive number line",
    description:"Display an in-chat number line from -4 to 4, with the AI pointing at a specific tick. The user can point back and send a structured annotation into the conversation. Use for spatial communication tests.",
    inputSchema:{target:z.number().int().min(-4).max(4).describe("Number the AI wants to highlight")},
    outputSchema:{kind:z.literal("estampes.number_line"),target:z.number(),x:z.number()},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{resourceUri:WIDGET}}
  },async({target})=>({content:[{type:"text",text:"Estampes number line: AI pointed to "+target+". Ask the user to tap another number in the interactive widget."}],structuredContent:{kind:"estampes.number_line",target,x:valueToX(target)}}));
  return server;
}
const port=Number(process.env.PORT??8787);
createServer(async(req,res)=>{
  const url=new URL(req.url??"/","http://localhost");
  if(url.pathname==="/"&&req.method==="GET"){res.writeHead(200,{"content-type":"text/plain"}).end("Estampes MCP M0");return}
  if(url.pathname==="/mcp"&&req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type,mcp-session-id,mcp-protocol-version,accept","access-control-expose-headers":"Mcp-Session-Id"}).end();return}
  if(url.pathname==="/mcp"&&["GET","POST","DELETE"].includes(req.method)){
    const began=Date.now();
    // Diagnostic-only: observe method names, never record request parameters.
    let rpcMethod="unknown", chunks="", byteCount=0;
    req.on("data",chunk=>{
      byteCount+=chunk.length;
      if(byteCount<=16384) chunks+=chunk.toString("utf8");
    });
    req.on("end",()=>{
      if(byteCount>16384){rpcMethod="oversized";return}
      try{
        const body=JSON.parse(chunks);
        rpcMethod=Array.isArray(body) ? body.map(item=>String(item?.method??"response")).join(",") : String(body?.method??"response");
      }catch{rpcMethod=req.method==="GET"?"get":"unparsed"}
    });
    res.once("finish",()=>console.log("[mcp] method="+rpcMethod+" http="+req.method+" status="+res.statusCode+" ms="+(Date.now()-began)));
    res.setHeader("access-control-allow-origin","*");res.setHeader("access-control-expose-headers","Mcp-Session-Id");
    const server=makeServer(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on("close",()=>{void transport.close();void server.close()});
    try{await server.connect(transport);await transport.handleRequest(req,res)}catch(err){console.error(err);if(!res.headersSent)res.writeHead(500).end("MCP error")}
    return;
  }
  res.writeHead(404).end("Not found");
}).listen(port,()=>console.log("Estampes MCP server at http://localhost:"+port+"/mcp"));
