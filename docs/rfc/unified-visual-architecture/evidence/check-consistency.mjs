// Architecture evidence and limited PR-1A scope checks. No production imports or mutations.
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
check(cases.length===67&&new Set(cases).size===67,'67 unique UVA cases required; old 62 cannot disappear');
for(let i=1;i<=67;i++)check(cases.includes(`UVA-${String(i).padStart(2,'0')}`),`missing UVA ${i}`);
const roadmap=read(join(root,'IMPLEMENTATION-ROADMAP.md'));
const prs=new Set([...roadmap.matchAll(/^\| (PR-[0-7][A-D])\s*\|/gm)].map(m=>m[1]));
check(prs.size===23,'23 defined PR units required');
const docs=[...collect(dir),join(root,'IMPLEMENTATION-ROADMAP.md')];
const od=read(join(dir,'OPEN-DECISIONS.md'));
for(let i=1;i<=6;i++)check(od.includes(`## OD-${String(i).padStart(2,'0')}`),`missing OD ${i}`);
const report=read(join(dir,'REVIEW-REMEDIATION.md'));
const finalReport=read(join(dir,'FINAL-ARCHITECTURE-GATE.md'));
for(const heading of 'ABCDEFGHIJ')check(finalReport.includes(`## ${heading}. `),`missing final gate section ${heading}`);
check(!finalReport.includes('VERIFICATION_RESULTS_PENDING'),'final verification table unfinished');
const finalStatuses=['VERIFIED — SPECIFICATION COMPLETE','ACCEPTED WITH CONDITIONS','REQUIRES SPECIFICATION CHANGE','BLOCKED'];
for(let i=1;i<=6;i++){
 const id=`R-${String(i).padStart(2,'0')}`;
 const section=finalReport.split(`### ${id} — `)[1]?.split('\n### ')[0]?.split('\n## ')[0]??'';
 check(section.length>500,`independent review incomplete: ${id}`);
 check(finalStatuses.includes(section.match(/^Classification: (.+)$/m)?.[1]),`invalid independent classification: ${id}`);
}
const recommendations=[...finalReport.matchAll(/^Recommendation: (.+)$/gm)];
check(recommendations.length===1&&['READY FOR HUMAN APPROVAL','READY FOR LIMITED PHASE 1A APPROVAL','SPECIFICATION REMEDIATION REQUIRED','ARCHITECTURE BLOCKED'].includes(recommendations[0]?.[1]),'final gate must choose exactly one permitted recommendation');
for(let i=1;i<=6;i++)check(finalReport.includes(`| FG-${String(i).padStart(2,'0')} |`),`missing independent FG ${i}`);
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
 for(const [kind,max,digits] of [['RFC',8,3],['ADR',12,3],['OD',6,2],['R',6,2],['FG',6,2]])for(const m of s.matchAll(new RegExp('\\b'+kind+'-(\\d{'+digits+'})\\b','g')))check(+m[1]>=1&&+m[1]<=max,`${p} undefined ${m[0]}`);
}
const inventory=JSON.parse(read(join(dir,'evidence/source-index.json')));
for(const f of inventory.files)check(createHash('sha256').update(readFileSync(join(root,f.path))).digest('hex')===f.sha256,`production/config modified: ${f.path}`);
for(const manifest of ['execution-manifest.json','review-execution-manifest.json','final-gate-execution-manifest.json','pr1a-execution-manifest.json'].filter(n=>existsSync(join(dir,'evidence',n)))){
 const data=JSON.parse(read(join(dir,'evidence',manifest)));
 for(const run of data.runs){if(!run.log)continue;const bytes=readFileSync(join(dir,'evidence',run.log));check(bytes.length===run.bytes&&createHash('sha256').update(bytes).digest('hex')===run.sha256,`log integrity: ${run.log}`);}
}
const base='b42e6afc7ca78b280ad522a93e111ba2ef407cd7';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const paths=new Set([...git('diff','--name-only',base),...git('ls-files','--others','--exclude-standard')]);
// The maintainer's new PR-1A instruction authorizes additions only. Do not
// weaken the historical hash checks or let an editable manifest expand scope.
const pr1aPaths=new Set([
 'src/documents/validation.js','src/documents/identity.js','src/documents/references.js',
 'src/documents/provenance.js','src/documents/embed-schema.js','src/documents/schema.js',
 'src/documents/integrity.js','src/documents/input-schema.js','src/documents/legacy-shadow.js',
 'src/persistence/commit-root-schema.js','tests/documents-foundation.test.js',
 'tests/documents-shadow.test.js','tests/fixtures/uva-pr1a.mjs',
]);
const authorizationPath=join(dir,'evidence/pr1a-authorization.json');
let pr1aAuthorized=false;
if(existsSync(authorizationPath)){
 const a=JSON.parse(read(authorizationPath));
 check(a.source==='explicit-maintainer-user-instruction'&&a.authorizedPr==='PR-1A'&&a.scope==='schema-and-read-only-shadow-only','invalid limited PR-1A authorization record');
 check(a.evidenceBaseCommit==='1fc6de91d1618e57a492eee1059c54d0bb0f735d','unexpected PR-1A evidence baseline');
 check(a.authorizedProductionAndTestPaths.length===pr1aPaths.size&&a.authorizedProductionAndTestPaths.every(p=>pr1aPaths.has(p)),'PR-1A record attempts to expand the approved file list');
 check(existsSync(join(dir,'PR-1A-AUTHORIZATION.md')),'limited human authorization text missing');
 pr1aAuthorized=true;
 for(const p of pr1aPaths){
  const atBase=execFileSync('git',['ls-tree','--name-only',a.evidenceBaseCommit,'--',p],{cwd:root,encoding:'utf8'}).trim();
  check(!atBase,`PR-1A may only add isolated production/test files: ${p}`);
 }
}
for(const p of paths)check(p==='IMPLEMENTATION-ROADMAP.md'||p.startsWith('docs/rfc/unified-visual-architecture/')||(pr1aAuthorized&&pr1aPaths.has(p)),`outside approved Phase 0 / limited PR-1A scope: ${p}`);
// The original audit and logs remain historical evidence, not rewritten results.
for(const p of ['tests/uva-characterization.test.js','docs/rfc/unified-visual-architecture/BASELINE.md','docs/rfc/unified-visual-architecture/evidence/source-index.json','docs/rfc/unified-visual-architecture/evidence/execution-manifest.json']){
 const original=execFileSync('git',['show',base+':'+p],{cwd:root});check(original.equals(readFileSync(join(root,p))),`historical baseline changed: ${p}`);
}
const reviewBase='df70d2bfb84f5548fb8e7fc81ebfbd0eb4eefadd';
for(const p of ['docs/rfc/unified-visual-architecture/REVIEW-REMEDIATION.md','docs/rfc/unified-visual-architecture/evidence/review-execution-manifest.json','docs/rfc/unified-visual-architecture/evidence/contract-examples.json'])check(execFileSync('git',['show',reviewBase+':'+p],{cwd:root}).equals(readFileSync(join(root,p))),`Phase 0.1 historical report/log manifest/formal corpus changed: ${p}`);
const oldTest=execFileSync('git',['show',reviewBase+':docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs'],{cwd:root,encoding:'utf8'});
check(read(join(dir,'evidence/contract-validation.spec.mjs')).includes(oldTest.slice(oldTest.indexOf("test('"))),'original 16 documentation test bodies/expectations changed');
const exampleResult=validatePackage();for(const e of exampleResult.errors)errors.push('example: '+e);
// Detect the concrete contradictions from review, not only link existence.
check(read(join(dir,'RFC-002.md')).includes('provenance: AnnotationProvenance;'),'RFC002 must share full provenance type');
check(!read(join(dir,'CONTRACTS.md')).includes('usermove/restyle僅ownmarks'),'old policy incorrectly applied to Unified');
check(!read(join(dir,'RFC-006.md')).includes('完整manifest copy-on-write優先'),'unbounded full root manifest remains');
check(!read(join(dir,'STORAGE-LIFECYCLE.md')).includes('4. grace至少24h'),'blanket full-copy quarantine remains');
check(!read(join(dir,'RFC-004.md')).includes('Mutation required `{commandId'),'wire accepts internal commandId');
if(errors.length){process.stderr.write(errors.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(`Architecture consistency: 8 RFCs, 12 ADRs, 67 cases, ${prs.size} PR units, 6 findings, 6 independent FG findings, OD-01..06; 95 pre-existing production/config hashes, historical baseline/reports and original 16 documentation test expectations unchanged; 9 formal examples validated; ${pr1aAuthorized?'limited PR-1A additions authorized; later PRs remain pending':'final recommendation is not human approval'}.\n`);
