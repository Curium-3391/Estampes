import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [b,c]=process.argv.slice(2),load=(root,p)=>import(pathToFileURL(root+'/'+p));
const old=await load(b,'src/documents/validation.js'),now=await load(c,'src/documents/validation.js');
const oldRecords=await load(b,'src/persistence/records.js'),newRecords=await load(c,'src/persistence/records.js');
const {document}=await load(b,'tests/fixtures/uva-persistence.mjs');
const hash=v=>createHash('sha256').update(v).digest('hex'),rows=[];
for(const mib of [1,8,16,32]){
 const d=document();d.persistence='durable';d.extensions={'benchmark:payload':'x'.repeat(mib*1024**2)};
 const a=Buffer.from(old.canonicalJson(oldRecords.storeDocument(d))),z=Buffer.from(now.canonicalJson(newRecords.storeDocument(d)));
 assert.ok(a.equals(z));assert.equal(hash(a),hash(z));
 assert.equal(old.canonicalJson(old.parse(old.jsonSchema(),d.extensions)),now.canonicalJson(now.parse(now.jsonSchema(),d.extensions)));
 rows.push({mib,bytes:a.length,sha256:hash(a),byteParity:true});
}
for(let n=0;n<512;n++){
 const input={z:[-0,1e30,Number.MIN_VALUE,String.fromCharCode(...Array.from({length:12},(_,i)=>(n*293+i*7919)&65535))],a:{'😀':'\u0000\n\ud800\udfff'}};
 assert.equal(old.canonicalJson(input),now.canonicalJson(input));
 assert.equal(old.canonicalJson(old.parse(old.jsonSchema(),input)),now.canonicalJson(now.parse(now.jsonSchema(),input)));
}
console.log(JSON.stringify({canonicalByteParity:true,storedRecordParity:true,unicodeCases:512,documents:rows}));
