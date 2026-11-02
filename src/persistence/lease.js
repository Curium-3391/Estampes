// All writer execution takes place inside flock --no-fork's exec'ed process.
// The parent is only an RPC client; it never writes generations or CURRENT.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { inspectPlatform } from "./platform.js";
import { assertJson } from "../documents/validation.js";
import { PersistenceError } from "./errors.js";

export async function openIsolatedStore(directory,options={},observeStage=()=>{}) {
  assertJson(options);const profile=options.profile??"linux-local-durable",purpose=options.purpose;
  await inspectPlatform(directory,profile,purpose); // must reject unsupported profiles before lock file creation.
  const worker=fileURLToPath(new URL("./worker.js",import.meta.url));
  const child=spawn("/usr/bin/flock",["-n","-E","73","-F",join(directory,"WRITER.lock"),process.execPath,worker,directory],{stdio:["ignore","ignore","pipe","ipc"]});
  const events=new EventEmitter(),pending=new Map();let sequence=0,stderr="",closed=false,spawned=false,startupIpcError=null;
  child.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-2048);});
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new PersistenceError("RECOVERY_REQUIRED","Writer startup timed out"));},30000);
    pending.set(0,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  });
  child.on("message",m=>{
    if(m.event){observeStage({...m,pid:child.pid});events.emit("stage",m);return;}
    const call=pending.get(m.id);if(!call)return;pending.delete(m.id);
    if(m.error)call.reject(new PersistenceError(m.error.code,m.error.message,m.error.details));else call.resolve(m.value);
  });
  const terminate=error=>{if(closed)return;closed=true;for(const p of pending.values())p.reject(error);pending.clear();events.emit("closed");};
  const exited=(code,signal)=>terminate(new PersistenceError(code===73?"STORAGE_UNAVAILABLE":"RECOVERY_REQUIRED",code===73?"Second writer rejected by exclusive OS lease":"Writer process exited; inspect committed outcome",{exitCode:code,signal,diagnostic:stderr,...(startupIpcError?{ipcCause:startupIpcError.code}: {})}));
  child.once("error",e=>terminate(new PersistenceError(spawned?"RECOVERY_REQUIRED":"UNSUPPORTED_STORAGE",spawned?"Writer startup transport failed":"Cannot start OS lease backend",{cause:e.code})));
  child.once("exit",exited);
  child.once("spawn",()=>{spawned=true;child.send({id:0,method:"open",args:{...options,profile,purpose}},error=>{
    if(!error)return;startupIpcError=error;
    // A non-blocking flock may exit 73 before the parent's spawn callback can
    // send startup IPC. The exit status is the authority for contention; the
    // transport error must never be mistaken for an unsupported filesystem.
    if(child.exitCode!==null)exited(child.exitCode,child.signalCode);
  });});
  let status;try{status=await ready;}catch(e){if(!closed)child.kill("SIGKILL");throw e;}
  const call=(method,args={})=>{
    if(closed)return Promise.reject(new PersistenceError("RECOVERY_REQUIRED","Writer is closed"));
    assertJson(args);return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.send({id,method,args},error=>{if(error){pending.delete(id);reject(new PersistenceError("RECOVERY_REQUIRED","Writer IPC failed"));}});});
  };
  return {status,pid:child.pid,events,
    snapshot:()=>call("snapshot"),diagnostics:()=>call("diagnostics"),
    commit:(command,actor,expectedEpoch)=>call("commit",{command,actor,expectedEpoch}),
    injectFault:fault=>call("fault",{fault}),
    maintenance:(action,args={})=>call("maintenance",{action,arguments:args}),
    kill:signal=>child.kill(signal??"SIGKILL"),
    waitForExit:()=>closed?Promise.resolve():new Promise(resolve=>events.once("closed",resolve)),
    close:async()=>{if(!closed){try{await call("close");}finally{await (closed?Promise.resolve():new Promise(resolve=>events.once("closed",resolve)));}}},
  };
}
