// Documentation-only validator; does not register or call proposed tools.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateExample, api, permissions } from './proposed-contracts.mjs';
export const packageRoot=fileURLToPath(new URL('../',import.meta.url));
export function schemaInventory(){
 const files=[...readdirSync(packageRoot).filter(n=>/^RFC-\d{3}\.md$/.test(n)).sort().map(n=>join(packageRoot,n)),
 ...readdirSync(join(packageRoot,'adr')).filter(n=>/^ADR-\d{3}\.md$/.test(n)).sort().map(n=>join(packageRoot,'adr',n)),
 join(packageRoot,'CONTRACTS.md'),fileURLToPath(new URL('../../../../IMPLEMENTATION-ROADMAP.md',import.meta.url)),join(packageRoot,'ANNOTATION-POLICY.md'),join(packageRoot,'EMBED-CONTRACT.md')];
 const root=fileURLToPath(new URL('../../../../',import.meta.url));const fences=[];
 for(const file of files){const s=readFileSync(file,'utf8');for(const m of s.matchAll(/^```(json|ts|typescript)\n([\s\S]*?)^```/gm)){
  const marker=s.slice(0,m.index).trimEnd().match(/<!-- contract-example: ([\w-]+) -->$/)?.[1]??null;
  fences.push({file:file.slice(root.length),line:s.slice(0,m.index).split('\n').length,language:m[1],classification:m[1]==='json'?(marker?.startsWith('EX-')?'FORMAL_PROPOSED_JSON':'ILLUSTRATIVE_ONLY'):'READ_MODEL_PROJECTION_MANUALLY_CROSS_REVIEWED',exampleId:marker,declaredTypes:[...m[2].matchAll(/(?:interface|type)\s+(\w+)/g)].map(x=>x[1])});
 }}
 return {scope:'RFC001-008, ADR001-012, CONTRACTS, Roadmap, authoritative schema supplements',jsonValidation:'all formal JSON via validate-contract-examples.mjs',typescriptLimitation:'lexical inventory + cross-document review; not TypeScript compiler or production schema equivalence proof',fences};
}
export function validatePackage(){
 const examples=JSON.parse(readFileSync(join(packageRoot,'evidence/contract-examples.json'),'utf8'));
 const errors=[],report=[];
 const found=new Set();
 const files=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(p,e.name)):e.name.endsWith('.md')?[join(p,e.name)]:[]);
 for(const ex of examples){try{
   if(!/^EX-0[1-9]$/.test(ex.id)||found.has(ex.id))throw Error('duplicate/invalid example id');found.add(ex.id);
   if(ex.classification!=='VALID_AGAINST_PROPOSED_SCHEMA'||ex.approval!=='REQUIRES_HUMAN_DECISION'||ex.implementation!=='NOT_YET_IMPLEMENTED')throw Error('misclassified approval/implementation');
   validateExample(ex);report.push({id:ex.id,valid:true,implemented:false,humanApproved:false});
 }catch(e){errors.push(ex.id+': '+e.message);}}
 if(examples.length!==9)errors.push('exactly nine formal API examples required');
 let formalFences=0,illustrativeFences=0;
 for(const file of files(packageRoot)){
   const content=readFileSync(file,'utf8');
   for(const m of content.matchAll(/```json\n([\s\S]*?)\n```/g)){
     const before=content.slice(0,m.index).trimEnd();
     const marker=before.match(/<!-- contract-example: (EX-\d{2}|ILLUSTRATIVE-MANIFEST) -->$/)?.[1];
     let data;try{data=JSON.parse(m[1]);}catch{errors.push(file+': malformed JSON');continue;}
     if(marker==='ILLUSTRATIVE-MANIFEST'){
       illustrativeFences++;
       if((data.permissions??[]).some(p=>!permissions.includes(p)))errors.push('illustrative manifest unknown permission');
       for(const cap of data.capabilities??[]){
         if((cap.permissions??data.permissions).some(p=>!data.permissions.includes(p)))errors.push('capability grants outside manifest');
         for(const ex of examples.filter(e=>e.tool==='execute_module'&&e.arguments.module===data.id&&e.arguments.capability===cap.id)){
           const keys=Object.keys(cap.inputSchema?.properties??{});
           for(const k of Object.keys(ex.arguments.params))if(!keys.includes(k))errors.push('illustrative capability omits formal parameter '+k);
         }
       }
       continue;
     }
     if(!marker){errors.push(file+': unclassified JSON fence');continue;}
     const ex=examples.find(e=>e.id===marker); if(!ex){errors.push('undefined '+marker);continue;}
     const canonical=Object.fromEntries(['tool','arguments','response'].map(k=>[k,ex[k]]));
     if(!isDeepStrictEqual(data,canonical))errors.push(file+': drift from corpus '+marker);
     try{validateExample(data);}catch(e){errors.push(file+': '+marker+' '+e.message);}
     formalFences++;
   }
 }
 if(formalFences!==9||illustrativeFences!==1)errors.push('expected 9 formal fences and 1 explicitly illustrative manifest');
 if(!isDeepStrictEqual(schemaInventory(),JSON.parse(readFileSync(join(packageRoot,'evidence/contract-inventory.json'),'utf8'))))errors.push('contract inventory drift; regenerate and review schema/example fences');
 // Cross-example identity/count consistency, not only independent shapes.
 const byId=Object.fromEntries(examples.map(e=>[e.id,e]));
 const created=examples.flatMap(e=>e.response.created??[]);
 const read=byId['EX-08']?.response;
 if(read){for(const r of created)if(![...read.objects.map(o=>o.ref),...read.annotations.map(a=>a.ref)].some(o=>isDeepStrictEqual(o,r)))errors.push('read summary missing created ref');
 const c=byId['EX-09']?.response.counts;if(c?.objects!==read.objects.length||c?.annotations!==read.annotations.length)errors.push('export counts mismatch read summary');}
 return {status:errors.length?'FAIL':'PASS',formalExamples:report,formalFences,illustrativeFences,toolSchemas:Object.keys(api).length,errors,
 coverage:'Proposed schema shape, strict fields, IDs, selected enums, refs, revisions, lineage shape, affine/snapshot constraints, fence/corpus and sequence consistency. No production validator, runtime authorization, filesystem durability or real Host acceptance proved.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.includes('--write-inventory'))writeFileSync(join(packageRoot,'evidence/contract-inventory.json'),JSON.stringify(schemaInventory(),null,2)+'\n');
 const r=validatePackage();process.stdout.write(JSON.stringify(r,null,2)+'\n');if(r.errors.length)process.exitCode=1;
}
