import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,unlink,readdir} from "node:fs/promises";
import {join} from "node:path";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {PageStore} from "../../../../../src/persistence/pages.js";
import {lifecycleFixture,document,command,actor,epoch,titleEdit} from "../../../../../tests/fixtures/uva-lifecycle.mjs";

for (const damage of ["missing","corrupt"]) test("native selected proof survives three commits then rejects " + damage + " on-disk evidence", async t => {
  const f = await lifecycleFixture(t,{profile:"linux-local-durable"});
  const files = new ManagedFiles(f.root);
  let d = {...document(),persistence:"durable"};
  const original = command([d]);
  const point = "current.after-dir-fsync";
  await f.store.injectFault({point,mode:"pause"});
  let timer, listener;
  const hit = new Promise((resolve,reject) => {
    timer = setTimeout(() => reject(Error("CURRENT barrier not reached")),20000);
    listener = event => { if(event.name===point)resolve(); };
    f.store.events.on("stage",listener);
  });
  const pending = epoch(f.store).then(value=>f.store.commit(original,actor(),value)).catch(error=>error);
  try { await hit; }
  finally {
    clearTimeout(timer);
    f.store.events.off("stage",listener);
    f.store.kill("SIGKILL");
    await f.store.waitForExit();
  }
  assert.equal((await pending).code,"RECOVERY_REQUIRED");
  const initial = await loadCommitted(files);
  const originalAck = [...initial.indices.ledger.values()][0].ack;
  const [claimName,...rest] = await readdir(join(f.root,"visual-temporaries/claims"));
  assert.deepEqual(rest,[]);
  const claim = await files.json("visual-temporaries/claims/"+claimName);
  for(let n=2;n<=4;n++){
    await f.reopen();
    assert.equal(f.store.status.state,"ready");
    assert.deepEqual((await f.store.commit(original,actor(n),await epoch(f.store))).ack,originalAck);
    d = {...titleEdit(d),title:"Supersession "+n};
    assert.equal((await f.store.commit(command([d],n,n-1),actor(n),await epoch(f.store))).ack.durability,"durable");
  }
  await f.reopen();
  assert.equal(f.store.status.state,"ready");
  const selected = await loadCommitted(files);
  assert.deepEqual(selected.documents,[d]);
  assert.equal(selected.indices.ledger.size,4);
  const key = "temporary:"+claim.claimId;
  assert.deepEqual(selected.indices.retention.get(key).publication.envelope,initial.envelope);
  const pages = new PageStore(files);
  await pages.read(selected.root.roots.retention,"retention");
  let evidencePath, raw;
  for (const path of pages.track) {
    const text = await readFile(files.path(path),"utf8");
    if (text.includes(key) && text.includes("estampes.selected-current-proof/1")) {
      evidencePath=path;
      raw=text;
      break;
    }
  }
  assert.ok(evidencePath);
  await f.store.close();
  if(damage==="missing")await unlink(files.path(evidencePath));
  else await writeFile(files.path(evidencePath),raw.replace("estampes.selected-current-proof/1","estampes.selected-current-proof/0"));
  await f.reopen();
  assert.equal(f.store.status.state,"read-only-recovery");
  assert.deepEqual(await files.json("visual-registry/CURRENT.json"),selected.envelope);
  await assert.rejects(f.store.commit(original,actor(5),1),e=>e.code==="RECOVERY_REQUIRED");
  t.diagnostic(JSON.stringify({damage,evidencePath,current:selected.envelope,ledger:selected.indices.ledger.size,problem:f.store.status.problem}));
});
