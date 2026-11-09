// Private process entry point. No HTTP/MCP listener; IPC is inherited from the
// owning server-side client, and the OS lease survives exec into this process.
import { inspectPlatform, assertOwnedWriterLease } from "./platform.js";
import { ManagedFiles } from "./filesystem.js";
import { CommitCoordinator } from "./coordinator.js";
import { z } from "zod";
import { parse } from "../documents/validation.js";
const faultSchema=z.object({point:z.string().min(1).max(120),mode:z.enum(["throw","pause"]),code:z.enum(["EIO","ENOSPC","EXDEV","EACCES"]).optional(),nth:z.number().int().min(1).max(10000).optional()}).strict().nullable();
const root=process.argv[2];let coordinator;
process.once("disconnect",()=>process.exit(0)); // never leave an orphan writer when its client/supervisor dies.
const respond=(id,value,error)=>{if(process.connected)process.send({id,...(error?{error:{code:error.code??"BACKEND_UNAVAILABLE",message:String(error.message).slice(0,300),details:error.details??{}}}:{value})});};
process.on("message",async message=>{
  const {id,method,args}=message;
  try{
    if(method==="open"){
      if(coordinator)throw new Error("Writer already initialized");
      const platform=await inspectPlatform(root,args.profile,args.purpose);await assertOwnedWriterLease(root);
      const files=new ManagedFiles(root,(name,details)=>new Promise(resolve=>process.send({event:"stage",name,details},resolve)));
      if(args.fault)files.arm(parse(faultSchema,args.fault));
      coordinator=new CommitCoordinator(files,platform);await coordinator.open(args);respond(id,coordinator.diagnostics());return;
    }
    if(!coordinator)throw new Error("Writer is not initialized");
    if(method==="snapshot")respond(id,coordinator.snapshot());
    else if(method==="diagnostics")respond(id,coordinator.diagnostics());
    else if(method==="fault"){coordinator.files.arm(parse(faultSchema,args.fault));respond(id,{armed:true});}
    else if(method==="maintenance")respond(id,await coordinator.maintenance(args.action,args.arguments??{}));
    else if(method==="commit")respond(id,await coordinator.commit(args.command,args.actor,args.expectedEpoch));
    else if(method==="close"){coordinator.stopCompaction();await coordinator.queue;respond(id,{closed:true});process.disconnect();}
    else throw new Error("Unknown internal method");
  }catch(e){respond(id,null,e);}
});
