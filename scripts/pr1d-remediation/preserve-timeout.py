"""Read-only byte capture of the single stopped, owned 32 MiB timeout Store.
Archive copies do not inherit the original inode's GC/deletion authority.
"""
from pathlib import Path
import hashlib,json,os,stat,tarfile
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-performance-remediation'
runs=[json.loads(l) for l in (OUT/'runs.jsonl').read_text().splitlines()]
receipt=next(r for r in runs if r['name']=='b-document-32-profile')
rows=[json.loads(l) for l in (OUT/'b-document-32-profile/raw.log').read_text().splitlines() if l.startswith('{"event"')]
root=Path(next(r['root'] for r in rows if r['event']=='store'));scratch=Path(receipt['scratch'])
assert root.parent==scratch and root.name.startswith('estampes-pr1c-')
def directory(p):
 s=p.lstat();assert stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid==os.getuid() and s.st_mode&0o777==0o700
 assert p.resolve()==p
 return s
parent=directory(scratch);base=directory(root);assert parent.st_dev==base.st_dev
paths=sorted(root.rglob('*'));inventory=[];total=0
fingerprint=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
archive=OUT/'timeout-store.tar.gz'
with tarfile.open(archive,'x:gz') as target:
 for p in paths:
  s=p.lstat();assert s.st_dev==base.st_dev and s.st_uid==os.getuid() and not stat.S_ISLNK(s.st_mode)
  if stat.S_ISDIR(s.st_mode):directory(p)
  else:
   assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_mode&0o022==0 and s.st_size<=64*1024**2
   total+=s.st_size;assert total<=512*1024**2
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
   with os.fdopen(fd,'rb') as f:
    assert fingerprint(os.fstat(f.fileno()))==fingerprint(s)
    digest=hashlib.file_digest(f,'sha256').hexdigest()
    assert fingerprint(os.fstat(f.fileno()))==fingerprint(s)
   inventory.append({'path':str(p.relative_to(root)),'dev':str(s.st_dev),'ino':str(s.st_ino),'bytes':s.st_size,'mode':oct(stat.S_IMODE(s.st_mode)),'mtimeNs':str(s.st_mtime_ns),'ctimeNs':str(s.st_ctime_ns),'sha256':digest})
  target.add(p,arcname=str(p.relative_to(root)),recursive=False)
  assert fingerprint(p.lstat())==fingerprint(s)
assert sorted(root.rglob('*'))==paths
expected={r['path']:r for r in inventory}
with tarfile.open(archive,'r:gz') as captured:
 for member in captured:
  if member.isfile():
   with captured.extractfile(member) as f:assert hashlib.file_digest(f,'sha256').hexdigest()==expected[member.name]['sha256']
with archive.open('rb') as f:archiveHash=hashlib.file_digest(f,'sha256').hexdigest()
result={'case':'b-document-32-profile','sourceRoot':str(root),'files':inventory,'logicalBytes':total,'archive':archive.name,'archiveSha256':archiveHash,'archiveBytes':archive.stat().st_size,'authority':'Evidence bytes only; copied inodes cannot authorize GC or writable restore continuation','sourceMutation':'NONE: only lstat/read; no recovery, GC or coordinator open'}
(OUT/'timeout-store-inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='files'}))
