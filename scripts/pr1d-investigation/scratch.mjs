import assert from 'node:assert/strict';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
export async function assertScratchStore(root) {
  const scratch=resolve(process.env.PR1D_SCRATCH??'/nonexistent');
  assert.equal(await realpath(scratch),scratch);const parent=await lstat(scratch);
  assert.ok(parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o777)===0o700);
  assert.equal(dirname(resolve(root)),scratch);assert.match(basename(root),/^estampes-pr1c-/);
  assert.equal(await realpath(root),resolve(root));const st=await lstat(root);
  assert.ok(st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700&&st.dev===parent.dev);
  return {scratch,st};
}
export async function safeInventory(root,limit=512*1024**2) {
  const {st}=await assertScratchStore(root);let allocated=0;const rows=[];
  async function walk(path){for(const name of (await readdir(path)).sort()){
    const p=join(path,name),s=await lstat(p,{bigint:true});
    assert.equal(s.dev,BigInt(st.dev));assert.equal(s.uid,BigInt(process.getuid()));assert.ok(!s.isSymbolicLink());
    allocated+=Number(s.blocks)*512;assert.ok(allocated<=limit,'scratch allocation limit');
    if(s.isDirectory())await walk(p);else{assert.ok(s.isFile()&&s.nlink===1n);rows.push({path:p.slice(root.length+1),dev:String(s.dev),ino:String(s.ino),bytes:Number(s.size),allocatedBytes:Number(s.blocks)*512});}
  }}await walk(root);return {allocatedBytes:allocated,files:rows};
}
