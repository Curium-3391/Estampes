// Read-only access also works when experimental activation is disabled.
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateAncestry, privateFile } from '../persistence/ownership.js';
export async function readSavedExport(directory,id){
  if(!directory||!/^[0-9a-f]{64}$/.test(id))throw new Error('Configure the original Beta directory to access saved exports');
  const root=resolve(directory),dir=join(root,'exports');
  if(await realpath(dir)!==dir)throw new Error('Export path contains a symlink');
  await privateAncestry(dir);
  const fd=await open(join(dir,id+'.zip'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();privateFile(st);if(st.size>40*1024**2)throw new Error('Export exceeds limit');const b=await fd.readFile();if(createHash('sha256').update(b).digest('hex')!==id)throw new Error('Export hash mismatch');return b;}finally{await fd.close();}
}
