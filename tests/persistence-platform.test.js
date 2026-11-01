import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, lstat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture, options, actor, command, document, epoch } from "./fixtures/uva-persistence.mjs";
import { openIsolatedStore } from "../src/persistence/lease.js";
import { CommitCoordinator } from "../src/persistence/coordinator.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";

const temporary=async t=>{const dir=await mkdtemp(join(tmpdir(),"estampes-pr1c-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
test("unsupported native durable profile fails before mutating the disposable directory",async t=>{
  const root=await temporary(t),fs=await statfs(root,{bigint:true}),supported=[0xef53,0x58465342].includes(Number(BigInt.asUintN(32,fs.type)));
  if(supported)return; // positive native profile is separately tested below; no simulated promotion.
  await assert.rejects(openIsolatedStore(root,{...options,profile:"linux-local-durable"}),e=>e.code==="UNSUPPORTED_STORAGE");assert.deepEqual(await readdir(root),[]);
});
test("unknown profiles, missing isolated purpose and test-to-durable promotion are refused",async t=>{
  const root=await temporary(t);
  await assert.rejects(openIsolatedStore(root,{profile:"macos-apfs",purpose:options.purpose}),e=>e.code==="UNSUPPORTED_STORAGE");
  await assert.rejects(openIsolatedStore(root,{profile:"linux-process-crash-test"}),e=>e.code==="UNSUPPORTED_STORAGE");
  assert.deepEqual(await readdir(root),[]);
});
test("OS lifetime lease rejects a second writer before mutation and SIGKILL releases it",async t=>{
  const f=await fixture(t),head=await readFile(join(f.root,"visual-registry/CURRENT.json")),st=await lstat(join(f.root,"WRITER.lock"));
  await assert.rejects(openIsolatedStore(f.root,options),e=>e.code==="STORAGE_UNAVAILABLE"&&e.details.exitCode===73);
  assert.deepEqual(await readFile(join(f.root,"visual-registry/CURRENT.json")),head);assert.equal((await lstat(join(f.root,"WRITER.lock"))).ino,st.ino);
  await f.reopen();assert.equal(f.store.status.state,"ready");assert.ok((await f.store.snapshot()).authority.epoch>1);
});
test("direct coordinator construction without its own inherited OS lease cannot write",async t=>{
  const f=await fixture(t),raw=new CommitCoordinator(new ManagedFiles(f.root),f.store.status.platform);
  assert.equal(raw.publish,undefined);
  await assert.rejects(raw.open({}),e=>e.code==="UNSUPPORTED_STORAGE");
});
test("client/supervisor termination cannot leave an orphan writer holding the lease",async t=>{
  const root=await temporary(t),script=`import {openIsolatedStore} from ${JSON.stringify(new URL('../src/persistence/lease.js',import.meta.url).href)};const store=await openIsolatedStore(process.argv[1],${JSON.stringify(options)});console.log(store.pid);setInterval(()=>{},1000);`;
  const parent=spawn(process.execPath,["--input-type=module","-e",script,root],{stdio:["ignore","pipe","pipe"]});
  let text="";const ready=new Promise((resolve,reject)=>{parent.stdout.on("data",b=>{text+=b;if(text.includes("\n"))resolve(Number(text.trim()));});parent.once("error",reject);});
  const writerPid=await ready;assert.ok(writerPid>0);parent.kill("SIGKILL");await once(parent,"exit");
  // The IPC-disconnect handler exits immediately. Retry is bounded and never
  // steals or deletes a lease; the kernel must actually release it.
  let next,last;
  for(let i=0;i<40;i++){try{next=await openIsolatedStore(root,options);break;}catch(e){last=e;await new Promise(r=>setTimeout(r,10));}}
  assert.ok(next,last?.message);await next.close();
});
const nativeType=Number(BigInt.asUintN(32,(await statfs(tmpdir(),{bigint:true})).type));
test("native ext4/XFS durable ACK survives process restart (still not a power-loss test)",{
  skip:![0xef53,0x58465342].includes(nativeType)?"No approved native ext4/XFS temporary mount; durable writer refused rather than simulating support":false,
},async t=>{
  const f=await fixture(t,{profile:"linux-local-durable"}),cmd=command([{...document(),persistence:"durable"}]);
  const result=await f.store.commit(cmd,actor(),await epoch(f.store));assert.equal(result.ack.durability,"durable");
  await f.reopen({profile:"linux-local-durable"});assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.commit(cmd,actor(2),await epoch(f.store))).ack,result.ack);
});
