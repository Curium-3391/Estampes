import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture, actor, command, richDocument, epoch } from "./fixtures/uva-persistence.mjs";
import { readCommittedSnapshot } from "../src/persistence/coordinator.js";
import { canonicalJson, hashJson } from "../src/documents/validation.js";

const stages=["before-intent","intent.before-file-fsync","intent.before-dir-fsync","after-intent-durable","staged.before-file-fsync","staged.after-rename","staged.after-dir-fsync",
  "after-staged-writes","root.before-file-fsync","after-prepared","current.before-rename","current.after-rename","current.before-dir-fsync","after-publication-durable","before-ack"];
async function waitStage(store,point){
  let timer,listener;
  const reached=new Promise((resolve,reject)=>{listener=message=>{if(message.name===point){clearTimeout(timer);store.events.off("stage",listener);resolve(message);}};
    store.events.on("stage",listener);timer=setTimeout(()=>{store.events.off("stage",listener);reject(new Error("Stage not reached: "+point));},15000);});
  return {reached,cancel(){clearTimeout(timer);store.events.off("stage",listener);}};
}
for(const point of stages)test("SIGKILL / "+point+" preserves one whole root and at most one retry effect",async t=>{
  const f=await fixture(t),d=richDocument(),cmd=command([d]),e=await epoch(f.store),barrier=await waitStage(f.store,point);
  t.after(()=>barrier.cancel());await f.store.injectFault({point,mode:"pause"});
  const pending=f.store.commit(cmd,actor(),e).catch(error=>error);await barrier.reached;
  const visible=await readCommittedSnapshot(f.root),published=["current.after-rename","current.before-dir-fsync","after-publication-durable","before-ack"].includes(point);
  assert.deepEqual(visible.documents,published?[d]:[]);
  f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  const retried=await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal(retried.replayed,published);
  assert.deepEqual((await f.store.snapshot()).documents,[d]);assert.equal((await f.store.diagnostics()).contentCommits,1);
  const replay=await f.store.commit(cmd,actor(3),e);assert.deepEqual(replay.ack,retried.ack);assert.equal(replay.replayed,true);
});
const syncBoundaries=["intent.before-file-fsync","intent.before-dir-fsync","mkdir.before-dir-fsync","staged.before-file-fsync","staged.before-dir-fsync",
  "root.before-file-fsync","root.before-dir-fsync","prepared.before-file-fsync","prepared.before-dir-fsync","current.before-file-fsync","current.before-dir-fsync","outcome.before-file-fsync","outcome.before-dir-fsync"];
