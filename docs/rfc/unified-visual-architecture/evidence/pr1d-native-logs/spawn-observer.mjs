// Diagnostics only: preserve the real spawn and record its exact OS error.
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {appendFileSync} from "node:fs";
const original=childProcess.spawn;
childProcess.spawn=function(file,...args){const child=original.call(this,file,...args);if(file==="/usr/bin/flock"&&Number(process.env.PR1D_SPAWN_DELAY_MS)>0)child.once("spawn",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.PR1D_SPAWN_DELAY_MS)));child.once("error",e=>{if(process.env.PR1D_SPAWN_DIAGNOSTICS)appendFileSync(process.env.PR1D_SPAWN_DIAGNOSTICS,JSON.stringify({time:new Date().toISOString(),pid:process.pid,uid:process.getuid(),file,code:e.code,errno:e.errno,syscall:e.syscall,message:e.message})+"\n");});return child;};
syncBuiltinESMExports();
