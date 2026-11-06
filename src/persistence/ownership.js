// Unix DAC checks for a private trusted-UID domain. These checks do not
// isolate one process from another process running with the same UID.
import { lstat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fail } from "./errors.js";

const enforce=(ok,message)=>{if(!ok)fail("INTEGRITY_ERROR",message,{storageIntegrity:true});};
const uid=()=>process.geteuid();
export function privateDirectory(st){
  enforce(st.isDirectory()&&!st.isSymbolicLink()&&Number(st.uid)===uid()&&(Number(st.mode)&0o077)===0,"Managed directory is not private to the writer UID");
}
export function privateFile(st){
  enforce(st.isFile()&&!st.isSymbolicLink()&&Number(st.uid)===uid()&&Number(st.nlink)===1&&(Number(st.mode)&0o022)===0,"Managed file has unsafe ownership, links or write permissions");
}
export async function privateAncestry(root){
  enforce(process.getuid()===uid(),"Writer real/effective UID differs");
  const path=resolve(root);let cursor=path;
  for(;;){
    const st=await lstat(cursor);
    if(cursor===path)privateDirectory(st);
    else{
      enforce(st.isDirectory()&&!st.isSymbolicLink()&&(st.uid===uid()||st.uid===0),"Untrusted managed-tree ancestry");
      const protectedSticky=st.uid===0&&(st.mode&0o1000)!==0;
      enforce((st.mode&0o022)===0||protectedSticky,"Managed-tree ancestor is writable by another UID");
    }
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
  return {model:"private-trusted-uid/1",uid:uid(),unixPermissions:"checked",sameUidAdversary:"unsupported-not-isolated",privilegedActors:"outside-guarantee"};
}
export async function privateLeaseTree(root){
  const trust=await privateAncestry(root);
  try{privateFile(await lstat(join(root,"WRITER.lock")));}catch(error){if(error.code!=="ENOENT")throw error;}
  return trust;
}
