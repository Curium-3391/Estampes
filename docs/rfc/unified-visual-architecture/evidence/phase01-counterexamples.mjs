// Review evidence: reproduce defects in the immutable Phase 0.1 DOCUMENT schema.
// Does not load production code, register tools or change any data.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const base='df70d2bfb84f5548fb8e7fc81ebfbd0eb4eefadd';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const source=execFileSync('git',['show',base+':docs/rfc/unified-visual-architecture/evidence/proposed-contracts.mjs'],{cwd:root,encoding:'utf8'}).replace("from 'zod'","from '"+pathToFileURL(createRequire(import.meta.url).resolve('zod')).href+"'");
const {Matrix,Provenance}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const p={kind:'module',moduleId:'org.estampes.graph',publisherFingerprint:'a'.repeat(64),ownershipLineageId:'lineage:00000001-0000-4000-8000-000000000001',version:'1.0.0',packageDigest:'b'.repeat(64)};
const provenance={author:'module',createdBy:p,lastEditedBy:p,createdAt:'2026-11-01T00:00:00Z',lastEditedAt:'2026-11-01T00:00:00Z',ownership:{kind:'module',moduleId:p.moduleId,publisherFingerprint:p.publisherFingerprint,ownershipLineageId:p.ownershipLineageId},grounding:'tool-output',editedByUser:false,sourceTrust:'imported-unverified'};
process.stdout.write(JSON.stringify({classification:'OBSERVED_PHASE01_DOCUMENT_VALIDATOR_COUNTEREXAMPLES_NOT_PRODUCT_BEHAVIOR',base,validSmallScaleAccepted:Matrix.safeParse([1e-7,0,0,0,1e-7,0,0,0,1]).success,illConditionedMatrixAccepted:Matrix.safeParse([1e10,0,0,0,1e-4,0,0,0,1]).success,importedActiveModuleOwnerAccepted:Provenance.safeParse(provenance).success},null,2)+'\n');
