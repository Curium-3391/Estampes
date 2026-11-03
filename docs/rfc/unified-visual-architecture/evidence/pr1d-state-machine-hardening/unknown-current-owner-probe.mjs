import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {lifecycleFixture} from '/workspace/Estampes/tests/fixtures/uva-lifecycle.mjs';
import {ManagedFiles} from '/workspace/Estampes/src/persistence/filesystem.js';
import {registerTemporary} from '/workspace/Estampes/src/persistence/temporary-attribution.js';
test('matching CURRENT bytes cannot confer selected transaction ownership on an unknown claim',async t=>{
 const f=await lifecycleFixture(t),files=new ManagedFiles(f.root);await f.store.close();
 const current='visual-registry/CURRENT.json',before=await readFile(files.path(current));
 await registerTemporary(files,current,before,'current',{kind:'transaction',id:randomUUID()});
 await f.reopen();assert.equal(f.store.status.state,'read-only-recovery');assert.deepEqual(await readFile(files.path(current)),before);
});