for(const point of syncBoundaries)test("fsync EIO / "+point+" never returns an ACK and fences further writes",async t=>{
  const f=await fixture(t),d=richDocument(),cmd=command([d]),e=await epoch(f.store);await f.store.injectFault({point,mode:"throw",code:"EIO"});
  await assert.rejects(f.store.commit(cmd,actor(),e),error=>error.code==="RECOVERY_REQUIRED");
  assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
  await assert.rejects(f.store.commit(cmd,actor(2),e),error=>error.code==="RECOVERY_REQUIRED");
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  await f.store.commit(cmd,actor(3),await epoch(f.store));assert.equal((await f.store.diagnostics()).contentCommits,1);
});
for(const [point,code]of [["current.before-dir-fsync","ENOSPC"],["staged.before-write","ENOSPC"],["root.before-write","ENOSPC"],["prepared.before-write","ENOSPC"],["current.before-write","ENOSPC"],["staged.before-rename","EXDEV"],["current.before-rename","EXDEV"]]){
  test(code+" / "+point+" retains committed data and recovers without a second effect",async t=>{
    const f=await fixture(t),cmd=command([richDocument()]),e=await epoch(f.store);await f.store.injectFault({point,mode:"throw",code});
    await assert.rejects(f.store.commit(cmd,actor(),e),error=>["STORAGE_UNAVAILABLE","RECOVERY_REQUIRED"].includes(error.code));
    assert.deepEqual((await readCommittedSnapshot(f.root)).documents,point==="current.before-dir-fsync"?[richDocument()]:[]);
    await f.reopen();assert.equal(f.store.status.state,"ready");await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal((await f.store.diagnostics()).contentCommits,1);
  });
}
test("ACKed effects and exact results survive SIGKILL, while unreferenced higher filenames never select authority",async t=>{
  const f=await fixture(t),d=richDocument(),cmd=command([d]),result=await f.store.commit(cmd,actor(),await epoch(f.store));
  await writeFile(join(f.root,"visual-registry","999999999999.json"),"{}");
  await f.reopen();assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.snapshot()).documents,[d]);
  assert.deepEqual((await f.store.commit(cmd,actor(2),await epoch(f.store))).ack,result.ack);
});
for(const target of ["CURRENT","root","registry-page","generation","intent","outcome"]){
  test("corrupt "+target+" enters read-only recovery without guessing an older root",async t=>{
    const f=await fixture(t),cmd=command([richDocument()]),ack=await f.store.commit(cmd,actor(),await epoch(f.store)),snap=await f.store.snapshot();await f.store.close();
    const head=join(f.root,"visual-registry/CURRENT.json"),rootPath=join(f.root,"visual-registry/roots",snap.envelope.rootHash+".json");let path;
    if(target==="CURRENT")path=head;
    if(target==="root")path=rootPath;
    if(target==="registry-page")path=join(f.root,"visual-registry/pages",snap.root.roots.registry+".json");
    if(target==="generation"){const ref=ack.ack.revisionVector[0];path=join(f.root,"visual-documents",ref.entityId.slice(4),"generations",ref.revision+"-"+ref.contentHash+".json");}
    if(target==="intent"||target==="outcome")path=join(f.root,"visual-transactions",ack.ack.commitId.slice(3),target+".json");
    await writeFile(path,"{}");await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
    await assert.rejects(f.store.commit(cmd,actor(2),1),e=>e.code==="RECOVERY_REQUIRED");
    assert.equal((await readFile(path,"utf8")),"{}");
  });
}
test("mixed registry/locator roots are rejected even with a syntactically valid CURRENT checksum",async t=>{
  const f=await fixture(t),old=await f.store.snapshot();await f.store.commit(command([richDocument()]),actor(),await epoch(f.store));const snap=await f.store.snapshot();await f.store.close();
  const root=structuredClone(snap.root);root.roots.locator=old.root.roots.locator;
  const rootHash=hashJson(root),head={generation:root.generation,rootHash,commitId:root.commitId};
  await writeFile(join(f.root,"visual-registry/roots",rootHash+".json"),canonicalJson(root));
  await writeFile(join(f.root,"visual-registry/CURRENT.json"),canonicalJson({...head,checksum:hashJson(head)}));
  await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.equal(f.store.status.problem.code,"RECOVERY_REQUIRED");
});
test("an aborted prepared generation is never adopted, even when its staged file is corrupt",async t=>{
  const f=await fixture(t),cmd=command([richDocument()]),point="after-prepared",barrier=await waitStage(f.store,point);t.after(()=>barrier.cancel());
  await f.store.injectFault({point,mode:"pause"});const pending=f.store.commit(cmd,actor(),await epoch(f.store)).catch(e=>e);await barrier.reached;
  const dir=join(f.root,"visual-documents",cmd.changes[0].document.id.slice(4),"generations"),[name]=await readdir(dir);
  await writeFile(join(dir,name),"{}");f.store.kill("SIGKILL");await f.store.waitForExit();await pending;
  await f.reopen();assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.snapshot()).documents,[]);assert.equal((await f.store.diagnostics()).contentCommits,0);
  await assert.rejects(f.store.commit(cmd,actor(2),await epoch(f.store)),e=>e.code==="INTEGRITY_ERROR"||e.code==="RECOVERY_REQUIRED");
  assert.equal((await readFile(join(dir,name),"utf8")),"{}");
});
test("interrupted recovery and recovery ENOSPC preserve the selected root and never issue an ACK",async t=>{
  const f=await fixture(t),cmd=command([richDocument()]);await f.store.commit(cmd,actor(),await epoch(f.store));const source=await f.store.snapshot();
  await f.reopen({fault:{point:"recovery.before-outcome",mode:"throw",code:"ENOSPC"}});assert.equal(f.store.status.state,"read-only-recovery");
  assert.equal((await readCommittedSnapshot(f.root)).envelope.rootHash,source.envelope.rootHash);
  await f.reopen({fault:{point:"recovery.before-file-fsync",mode:"throw",code:"EIO"}});assert.equal(f.store.status.state,"read-only-recovery");
  await f.reopen();assert.equal(f.store.status.state,"ready");assert.equal((await f.store.diagnostics()).contentCommits,1);assert.deepEqual((await f.store.snapshot()).documents,source.documents);
});
test("recovery refuses a rolled-back CURRENT when a durable outcome proves a later committed transaction",async t=>{
  const f=await fixture(t),head=await readFile(join(f.root,"visual-registry/CURRENT.json"));await f.store.commit(command([richDocument()]),actor(),await epoch(f.store));await f.store.close();
  await writeFile(join(f.root,"visual-registry/CURRENT.json"),head);await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});

test("reused orphan generation bytes must pass file/directory barriers again before publication",async t=>{
  const f=await fixture(t),cmd=command([richDocument()]),point="staged.after-rename",barrier=await waitStage(f.store,point);t.after(()=>barrier.cancel());
  await f.store.injectFault({point,mode:"pause"});const first=f.store.commit(cmd,actor(),await epoch(f.store)).catch(e=>e);await barrier.reached;
  f.store.kill("SIGKILL");await f.store.waitForExit();await first;await f.reopen();
  await f.store.injectFault({point:"staged.before-file-fsync",mode:"throw",code:"EIO"});
  await assert.rejects(f.store.commit(cmd,actor(2),await epoch(f.store)),e=>e.code==="RECOVERY_REQUIRED");
  assert.deepEqual((await readCommittedSnapshot(f.root)).documents,[]);
  await f.reopen();await f.store.commit(cmd,actor(3),await epoch(f.store));assert.equal((await f.store.diagnostics()).contentCommits,1);
});
test("committed metadata tamper detected during a live write fences the writer before any ACK",async t=>{
  const f=await fixture(t),s=await f.store.snapshot();await writeFile(join(f.root,"visual-registry/pages",s.root.roots.registry+".json"),"{}");
  await assert.rejects(f.store.commit(command([richDocument()]),actor(),await epoch(f.store)),e=>e.code==="RECOVERY_REQUIRED");
  assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
});

test("SIGKILL during recovery outcome repair is idempotent on the next restart",async t=>{
  const f=await fixture(t),cmd=command([richDocument()]);await f.store.commit(cmd,actor(),await epoch(f.store));const before=await f.store.snapshot();await f.store.close();
  const {openIsolatedStore}=await import("../src/persistence/lease.js");
  await assert.rejects(openIsolatedStore(f.root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",fault:{point:"recovery.before-outcome",mode:"pause"}},event=>process.kill(event.pid,"SIGKILL")),e=>e.code==="RECOVERY_REQUIRED");
  await f.reopen();assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.snapshot()).documents,before.documents);assert.equal((await f.store.diagnostics()).contentCommits,1);
});
