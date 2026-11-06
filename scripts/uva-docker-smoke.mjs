// Real Node 22 image, private volume, read-only root, restart and disabled mode.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tag=process.argv[2]??'estampes:uva-beta',prefix='uva-smoke-'+randomBytes(4).toString('hex'),legacy=prefix+'-legacy',beta=prefix+'-beta',name=prefix+'-app';
let client,port;const evidence={image:tag,checks:[]};
const check=(ok,name)=>{if(!ok)throw Error(name);evidence.checks.push(name);};
async function connect(){
 for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:'+port+'/healthz')).ok)break;}catch{}await delay(500);}
 client=new Client({name:'uva-docker-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
}
async function start(enabled){
 docker('run','-d','--name',name,'--read-only','--tmpfs','/tmp:size=64m','-p','127.0.0.1::8787','-v',legacy+':/data','-v',beta+':/uva-beta','-e','ESTAMPES_REQUIRE_KEY=0','-e','ESTAMPES_ALLOW_OPEN=1','-e','ESTAMPES_UVA_BETA='+(enabled?'1':'0'),'-e','ESTAMPES_UVA_BETA_DIR=/uva-beta','-e','ESTAMPES_UVA_BETA_PROFILE=linux-process-crash-test',tag);
 port=docker('port',name,'8787/tcp').split(':').at(-1);await connect();
}
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return r.structuredContent;};
try{
 await start(true);check(docker('exec',name,'id','-u')==='1000','unprivileged uid 1000');check(docker('exec',name,'node','--version').startsWith('v22.'),'Node 22 runtime');
 const image=await sharp({create:{width:160,height:100,channels:3,background:'#e3cbb9'}}).png().toBuffer(),data=image.toString('base64');
 const uploaded=await call('upload_visual_image',{total:data.length,offset:0,data});
 const p=await call('experimental_workspace',{action:'prepare',requestId:'req:'+randomUUID(),operation:{type:'create',imageIds:[uploaded.imageId],title:'Docker restart'}});
 const written=await call('experimental_workspace',{action:'commit',prepared:p.prepared}),id=written.document.id;
 check(written.ack.durability==='process-crash-test','explicit non-durable ACK');
 const saved=await call('experimental_workspace',{action:'export',documentId:id});
 const expected=Buffer.from(await (await fetch(saved.url)).arrayBuffer());check(expected.length>0,'saved logical export with original image');
 await client.close();docker('restart',name);port=docker('port',name,'8787/tcp').split(':').at(-1);await connect();
 const reopened=await call('experimental_workspace',{action:'open',documentId:id});check(JSON.stringify(reopened.document)===JSON.stringify(written.document),'reopen after real container restart');
 const retry=await call('experimental_workspace',{action:'commit',prepared:p.prepared});check(JSON.stringify(retry.ack)===JSON.stringify(written.ack),'restart preserves exact Ledger ACK replay');
 await client.close();docker('rm','-f',name);await start(false);
 const tools=await client.listTools();check(!tools.tools.some(t=>t.name==='experimental_workspace'),'Beta disabled by default path');check(tools.tools.some(t=>t.name==='present_visual'),'legacy tool contract survives');
 const legacyState=await call('get_visual_state',{imageId:uploaded.imageId});check(Boolean(legacyState),'original legacy image still accessible');
 const url='http://127.0.0.1:'+port+'/export/uva/'+saved.exportId+'.zip';const after=Buffer.from(await (await fetch(url)).arrayBuffer());check(after.equals(expected),'saved export accessible with Beta disabled');
 evidence.production='NOT QUALIFIED';evidence.host='Docker in managed Linux environment; not native host/power-loss acceptance';
 if(process.env.ESTAMPES_UVA_SMOKE_REPORT)await writeFile(process.env.ESTAMPES_UVA_SMOKE_REPORT,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
}catch(error){try{console.error(docker('logs',name));}catch{}throw error;}finally{await client?.close().catch(()=>{});try{docker('rm','-f',name);}catch{}for(const v of [legacy,beta])try{docker('volume','rm',v);}catch{}}
