"""After execution: lossless stopped failure Store evidence, no recovery or GC."""
import hashlib,json,os,pathlib,stat,tarfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
assert os.getuid()==1001
captured=[]
for r in map(json.loads,(OUT/'runs.jsonl').read_text().splitlines()):
 if '-pair-' not in r['name'] or not (r['exitCode'] or r['stop']):continue
 scratch=pathlib.Path(r['scratch']);assert scratch.parent==pathlib.Path('/home/estampes')
 assert scratch.stat().st_uid==os.getuid() and stat.S_IMODE(scratch.stat().st_mode)==0o700
 stores=list(scratch.glob('estampes-pr1c-*'))
 for store in stores:
  assert store.resolve()==store and store.is_dir() and stat.S_IMODE(store.stat().st_mode)==0o700
  device=store.stat().st_dev;files=[];directories=[];total=0
  for p in sorted(store.rglob('*')):
   st=p.lstat();assert st.st_dev==device and st.st_uid==os.getuid() and not p.is_symlink()
   if p.is_dir():
    directories.append({'path':str(p.relative_to(store)),'device':st.st_dev,'inode':st.st_ino,'mode':oct(stat.S_IMODE(st.st_mode)),'mtimeNs':st.st_mtime_ns,'ctimeNs':st.st_ctime_ns});continue
   assert stat.S_ISREG(st.st_mode) and st.st_nlink==1
   total+=st.st_size;assert total<=512*1024**2
   data=p.read_bytes();after=p.lstat();assert (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
   files.append({'path':str(p.relative_to(store)),'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size,'allocatedBytes':st.st_blocks*512,'mode':oct(stat.S_IMODE(st.st_mode)),'mtimeNs':st.st_mtime_ns,'ctimeNs':st.st_ctime_ns,'sha256':hashlib.sha256(data).hexdigest()})
  bundle=OUT/(r['name']+'-failed-store.tar.gz')
  with tarfile.open(bundle,'x:gz') as archive:
   archive.add(store,arcname=store.name,recursive=True)
  with tarfile.open(bundle,'r:gz') as archive:
   for f in files:assert hashlib.sha256(archive.extractfile(store.name+'/'+f['path']).read()).hexdigest()==f['sha256']
  captured.append({'case':r['name'],'originalStore':str(store),'files':files,'directories':directories,'logicalBytes':total,'archive':bundle.name,'archiveSha256':hashlib.sha256(bundle.read_bytes()).hexdigest(),'policy':'Original stopped Store retained, only read-only stat/read/archive. No coordinator open, recovery or GC. Copied bytes carry no physical deletion/continuation authority.'})
(OUT/'failed-store-inventories.json').write_text(json.dumps(captured,indent=2)+'\n')
print(json.dumps({'captured':len(captured),'cases':[r['case'] for r in captured]}))
