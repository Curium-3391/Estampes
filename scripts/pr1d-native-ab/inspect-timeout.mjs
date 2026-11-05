// Bounded read-only postmortem of an already stopped, archived timeout Store.
// Does not open a client/coordinator, recover, GC or retry the failed workload.
import assert from 'node:assert/strict';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join,dirname} from 'node:path';
const [source,root,rawLog]=process.argv.slice(2);
assert.equal(process.getuid(),1001);assert.equal(await realpath(root),root);
const st=await lstat(root);assert.equal(st.uid,1001);assert.equal(st.mode&0o777,0o700);
assert.equal(dirname(dirname(root)),'/home/estampes');
const imp=p=>import(pathToFileURL(join(source,p)));
const {ManagedFiles}=await imp('src/persistence/filesystem.js');
const {PageStore}=await imp('src/persistence/pages.js');
const {readVersion}=await imp('src/persistence/archive.js');
const {canonicalJson,hashJson}=await imp('src/documents/validation.js');
const events=(await readFile(rawLog,'utf8')).split('\n').filter(l=>l.startsWith('{')).map(JSON.parse);
assert.ok(events.some(e=>e.event==='cold-client-error'));
const committed=events.filter(e=>e.event==='commit');assert.equal(committed.length,1);
const files=new ManagedFiles(root),envelope=await files.json('visual-registry/CURRENT.json');
const selectedRoot=await files.json('visual-registry/roots/'+envelope.rootHash+'.json');
assert.equal(hashJson(selectedRoot),envelope.rootHash);
const {checksum,...identity}=envelope;assert.equal(hashJson(identity),checksum);
for(const k of ['generation','commitId'])assert.equal(selectedRoot[k],envelope[k]);
const pages=new PageStore(files),ledger=await pages.read(selectedRoot.roots.ledger,'ledger'),locator=await pages.read(selectedRoot.roots.locator,'locator');
assert.equal(ledger.size,1);assert.deepEqual([...ledger.values()][0].ack,committed[0].ack);
const ref=committed[0].ack.revisionVector[0],record=await readVersion(files,ref,locator);
assert.equal(hashJson(record),ref.contentHash);
assert.equal(canonicalJson(envelope),canonicalJson(await files.json('visual-registry/CURRENT.json')));
console.log(JSON.stringify({event:'read-only-timeout-postmortem',originalRoot:root,selectedCurrent:envelope,ledger:ledger.size,versionsReadOnlyVerified:1,sha256:ref.contentHash,exactOriginalAck:true,representation:locator.get(hashJson(ref)).kind,clientDeadlineOutcome:'FAILURE PRESERVED — this inspection is not a client startup or retry',mutation:'NONE: only ManagedFiles/PageStore/readVersion reads; no coordinator/recovery/GC'}));
