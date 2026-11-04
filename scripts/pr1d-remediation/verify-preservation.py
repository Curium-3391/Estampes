"""Fixed current scope plus bytewise preservation of every baseline artifact."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[2]
BASE='d9aaa49f27d195ed53baeb12e95e434f1a7b10b0'
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
RUNTIME={'src/documents/validation.js'}
NEW_TESTS={'tests/persistence-metadata-remediation.test.js','tests/document-canonical-remediation.test.js'}
REPORT='docs/rfc/unified-visual-architecture/PR-1D-PERFORMANCE-REMEDIATION-REPORT.md'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
entries=[]
for row in git('ls-tree','-rz',BASE).split(b'\0'):
 if row:
  header,name=row.split(b'\t',1);mode,kind,oid=header.decode().split();entries.append((name.decode(),mode,oid))
assert not git('diff',BASE,'29d097833688ddb649a88cb2a09f22ba5fadda8e','--','src')
originalValidation=git('show',BASE+':src/documents/validation.js').decode()
finalValidation=(ROOT/'src/documents/validation.js').read_text()
head='export const jsonSchema = ';tail='export const bounded = '
assert originalValidation.split(head,1)[0]==finalValidation.split(head,1)[0], 'Guard source changed'
assert originalValidation.split(tail,1)[1]==finalValidation.split(tail,1)[1], 'Public canonical encoder or other validation source changed'
changed=[];preserved=0
for name,mode,oid in entries:
 p=ROOT/name
 assert mode!='120000',f'Explicit symlink handling required: {name}'
 data=p.read_bytes();actual=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
 if actual==oid:preserved+=1
 else:
  assert name in RUNTIME,f'Baseline artifact changed: {name}'
  changed.append(name)
paths=set(git('diff','--name-only',BASE).decode().splitlines()+git('ls-files','--others','--exclude-standard').decode().splitlines())
for name in paths:
 assert name in RUNTIME|NEW_TESTS or name==REPORT or name.startswith(('scripts/pr1d-remediation/','docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation/')),f'Out of scope: {name}'
source={}
for folder in ['src','tests','scripts/pr1d-remediation','scripts/pr1d-investigation']:
 for p in sorted((ROOT/folder).rglob('*')):
  if p.is_file() and '__pycache__' not in p.parts:source[str(p.relative_to(ROOT))]=hashlib.sha256(p.read_bytes()).hexdigest()
result={'baseline':BASE,'baselinePaths':len(entries),'preserved':preserved,'authorizedChangedRuntimePaths':changed,'canonicalGuardAndEncoderSourcePreserved':True,'historicalReportsTestsAndEvidence':'byte-identical','sourceSha256':source,'diffScope':sorted(paths)}
(OUT/'source-preservation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['sourceSha256','diffScope']}))
