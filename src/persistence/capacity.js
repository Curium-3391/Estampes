import { statfs } from "node:fs/promises";
import { fail } from "./errors.js";
export const DEFAULT_QUOTA=10*1024**3, WORK_BYTES=32*1024**2;
export class CapacityManager {
 constructor(files,quota){this.files=files;this.quota=quota;this.pending=new Map();}
 async reserve(id,bytes,{maintenance=false,reservedJobs=0}={}){
  const usage=await this.files.usage(),fs=await statfs(this.files.root,{bigint:true}),free=Number(fs.bavail*fs.bsize);
  const reserve=Math.max(64*1024**2,Math.ceil(this.quota*0.01)),pending=[...this.pending.values()].reduce((a,b)=>a+b,0);
  const workspace=maintenance?0:WORK_BYTES,need=bytes+pending+reservedJobs+workspace+reserve;
  if(usage.allocatedBytes+need>this.quota||free<need)fail("STORAGE_UNAVAILABLE","Capacity admission refused; draft and protected history remain unchanged",{...usage,bytes,pending,reservedJobs,workspace,reserve,quota:this.quota,free});
  this.pending.set(id,bytes);return {id,bytes,usage,free,reserve};
 }
 release(id){this.pending.delete(id);}
}
