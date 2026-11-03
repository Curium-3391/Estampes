import test from "node:test";
import assert from "node:assert/strict";
import {chmod,lstat,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ManagedFiles,physicalFingerprint} from "../../../../../src/persistence/filesystem.js";

test("native chmod-only control distinguishes metadata alias from content corruption",async t=>{
  const root=await mkdtemp(join(tmpdir(),"estampes-final-ctime-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const files=new ManagedFiles(root);
  const path=files.path("record.json");
  await writeFile(path,'{"a":1}');
  let aliases=0, changed=0, sample;
  for(let i=0;i<64;i++){
    await chmod(path,0o644);
    const io=files.observation();
    assert.deepEqual(await io.json("record.json"),{a:1});
    const before=io.observations.get("record.json");
    await chmod(path,0o400);
    const after=physicalFingerprint(await files.info("record.json"));
    assert.equal((await lstat(path)).mode&0o777,0o400);
    assert.deepEqual(await files.json("record.json"),{a:1});
    if(before===after){
      aliases++;
      const proof=await io.proofIdentity("record.json");
      assert.equal(proof.fingerprint,before);
      sample??={before,after,proof};
    }else{
      changed++;
      await assert.rejects(io.proofIdentity("record.json"),error=>error.code==="INTEGRITY_ERROR");
    }
  }
  t.diagnostic(JSON.stringify({attempts:64,aliases,changed,sample,bytesUnchanged:true}));
});
