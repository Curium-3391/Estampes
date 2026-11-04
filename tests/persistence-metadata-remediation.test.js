import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, symlink, link, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedFiles } from "../src/persistence/filesystem.js";

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"estampes-metadata-remediation-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,"nested"),{mode:0o700});
  await writeFile(join(root,"nested/record"),"original");
  return new ManagedFiles(root).observation();
}

for(const mutation of ["parent symlink","parent replacement","file symlink","hardlink","permissions"]){
  test("coherent pre-open metadata rejects intervening "+mutation,async t=>{
    const io=await fixture(t),info=io.info.bind(io);let injected=false;
    io.info=async name=>{
      const value=await info(name);
      if(!injected){
        injected=true;
        if(mutation.startsWith("parent")){
          await rename(io.path("nested"),io.path("previous"));
          if(mutation==="parent symlink")await symlink(io.path("previous"),io.path("nested"));
          else {await mkdir(io.path("nested"),{mode:0o700});await writeFile(io.path(name),"replaced");}
        }else if(mutation==="file symlink"){
          await rename(io.path(name),io.path("previous"));await symlink(io.path("previous"),io.path(name));
        }else if(mutation==="hardlink")await link(io.path(name),io.path("alias"));
        else await chmod(io.path(name),0o666);
      }
      return value;
    };
    await assert.rejects(io.bytes("nested/record"),e=>e.code==="INTEGRITY_ERROR"||e.code==="ELOOP");
    assert.equal(injected,true);assert.equal(io.observations.size,0);
  });
}

test("metadata reuse preserves byte limits and rechecks ancestry on every read",async t=>{
  const io=await fixture(t);
  await assert.rejects(io.bytes("nested/record",7),e=>e.code==="INTEGRITY_ERROR");
  assert.equal((await io.bytes("nested/record",8)).toString(),"original");
  await chmod(io.path("nested"),0o777);
  await assert.rejects(io.bytes("nested/record"),e=>e.code==="INTEGRITY_ERROR");
});
