// Read-only byte oracle from the exact baseline; no persistent authority/cache.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson, jsonSchema, parse } from '../../src/documents/validation.js';
import { storeDocument } from '../../src/persistence/records.js';
import { document } from '../../tests/fixtures/uva-persistence.mjs';
const baseline=process.argv[2];
const old=await import(pathToFileURL(baseline+'/src/documents/validation.js'));
const oldRecords=await import(pathToFileURL(baseline+'/src/persistence/records.js'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const results=[];
for(const mib of [1,8,16,32]){
 const d=document();d.persistence='memory';d.extensions={'benchmark:payload':'x'.repeat(mib*1024**2)};
 const before=Buffer.from(old.canonicalJson(oldRecords.storeDocument(d))),after=Buffer.from(canonicalJson(storeDocument(d)));
 assert.ok(after.equals(before));assert.equal(hash(after),hash(before));
 const copied=parse(jsonSchema(),d.extensions),oldCopy=old.parse(old.jsonSchema(),d.extensions);
 assert.equal(canonicalJson(copied),old.canonicalJson(oldCopy));
 results.push({mib,bytes:after.length,sha256:hash(after),byteParity:true});
}
for(let n=0;n<512;n++){
 const units=Array.from({length:12},(_,i)=>(n*293+i*7919)&65535);
 const input={z:[-0,1e30,Number.MIN_VALUE,String.fromCharCode(...units)],a:{'😀':'\u0000\n\ud800\udfff'}};
 assert.equal(canonicalJson(input),old.canonicalJson(input));
 assert.equal(canonicalJson(parse(jsonSchema(),input)),old.canonicalJson(old.parse(old.jsonSchema(),input)));
}
console.log(JSON.stringify({oracle:baseline,canonicalByteParity:'PASS',storedContentSha256Parity:'PASS',unicodeCases:512,documents:results}));
