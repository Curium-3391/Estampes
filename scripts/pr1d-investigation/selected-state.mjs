// Read-only selected-state inspection: never calls open/recover/maintenance.
import { ManagedFiles } from '../../src/persistence/filesystem.js';
import { loadCommitted } from '../../src/persistence/records.js';
import { PageStore } from '../../src/persistence/pages.js';
import { readGcPlan, protectedPaths } from '../../src/persistence/gc.js';
import { readBackupList } from '../../src/persistence/backup.js';
import { policyOf } from '../../src/persistence/lifecycle-state.js';
import { assertScratchStore } from './scratch.mjs';
export async function inspectSelected(root,manager=null){
 await assertScratchStore(root);const files=new ManagedFiles(root),snapshot=await loadCommitted(files),retention=[...snapshot.indices.retention];
 const fixedRoots=[];
 for(const [key,value]of retention)if(/^(recovery|checkpoint):/.test(key)&&value.envelope){
  const pages=new PageStore(files),r=await pages.hashed(value.envelope.rootHash,'visual-registry/roots',65536);
  for(const [kind,hash]of Object.entries(r.roots))await pages.read(hash,kind);
  fixedRoots.push({key,envelope:value.envelope,paths:[...pages.track]});
 }
 const mark=manager?await protectedPaths({files,current:snapshot,lifecycle:manager},{verify:false}):null;
 const backups=[];
 for(const [key,value]of retention)if(key.startsWith("backup:"))backups.push({key,value,list:await readBackupList(files,value.filesHash)});
 const plans=[];
 for(const [key,progress]of retention)if(key.startsWith('gc:')){
  const plan=await readGcPlan(files,progress),candidates=[];
  for(const [index,c]of plan.candidates.entries()){
   const digest=async p=>await files.exists(p)?await files.digest(p):null;
   candidates.push({index,...c,source:await digest(c.path),quarantineFile:await digest(c.quarantine),liveRoot:snapshot.files.includes(c.path),fixedRoots:fixedRoots.filter(r=>r.paths.includes(c.path)).map(r=>r.key),marked:mark?.paths.has(c.path)??null});
  }
  plans.push({key,plan,progress,pending:candidates.filter(c=>!progress.deleted.includes(c.index)).map(c=>c.index),candidates});
 }
 return {backups,envelope:snapshot.envelope,root:snapshot.root,livePaths:snapshot.files,fixedRoots,plans,retention,clock:policyOf(snapshot.indices.retention),runtimePins:manager?[...manager.pins.sessions.values()].map(p=>({id:p.id,kind:p.kind,paths:[...p.files.keys()]})):null,ledger:[...snapshot.indices.ledger],locator:[...snapshot.indices.locator]};
}
