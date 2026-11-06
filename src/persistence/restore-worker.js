import { restoreBackupContents } from "./backup.js";
process.once("disconnect",()=>process.exit(1));
try{const value=await restoreBackupContents(process.argv[2],process.argv[3],process.argv[4]);process.send({value},()=>process.exit(0));}
catch(e){process.send({error:{code:e.code??"RECOVERY_REQUIRED",message:String(e.message).slice(0,300)}},()=>process.exit(1));}
