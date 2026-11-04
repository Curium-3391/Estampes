// Two fresh processes, each five alternating baseline/candidate pairs.
// This isolates exactly the changed schema operation, not commit/startup speed.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const [baseline,candidate,first]=process.argv.slice(2),sources={baseline,candidate},modules={},sourceHashes={};
const hash=v=>createHash('sha256').update(v).digest('hex');
for(const [name,root] of Object.entries(sources)){
 modules[name]=await import(pathToFileURL(root+'/src/documents/validation.js'));
 sourceHashes[name]=hash(await readFile(root+'/src/documents/validation.js'));
}
const input=Object.freeze({'benchmark:payload':'x'.repeat(8*1024**2)}),schemas=Object.fromEntries(Object.entries(modules).map(([name,m])=>[name,m.jsonSchema()]));
const expected=hash(modules.baseline.canonicalJson(input));
for(const name of ['baseline','candidate'])modules[name].parse(schemas[name],input);
const rows=[];
for(let pair=0;pair<5;pair++){
 const order=(pair%2===0)===(first==='baseline')?['baseline','candidate']:['candidate','baseline'];
 for(const name of order){
  const m=modules[name],cpu=process.cpuUsage(),start=performance.now(),output=m.parse(schemas[name],input);
  const row={pair,name,wallMs:performance.now()-start,cpuUs:process.cpuUsage(cpu),memory:process.memoryUsage()};rows.push(row);
  assert.notEqual(output,input);assert.equal(hash(m.canonicalJson(output)),expected);
 }
}
console.log(JSON.stringify({sources,sourceHashes,node:process.version,operation:'jsonSchema parse only; same-process alternating pairs',payloadMiB:8,warmupEach:1,pairs:5,first,sha256:expected,rows,maxRSSKiB:process.resourceUsage().maxRSS}));
