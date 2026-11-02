import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIsolatedStore } from "../../src/persistence/lease.js";
export { actor,command,document,epoch,titleEdit,richDocument,id } from "./uva-persistence.mjs";
export const TIME=Date.UTC(2030,0,1),DAY=24*60*60*1000;
export async function lifecycleFixture(t,{legacy=false,...extra}={}){
 const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-pr1d-")),options={profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",testClockMs:TIME,...(!legacy?{lifecycle:{enabled:true,autoMaintenance:false}}:{}),...extra};let store=await openIsolatedStore(root,options);
 t.after(async()=>{store.kill("SIGKILL");await store.waitForExit();await rm(root,{recursive:true,force:true});});
 return {root,get store(){return store;},async reopen(change={}){store.kill("SIGKILL");await store.waitForExit();store=await openIsolatedStore(root,{...options,...change});return store;},async enable(){return this.reopen({lifecycle:{enabled:true,autoMaintenance:false}});}};
}
export async function drain(store,max=100){const results=[];for(let i=0;i<max;i++){const r=await store.maintenance("compact");results.push(r);if(r.state==="idle")return results;}throw new Error("Compaction did not drain within test bound");}
export async function destination(t,label="backup") {const p=await mkdtemp(join(tmpdir(),"estampes-pr1c-"+label+"-"));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
