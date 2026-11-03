// Architecture evidence and explicitly authorized phase scope checks. No production imports or mutations.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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
for(const manifest of ['execution-manifest.json','review-execution-manifest.json','final-gate-execution-manifest.json','pr1a-execution-manifest.json','pr1c-execution-manifest.json','pr1d-execution-manifest.json'].filter(n=>existsSync(join(dir,'evidence',n)))){
 const data=JSON.parse(read(join(dir,'evidence',manifest)));
 for(const run of data.runs){if(!run.log)continue;const stored=readFileSync(join(dir,'evidence',run.log)),bytes=run.encoding==='gzip'?gunzipSync(stored,{maxOutputLength:16*1024**2}):stored;check(bytes.length===run.bytes&&createHash('sha256').update(bytes).digest('hex')===run.sha256,`log integrity: ${run.log}`);}
 if(manifest==='pr1d-execution-manifest.json')for(const a of data.artifacts??[]){
  const safe=/^pr1d-logs\/[a-z0-9.-]+$/.test(a.path);check(safe,'unsafe PR-1D artifact path');if(!safe)continue;
  const bytes=readFileSync(join(dir,'evidence',a.path));check(bytes.length===a.bytes&&createHash('sha256').update(bytes).digest('hex')===a.sha256,`PR-1D artifact integrity: ${a.path}`);
 }
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

const pr1dPaths=new Set([
 'src/persistence/archive.js','src/persistence/backup.js','src/persistence/capacity.js',
 'src/persistence/coordinator.js','src/persistence/filesystem.js','src/persistence/gc.js',
 'src/persistence/journal.js','src/persistence/lease.js','src/persistence/lifecycle-state.js',
 'src/persistence/lifecycle.js','src/persistence/pages.js','src/persistence/pins.js',
 'src/persistence/records.js','src/persistence/restore-worker.js','src/persistence/worker.js',
 'tests/persistence-lifecycle.test.js','tests/persistence-lifecycle-faults.test.js',
 'tests/persistence-backup.test.js','tests/persistence-capacity.test.js','tests/fixtures/uva-lifecycle.mjs',
]);
const pr1dRemediationPaths=new Set([
 'src/persistence/backup.js','src/persistence/coordinator.js','src/persistence/filesystem.js',
 'src/persistence/gc.js','src/persistence/journal.js','src/persistence/lifecycle-state.js',
 'src/persistence/records.js','src/persistence/temporary-attribution.js',
 'tests/persistence-performance.test.js','tests/persistence-temporary-attribution.test.js',
 'tests/persistence-transactions.test.js',
]);
let pr1dRemediationAuthorized=false;
const remediationRecord=join(dir,'evidence/pr1d-remediation-authorization.json');
if(existsSync(remediationRecord)){
 const a=JSON.parse(read(remediationRecord));
 check(a.source==='explicit-maintainer-user-instruction'&&a.authorizedPr==='PR-1D-REMEDIATION'&&a.evidenceBaseCommit==='322038b4b6e24fef0210fc04781e87181f879d8c'&&a.scope==='performance-temporary-attribution-recovery-long-history-only','invalid PR-1D remediation authorization');
 check(a.authorizedProductionAndTestPaths.length===pr1dRemediationPaths.size&&a.authorizedProductionAndTestPaths.every(p=>pr1dRemediationPaths.has(p)),'PR-1D remediation attempts to expand fixed allowlist');
 check(a.activation===false&&a.pr1bAuthorized===false&&a.migrationAuthorized===false&&a.pushAuthorized===false,'PR-1D remediation exceeds authorization');
 check(existsSync(join(dir,'PR-1D-REMEDIATION-AUTHORIZATION.md')),'missing PR-1D remediation instruction boundary');pr1dRemediationAuthorized=true;
 const seal=JSON.parse(read(join(dir,'evidence/pr1d-remediation-source-seal.json')));check(seal.implementationCommit==='b163a859af93ea814c82f0e02e20da27c407bfad','unexpected remediation implementation commit');
 check(seal.paths.length===pr1dRemediationPaths.size&&seal.paths.every(f=>pr1dRemediationPaths.has(f.path))&&new Set(seal.paths.map(f=>f.path)).size===pr1dRemediationPaths.size,'remediation source seal differs from fixed scope');
 for(const f of seal.paths){const bytes=execFileSync('git',['show',seal.implementationCommit+':'+f.path],{cwd:root});check(bytes.length===f.bytes&&createHash('sha256').update(bytes).digest('hex')===f.sha256,`historical remediation source seal mismatch: ${f.path}`);}
}
// Current instruction is independent of the historical authorizations above.
const pr1dIntegrityPaths=new Set([
 'src/persistence/archive.js','src/persistence/coordinator.js','src/persistence/filesystem.js',
 'src/persistence/gc.js','src/persistence/lifecycle.js','src/persistence/pages.js',
 'src/persistence/records.js','src/persistence/temporary-attribution.js',
 'tests/persistence-integrity-hardening.test.js','tests/persistence-verification-race.test.js',
 'tests/fixtures/verification-read-race.mjs',
]);
let pr1dIntegrityAuthorized=false;
const integrityRecord=join(dir,'evidence/pr1d-integrity-hardening/authorization.json');
if(existsSync(integrityRecord)){
 const a=JSON.parse(read(integrityRecord)),baseline='a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0';
 check(a.source==='explicit-maintainer-user-instruction'&&a.authorizedPr==='PR-1D-INTEGRITY-HARDENING'&&a.evidenceBaseCommit===baseline,'invalid integrity hardening authorization');
 check(a.authorizedProductionAndTestPaths.length===pr1dIntegrityPaths.size&&new Set(a.authorizedProductionAndTestPaths).size===pr1dIntegrityPaths.size&&a.authorizedProductionAndTestPaths.every(p=>pr1dIntegrityPaths.has(p)),'integrity hardening attempts to expand fixed scope');
 check(a.activation===false&&a.pr1bAuthorized===false&&a.migrationAuthorized===false&&a.pushAuthorized===true,'integrity hardening exceeds authorization');
 check(existsSync(join(dir,'evidence/pr1d-integrity-hardening/AUTHORIZATION.md')),'missing integrity hardening instruction boundary');
 pr1dIntegrityAuthorized=true;
 const currentPaths=new Set([...git('diff','--name-only',baseline),...git('ls-files','--others','--exclude-standard')]);
 for(const p of currentPaths)check(pr1dIntegrityPaths.has(p)||p==='docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs'||p==='docs/rfc/unified-visual-architecture/PR-1D-INTEGRITY-HARDENING-REPORT.md'||p.startsWith('docs/rfc/unified-visual-architecture/evidence/pr1d-integrity-hardening/'),`outside integrity hardening scope / historical input changed: ${p}`);
}
const pr1dNativePaths=new Set(['src/persistence/gc.js','src/persistence/lifecycle-state.js','src/persistence/lease.js','src/persistence/records.js','src/persistence/temporary-attribution.js','tests/fixtures/delayed-spawn-preload.mjs','tests/persistence-performance.test.js','tests/persistence-platform.test.js','tests/persistence-temporary-attribution.test.js']);
let pr1dNativeAuthorized=false;const nativeRecord=join(dir,'evidence/pr1d-native-findings-authorization.json');
if(existsSync(nativeRecord)){const a=JSON.parse(read(nativeRecord));check(a.source==='explicit-maintainer-user-instruction'&&a.authorizedPr==='PR-1D-NATIVE-FINDINGS'&&a.evidenceBaseCommit==='05913e926aa07a528815a5f3f3d2078c108e8833','invalid native findings authorization');check(a.authorizedProductionAndTestPaths.length===pr1dNativePaths.size&&a.authorizedProductionAndTestPaths.every(p=>pr1dNativePaths.has(p)),'native findings scope mismatch');check(a.activation===false&&a.pr1bAuthorized===false&&a.migrationAuthorized===false&&a.pushAuthorized===true,'native findings authorization boundary mismatch');pr1dNativeAuthorized=true;
 const seal=JSON.parse(read(join(dir,'evidence/pr1d-native-findings-source-seal.json')));check(/^[0-9a-f]{40}$/.test(seal.implementationCommit)&&seal.paths.length===pr1dNativePaths.size&&seal.paths.every(f=>pr1dNativePaths.has(f.path)),'invalid native findings source seal');for(const f of seal.paths){const historical=execFileSync('git',['show',seal.implementationCommit+':'+f.path],{cwd:root}),bytes=pr1dIntegrityAuthorized&&pr1dIntegrityPaths.has(f.path)?historical:readFileSync(join(root,f.path));check(bytes.length===f.bytes&&createHash('sha256').update(bytes).digest('hex')===f.sha256&&historical.equals(bytes),`native findings source seal mismatch: ${f.path}`);}}
let pr1dAuthorized=false;
const pr1dRecord=join(dir,'evidence/pr1d-authorization.json');
if(existsSync(pr1dRecord)){
 const a=JSON.parse(read(pr1dRecord)),approvedBase='58f7789414130085543560147df87e85a62123ea';
 check(a.source==='explicit-maintainer-user-instruction'&&a.authorizedPr==='PR-1D'&&a.evidenceBaseCommit===approvedBase&&a.scope==='isolated-retention-history-gc-ledger-quota-backup-only','invalid limited PR-1D authorization');
 check(a.authorizedProductionAndTestPaths.length===pr1dPaths.size&&a.authorizedProductionAndTestPaths.every(p=>pr1dPaths.has(p)),'PR-1D record attempts to expand fixed allowlist');
 check(a.activation===false&&a.pr1bAuthorized===false&&a.migrationAuthorized===false&&a.pushAuthorized===false,'PR-1D activation/continuation exceeds authorization');
 check(existsSync(join(dir,'PR-1D-AUTHORIZATION.md')),'missing limited PR-1D instruction record');
 pr1dAuthorized=true;
 for(const p of new Set([...git('diff','--name-only',approvedBase),...git('ls-files','--others','--exclude-standard')]))check(p==='IMPLEMENTATION-ROADMAP.md'||p.startsWith('docs/rfc/unified-visual-architecture/')||pr1dPaths.has(p)||(pr1dRemediationAuthorized&&pr1dRemediationPaths.has(p))||(pr1dNativeAuthorized&&pr1dNativePaths.has(p))||(pr1dIntegrityAuthorized&&pr1dIntegrityPaths.has(p)),`outside isolated PR-1D scope: ${p}`);
 const sealPath=join(dir,'evidence/pr1d-source-seal.json');
 if(existsSync(sealPath)){
  const seal=JSON.parse(read(sealPath));check(/^[0-9a-f]{40}$/.test(seal.implementationCommit),'invalid implementation source commit');
  check(seal.paths.length===pr1dPaths.size&&seal.paths.every(f=>pr1dPaths.has(f.path))&&new Set(seal.paths.map(f=>f.path)).size===pr1dPaths.size,'source seal differs from fixed PR-1D scope');
  for(const f of seal.paths){const bytes=execFileSync('git',['show',seal.implementationCommit+':'+f.path],{cwd:root});check(bytes.length===f.bytes&&createHash('sha256').update(bytes).digest('hex')===f.sha256,`historical PR-1D source seal mismatch: ${f.path}`);}
 }
 // Never weaken existing tests, allowlists or historical acceptance to make maintenance pass.
 for(const p of git('ls-tree','-r','--name-only',approvedBase))if(p.startsWith('tests/')||/docs\/rfc\/unified-visual-architecture\/(?:PR-1[AC][^/]*\.md|evidence\/pr1[ac](?:-|\.))/.test(p)||p==='src/persistence/platform.js'){
  const before=execFileSync('git',['show',approvedBase+':'+p],{cwd:root}),after=readFileSync(join(root,p));
  if(pr1dRemediationAuthorized&&p==='tests/persistence-transactions.test.js'){
   const old=before.toString(),current=after.toString(),testNames=[...old.matchAll(/test\("([^"]+)"/g)].map(m=>m[1]);check(testNames.every(name=>current.includes(`test("${name}"`)),'remediation removed an existing transaction test');
   check((current.match(/assert\./g)??[]).length>=(old.match(/assert\./g)??[]).length,'remediation weakened transaction assertions');
  }else if(pr1dNativeAuthorized&&pr1dNativePaths.has(p)){const old=before.toString(),current=after.toString(),testNames=[...old.matchAll(/test\("([^"]+)"/g)].map(m=>m[1]);check(testNames.every(name=>current.includes(`test("${name}"`)),'native remediation removed an existing test');check((current.match(/assert\./g)??[]).length>=(old.match(/assert\./g)??[]).length,'native remediation weakened test assertions');}
  else check(before.equals(after),`pre-PR-1D test/native/guard evidence changed: ${p}`);
 }
}
const pr1cAuthorizationPath=join(dir,'evidence/pr1c-authorization.json');
const reviewPaths=new Set(['src/documents/integrity.js','src/documents/legacy-shadow.js','tests/documents-review.test.js']);
const persistencePaths=new Set([
 'src/persistence/coordinator.js','src/persistence/errors.js','src/persistence/filesystem.js',
 'src/persistence/journal.js','src/persistence/lease.js','src/persistence/pages.js',
 'src/persistence/platform.js','src/persistence/records.js','src/persistence/worker.js',
 'tests/persistence-transactions.test.js','tests/persistence-faults.test.js',
 'tests/persistence-platform.test.js','tests/fixtures/uva-persistence.mjs',
]);
let pr1cAuthorized=false;
if(existsSync(pr1cAuthorizationPath)){
 const a=JSON.parse(read(pr1cAuthorizationPath));
 check(a.source==='explicit-maintainer-user-instruction'&&a.evidenceBaseCommit==='7eae7f5748a4c264a7dc996b07f005f95e34ff37'&&a.scope==='isolated-coordinator-journal-generations-recovery-only','invalid limited PR-1C authorization');
 check(a.authorizedPrs.includes('PR-1C')&&existsSync(join(dir,'PR-1C-AUTHORIZATION.md')),'missing PR-1C authorization scope');
 pr1cAuthorized=true;
 for(const p of persistencePaths)check(!execFileSync('git',['ls-tree','--name-only',a.evidenceBaseCommit,'--',p],{cwd:root,encoding:'utf8'}).trim(),`PR-1C must add isolated files: ${p}`);
 const sincePr1a=new Set([...git('diff','--name-only',a.evidenceBaseCommit),...git('ls-files','--others','--exclude-standard')]);
 for(const p of sincePr1a)check(p==='IMPLEMENTATION-ROADMAP.md'||p.startsWith('docs/rfc/unified-visual-architecture/')||reviewPaths.has(p)||persistencePaths.has(p)||(pr1dAuthorized&&pr1dPaths.has(p))||(pr1dRemediationAuthorized&&pr1dRemediationPaths.has(p))||(pr1dNativeAuthorized&&pr1dNativePaths.has(p))||(pr1dIntegrityAuthorized&&pr1dIntegrityPaths.has(p)),`outside PR-1A remediation / PR-1C scope: ${p}`);
}
for(const p of paths)check(p==='IMPLEMENTATION-ROADMAP.md'||p.startsWith('docs/rfc/unified-visual-architecture/')||(pr1aAuthorized&&pr1aPaths.has(p))||(pr1cAuthorized&&(reviewPaths.has(p)||persistencePaths.has(p)))||(pr1dAuthorized&&pr1dPaths.has(p))||(pr1dRemediationAuthorized&&pr1dRemediationPaths.has(p))||(pr1dNativeAuthorized&&pr1dNativePaths.has(p))||(pr1dIntegrityAuthorized&&pr1dIntegrityPaths.has(p)),`outside approved Phase 0 / limited PR-1A scope: ${p}`);
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
else process.stdout.write(`Architecture consistency: 8 RFCs, 12 ADRs, 67 cases, ${prs.size} PR units, 6 findings, 6 independent FG findings, OD-01..06; 95 pre-existing production/config hashes, historical baseline/reports and original 16 documentation test expectations unchanged; 9 formal examples validated; ${pr1dIntegrityAuthorized?'PR-1D integrity hardening and branch push authorized; historical seals preserved; activation and PR-1B remain unauthorized':pr1dNativeAuthorized?'PR-1D native findings remediation and branch push authorized; activation and PR-1B remain unauthorized':pr1dAuthorized?'isolated PR-1D authorized; existing tests/native evidence preserved; activation, PR-1B and push remain unauthorized':pr1cAuthorized?'limited PR-1A remediation / PR-1C authorized; PR-1D / PR-1B remain pending':pr1aAuthorized?'limited PR-1A additions authorized; later PRs remain pending':'final recommendation is not human approval'}.\n`);
