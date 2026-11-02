// Root-scoped, opt-in partial-write injection using an actual FileHandle write.
import {open,readlink,unlink} from "node:fs/promises";
import {join} from "node:path";
if(process.argv[1]?.endsWith("/persistence/worker.js")&&process.argv[2]===process.env.PR1D_FAULT_ROOT){
 const path=join(process.env.PR1D_ACCEPT_ROOT,"filehandle-probe-"+process.pid),probe=await open(path,"wx",0o600),prototype=Object.getPrototypeOf(probe),original=prototype.writeFile;
 await probe.close();await unlink(path);
 prototype.writeFile=async function(data,...args){
  const path=await readlink("/proc/self/fd/"+this.fd);
  if(path.startsWith(process.env.PR1D_FAULT_ROOT+"/")&&path.includes("/generations/")&&path.includes(".tmp-")){
   const bytes=Buffer.from(data),length=Math.max(1,Math.floor(bytes.length/2));await this.write(bytes,0,length,0);
   process.stderr.write("INDEPENDENT_SIGKILL_PARTIAL_WRITE\n");process.kill(process.pid,"SIGKILL");await new Promise(()=>{});
  }
  return original.call(this,data,...args);
 };
}
