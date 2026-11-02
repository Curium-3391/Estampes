// Explicit, root-scoped SIGKILL injection after a real production read.
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
if(process.argv[1]?.endsWith("/persistence/worker.js")&&process.argv[2]===process.env.PR1D_FAULT_ROOT){
 const original=ManagedFiles.prototype.json;
 ManagedFiles.prototype.json=async function(name,...rest){
  const value=await original.call(this,name,...rest),stack=new Error().stack;
  const classification=process.env.PR1D_FAULT_MODE==="classification"&&name.startsWith("visual-temporaries/claims/")&&stack.includes("classifyTemporaryClaims");
  const history=process.env.PR1D_FAULT_MODE==="history"&&name.includes("/generations/")&&stack.includes("readVersion");
  if(classification||history){process.stderr.write("INDEPENDENT_SIGKILL_"+process.env.PR1D_FAULT_MODE+"\n");process.kill(process.pid,"SIGKILL");await new Promise(()=>{});}
  return value;
 };
}
