import {register} from 'node:module';
if(process.env.PR1D_PROFILE_LABEL&&process.argv[1]?.endsWith('/persistence/worker.js'))register(new URL('./count-loader.mjs',import.meta.url));
