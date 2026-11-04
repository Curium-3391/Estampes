// Test-only observer. Does not read selected state until the real step returns.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertScratchStore } from './scratch.mjs';
import { expectedFixtureG2State } from './g2-expectation.mjs';
if(process.env.PR1D_G2_PRESERVE==='1'&&process.argv[1]?.endsWith('/persistence/worker.js')){
 const root=process.argv[2];await assertScratchStore(root);
 const {ManagedFiles}=await import('../../src/persistence/filesystem.js');
 const {GarbageCollector}=await import('../../src/persistence/gc.js');
 const name=root.split('/').at(-1),out=process.env.PR1D_OUTPUT;
 const emit=(event,data)=>appendFileSync(join(out,`g2-${name}.jsonl`),JSON.stringify({event,pid:process.pid,...data})+'\n');
 const trace=[];const point=ManagedFiles.prototype.point;
 ManagedFiles.prototype.point=async function(name,details){
  // Record only completed points; original pause/fault behavior is preserved.
  const value=await point.call(this,name,details);trace.push({name,details});if(trace.length>512)trace.shift();return value;
 };
 const step=GarbageCollector.prototype.step;
 GarbageCollector.prototype.step=async function(id){
  let result;
  try{result=await step.call(this,id);}catch(error){
   const manager=this.manager,current=manager.owner.current;
   const failure={root,id,error:{code:error.code,message:error.message},envelope:current?.envelope,progress:current?.indices.retention.get('gc:'+id),clock:{nowMs:manager.now()},trace};
   emit('gc-error',failure);writeFileSync(join(out,`failure-${name}.json`),JSON.stringify(failure)+'\n',{flag:'wx',mode:0o600});throw error;
  }
  const manager=this.manager,current=manager.owner.current;
  const progress=current.indices.retention.get('gc:'+id);
  const {policyOf}=await import('../../src/persistence/lifecycle-state.js');
  const clock={nowMs:manager.now(),highWaterMs:policyOf(current.indices.retention)?.highWaterMs,legacyClockFloor:manager.legacyClockFloor,canAge:manager.canAge()};
  // Result and in-memory selected identity are recorded before diagnostic I/O.
  emit('returned',{result,id,envelope:current.envelope,progress,clock,trace,
   pins:{epoch:manager.pins.epoch,sessions:[...manager.pins.sessions.values()].map(p=>({id:p.id,kind:p.kind,paths:[...p.files.keys()],expiresAt:p.expiresAt,active:p.active,closing:p.closing}))}});
  const unexpected=result.state!==expectedFixtureG2State(progress,clock);
  if(unexpected){
   // Signal preservation before any fallible selected-state inspection.
   writeFileSync(join(out,`failure-${name}.json`),JSON.stringify({root,id,result,envelope:current.envelope,progress,clock,trace})+'\n',{flag:'wx',mode:0o600});
   try{const {inspectSelected}=await import('./selected-state.mjs');emit('failure-selected',await inspectSelected(root,manager));}
   catch(error){emit('inspection-error',{message:error.message,code:error.code});}
  }
  return result;
 };
}
