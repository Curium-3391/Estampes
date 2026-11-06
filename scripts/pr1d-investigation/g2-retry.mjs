// Destructive diagnostic only after a stopped Store's immutable before-copy is sealed.
import { openIsolatedStore } from '../../src/persistence/lease.js';
import { assertScratchStore } from './scratch.mjs';
const [root,id,options]=process.argv.slice(2);await assertScratchStore(root);
let store;
try{
 store=await openIsolatedStore(root,JSON.parse(options));const retry={open:store.status};
 if(store.status.state==='ready')retry.step=await store.maintenance('gcStep',{id});
 await store.close();console.log(JSON.stringify(retry));
}catch(e){console.log(JSON.stringify({error:{message:e.message,code:e.code}}));process.exitCode=1;}
finally{if(store){store.kill('SIGKILL');await store.waitForExit();}}
