import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Test-only scheduling delay. The real /usr/bin/flock process and kernel lock
// are untouched; only delivery of the parent's spawn callback is delayed.
const original=childProcess.spawn;
childProcess.spawn=function(file,...args){
  const child=original.call(this,file,...args);
  if(file==="/usr/bin/flock")child.once("spawn",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20));
  return child;
};
syncBuiltinESMExports();
