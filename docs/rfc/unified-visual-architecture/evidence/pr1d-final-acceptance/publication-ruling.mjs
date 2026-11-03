import test from "node:test";
import assert from "node:assert/strict";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {lifecycleFixture,document,command,actor,epoch} from "../../../../../tests/fixtures/uva-lifecycle.mjs";

test("native post-publication EIO fences without rolling back selected CURRENT or inventing an ACK", async t => {
  const f = await lifecycleFixture(t,{profile:"linux-local-durable"});
  const files = new ManagedFiles(f.root);
  const doc = {...document(),persistence:"durable"};
  const request = command([doc]);
  const before = await loadCommitted(files);
  await f.store.injectFault({point:"before-ack",mode:"throw",code:"EIO"});
  const failed = await f.store.commit(request,actor(),await epoch(f.store))
    .then(ack => ({ack}),error => ({code:error.code,message:error.message,details:error.details}));
  assert.equal(failed.code,"RECOVERY_REQUIRED");
  assert.equal(failed.details.cause,"EIO");
  assert.equal(failed.ack,undefined);
  assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
  const selected = await loadCommitted(files);
  assert.equal(selected.envelope.generation,before.envelope.generation+1);
  assert.equal(selected.root.parentCommitHash,before.envelope.rootHash);
  assert.equal(selected.indices.ledger.size,before.indices.ledger.size+1);
  assert.deepEqual(selected.documents,[doc]);
  const recorded = [...selected.indices.ledger.values()][0].ack;
  assert.equal(recorded.commitId,selected.envelope.commitId);
  assert.equal(recorded.durability,"durable");
  await f.reopen();
  assert.equal(f.store.status.state,"ready");
  const replay = await f.store.commit(request,actor(2),await epoch(f.store));
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.ack,recorded);
  assert.equal((await f.store.diagnostics()).contentCommits,1);
  const recovered = await loadCommitted(files);
  assert.equal(recovered.root.parentCommitHash,selected.envelope.rootHash);
  t.diagnostic(JSON.stringify({before:before.envelope,selected:selected.envelope,recovered:recovered.envelope,
    ledger:[before.indices.ledger.size,selected.indices.ledger.size,recovered.indices.ledger.size],failed,replay}));
});
