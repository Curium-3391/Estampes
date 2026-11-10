// Real Node 22 image, private volume, read-only root: a canvas edit is
// committed to the default UVA store and survives a container restart.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tag=process.argv[2]??'estampes:local',prefix='uva-smoke-'+randomBytes(4).toString('hex'),legacy=prefix+'-legacy',beta=prefix+'-beta',name=prefix+'-app';
let client,port;const evidence={image:tag,checks:[]};
const check=(ok,name)=>{if(!ok)throw Error(name);evidence.checks.push(name);};
async function connect(){
 for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:'+port+'/healthz')).ok)break;}catch{}await delay(500);}
 client=new Client({name:'uva-docker-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp')));
}
async function start(){
 docker('run','-d','--name',name,'--read-only','--tmpfs','/tmp:size=64m','-p','127.0.0.1::8787','-v',legacy+':/data','-v',beta+':/uva-beta','-e','ESTAMPES_REQUIRE_KEY=0','-e','ESTAMPES_ALLOW_OPEN=1','-e','ESTAMPES_UVA_DIR=/uva-beta','-e','ESTAMPES_UVA_PROFILE=linux-process-crash-test','-e','ESTAMPES_UVA_MIRROR_IDLE_SEC=0',tag);
 port=docker('port',name,'8787/tcp').split(':').at(-1);await connect();
}
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return r.structuredContent;};
try{
 await start();check(docker('exec',name,'id','-u')==='1000','unprivileged uid 1000');check(docker('exec',name,'node','--version').startsWith('v22.'),'Node 22 runtime');
 const image=await sharp({create:{width:160,height:100,channels:3,background:'#e3cbb9'}}).png().toBuffer(),data=image.toString('base64');
 const uploaded=await call('upload_visual_image',{total:data.length,offset:0,data});
 await call('present_visual',{imageId:uploaded.imageId,verify:false,annotations:[{id:'smoke',type:'point',x:.5,y:.5,label:'restart'}]});
 const end=Date.now()+60000;
 while(!((await call('uva_store',{action:'status'})).diagnostics.mirror.canvasStore?.committed>0)){if(Date.now()>end)throw Error('canvas never committed');await delay(300);}
 const [doc]=(await call('uva_store',{action:'list'})).workspaces;check(Boolean(doc),'canvas committed to the UVA store');
 const written=await call('uva_store',{action:'open',documentId:doc.id});
 const saved=await call('uva_store',{action:'export',documentId:doc.id});
 const expected=Buffer.from(await (await fetch(saved.url)).arrayBuffer());check(expected.length>0,'saved logical export with original image');
 await client.close();docker('restart',name);port=docker('port',name,'8787/tcp').split(':').at(-1);await connect();
 const reopened=await call('uva_store',{action:'open',documentId:doc.id});check(JSON.stringify(reopened.document)===JSON.stringify(written.document),'reopen after real container restart');
 const state=await call('get_visual_state',{imageId:uploaded.imageId});check(state.marks.some(m=>m.id==='smoke'),'acknowledged mark restored after restart');
 const tools=await client.listTools();check(!tools.tools.some(t=>t.name==='experimental_workspace'),'no Beta editor');
 const url='http://127.0.0.1:'+port+'/export/uva/'+saved.exportId+'.zip';const after=Buffer.from(await (await fetch(url)).arrayBuffer());check(after.equals(expected),'saved export accessible after restart');
 evidence.production='NOT QUALIFIED';evidence.host='Docker in managed Linux environment; not native host/power-loss acceptance';
 if(process.env.ESTAMPES_UVA_SMOKE_REPORT)await writeFile(process.env.ESTAMPES_UVA_SMOKE_REPORT,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
}catch(error){try{console.error(docker('logs',name));}catch{}throw error;}finally{await client?.close().catch(()=>{});try{docker('rm','-f',name);}catch{}for(const v of [legacy,beta])try{docker('volume','rm',v);}catch{}}
