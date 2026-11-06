// Stop the app first. The same exclusive OS lease prevents a second writer.
import { createUvaService } from '../src/uva/service.js';
const [directory,profile,action='verify',json='{}']=process.argv.slice(2);
if(!directory||!profile||!['verify','usage','checkpoint','backupStart','backupStep','backupCancel'].includes(action))throw Error('Usage: node scripts/uva-maintenance.mjs DIR PROFILE verify|usage|checkpoint|backupStart|backupStep|backupCancel [JSON arguments]. Backup covers document store only; export also includes assets.');
const service=await createUvaService({enabled:true,directory,profile});
try{console.log(JSON.stringify(await service.store.maintenance(action,JSON.parse(json)),null,2));}finally{await service.close();}
