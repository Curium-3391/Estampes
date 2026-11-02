// A failed prerequisite probe is explicitly BLOCKED, not native acceptance.
import { mkdtemp,rm,statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPlatform } from "../../../../src/persistence/platform.js";
const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-pr1d-native-"));
try{
 const fs=await statfs(root,{bigint:true});
 try{const profile=await inspectPlatform(root,"linux-local-durable","isolated-pr1c-testing");process.stdout.write(JSON.stringify({status:"NATIVE_PREREQUISITE_AVAILABLE_NOT_ACCEPTANCE",node:process.version,filesystemMagic:fs.type.toString(16),profile})+"\n");}
 catch(e){process.stdout.write(JSON.stringify({status:"IMPLEMENTATION BLOCKED",gate:"new-code-native-ext4-xfs",node:process.version,filesystemMagic:fs.type.toString(16),error:{code:e.code,message:e.message},allowlistChanged:false,historicalNativeEvidenceReusedAsCurrent:false,powerLossTested:false})+"\n");process.exitCode=2;}
}finally{await rm(root,{recursive:true,force:true});}
