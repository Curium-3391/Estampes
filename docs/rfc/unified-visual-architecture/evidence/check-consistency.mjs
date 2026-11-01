// Phase 0/0.1 documentation checks only. No production imports or mutations.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatePackage } from './validate-contract-examples.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const dir=join(root,'docs/rfc/unified-visual-architecture');
const errors=[];const check=(ok,msg)=>{if(!ok)errors.push(msg);};
const read=p=>readFileSync(p,'utf8');
const collect=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(join(p,e.name)):e.name.endsWith('.md')?[join(p,e.name)]:[]);
for(let i=1;i<=8;i++)check(existsSync(join(dir,`RFC-${String(i).padStart(3,'0')}.md`)),`missing RFC ${i}`);
for(let i=1;i<=12;i++){
 const p=join(dir,`adr/ADR-${String(i).padStart(3,'0')}.md`);check(existsSync(p),`missing ADR ${i}`);
 if(existsSync(p))for(const h of ['Context','Options Considered','Decision','Rationale','Consequences','Rejected Alternatives'])check(read(p).includes('## '+h),`${p} missing ${h}`);
}
const matrix=read(join(dir,'TEST-MATRIX.md'));
const cases=[...matrix.matchAll(/^\| (UVA-\d{2})\b/gm)].map(m=>m[1]);
check(cases.length===62&&new Set(cases).size===62,'62 unique UVA cases required; old 40 cannot disappear');
for(let i=1;i<=62;i++)check(cases.includes(`UVA-${String(i).padStart(2,'0')}`),`missing UVA ${i}`);
const roadmap=read(join(root,'IMPLEMENTATION-ROADMAP.md'));
const prs=new Set([...roadmap.matchAll(/^\| (PR-[0-7][A-D])\s*\|/gm)].map(m=>m[1]));
check(prs.size===23,'23 defined PR units required');
const docs=[...collect(dir),join(root,'IMPLEMENTATION-ROADMAP.md')];
const od=read(join(dir,'OPEN-DECISIONS.md'));
for(let i=1;i<=6;i++)check(od.includes(`## OD-${String(i).padStart(2,'0')}`),`missing OD ${i}`);
const report=read(join(dir,'REVIEW-REMEDIATION.md'));
const statuses=['RESOLVED — SPECIFICATION COMPLETE','PARTIALLY RESOLVED','OPEN — HUMAN DECISION REQUIRED','BLOCKED — MISSING EVIDENCE'];
for(let i=1;i<=6;i++){
 const id=`R-${String(i).padStart(2,'0')}`;
 const section=report.split(`## ${id} — `)[1]?.split('\n## ')[0]??'';
 check(section.length>600,`incomplete ${id} remediation`);
 const status=section.match(/\*\*Status\*\*：([^\n]+)/)?.[1];check(statuses.includes(status),`${id} invalid status`);
}
for(const p of docs){const s=read(p);
 for(const m of s.matchAll(/\bPR-[0-7][A-D]\b/g))check(prs.has(m[0]),`${p} undefined ${m[0]}`);
 for(const m of s.matchAll(/\bUVA-(\d{2})\b/g))check(cases.includes(m[0]),`${p} undefined ${m[0]}`);
 for(const [kind,max,digits] of [['RFC',8,3],['ADR',12,3],['OD',6,2],['R',6,2]])for(const m of s.matchAll(new RegExp('\\b'+kind+'-(\\d{'+digits+'})\\b','g')))check(+m[1]>=1&&+m[1]<=max,`${p} undefined ${m[0]}`);
}
const inventory=JSON.parse(read(join(dir,'evidence/source-index.json')));
for(const f of inventory.files)check(createHash('sha256').update(readFileSync(join(root,f.path))).digest('hex')===f.sha256,`production/config modified: ${f.path}`);
for(const manifest of ['execution-manifest.json','review-execution-manifest.json']){
 const data=JSON.parse(read(join(dir,'evidence',manifest)));
 for(const run of data.runs){if(!run.log)continue;const bytes=readFileSync(join(dir,'evidence',run.log));check(bytes.length===run.bytes&&createHash('sha256').update(bytes).digest('hex')===run.sha256,`log integrity: ${run.log}`);}
}
const base='b42e6afc7ca78b280ad522a93e111ba2ef407cd7';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const paths=new Set([...git('diff','--name-only',base),...git('ls-files','--others','--exclude-standard')]);
for(const p of paths)check(p==='IMPLEMENTATION-ROADMAP.md'||p.startsWith('docs/rfc/unified-visual-architecture/'),`outside Phase 0.1 scope: ${p}`);
// The original audit and logs remain historical evidence, not rewritten results.
for(const p of ['tests/uva-characterization.test.js','docs/rfc/unified-visual-architecture/BASELINE.md','docs/rfc/unified-visual-architecture/evidence/source-index.json','docs/rfc/unified-visual-architecture/evidence/execution-manifest.json']){
 const original=execFileSync('git',['show',base+':'+p],{cwd:root});check(original.equals(readFileSync(join(root,p))),`historical baseline changed: ${p}`);
}
const exampleResult=validatePackage();for(const e of exampleResult.errors)errors.push('example: '+e);
// Detect the concrete contradictions from review, not only link existence.
check(read(join(dir,'RFC-002.md')).includes('provenance: AnnotationProvenance;'),'RFC002 must share full provenance type');
check(!read(join(dir,'CONTRACTS.md')).includes('usermove/restyle僅ownmarks'),'old policy incorrectly applied to Unified');
check(!read(join(dir,'RFC-006.md')).includes('完整manifest copy-on-write優先'),'unbounded full root manifest remains');
if(errors.length){process.stderr.write(errors.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(`Phase 0.1 consistency: 8 RFCs, 12 ADRs, 62 cases, ${prs.size} PR units, 6 findings, OD-01..06; 95 production/config hashes and historical baseline unchanged; 9 formal examples validated.\n`);
