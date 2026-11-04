import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=await mkdtemp(join(process.env.PR1D_SCRATCH,'estampes-pr1c-parity-'));
const child=spawn(process.execPath,[fileURLToPath(new URL('./profile-parity.mjs',import.meta.url)),root],{stdio:'inherit'});
const code=await new Promise(resolve=>child.on('exit',resolve));process.exitCode=code??1;
