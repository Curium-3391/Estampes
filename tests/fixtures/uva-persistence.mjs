import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIsolatedStore } from "../../src/persistence/lease.js";
import { id, document, provenance, HASH } from "./uva-pr1a.mjs";
export { id, document };
export const options={profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing"};
export const actor=(n=1)=>({principal:{kind:"user",principalId:"owner:stable"},authenticatedOwnerId:"owner:stable",origin:"app-user",effectiveGrants:[],targetScope:[],grantRevision:1,executionId:id("exec",n)});
export async function fixture(t,extra={}){
  const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-"));let current=await openIsolatedStore(root,{...options,...extra});
  t.after(async()=>{current.kill("SIGKILL");await current.waitForExit();await rm(root,{recursive:true,force:true});});
  return {root,get store(){return current;},async reopen(extraOptions={}){current.kill("SIGKILL");await current.waitForExit();current=await openIsolatedStore(root,{...options,...extraOptions});return current;}};
}
export const command=(docs,request=1,expected=null)=>({requestId:id("req",request),changes:docs.map(d=>({document:d,expectedRevision:expected}))});
export const epoch=async store=>(await store.snapshot()).authority.epoch;
export const titleEdit=doc=>({...structuredClone(doc),title:"changed",revision:doc.revision+1});
export const richDocument=()=>{
  const d=document(),s=d.scenes[0];
  s.layers=[{id:"L1",author:"user",name:"Ink",opacity:0,visible:true,locked:true,content:[{kind:"annotation",id:"ai"}]}];
  s.annotations=[{id:"ai",revision:1,type:"point",layerId:"L1",geometry:{x:2,y:3},anchor:{space:"document"},style:{color:"red"},provenance:provenance("assistant"),intentEventIds:[],finding:{note:"Original",review:"confirmed",verification:{historicalState:"user-confirmed",currentState:"user-confirmed",contextHash:HASH}}}];
  return d;
};
