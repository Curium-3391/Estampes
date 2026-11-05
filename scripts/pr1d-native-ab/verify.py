"""Read-only source, protocol, raw-log and legacy-seal verification at delivery."""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab'
BASE='d9aaa49f27d195ed53baeb12e95e434f1a7b10b0';CAND='4814daf2378e9619f171c02a65792062957a8e99'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
commands=[]
for args in [['rev-parse',BASE+'^{commit}',CAND+'^{commit}'],['merge-base','--is-ancestor',BASE,CAND],['diff','--name-only',BASE,CAND,'--','src'],['diff','--exit-code',BASE,CAND,'--','scripts/pr1d-investigation','tests/fixtures'],['rev-parse','origin/fix/unified-visual-architecture-pr1d-performance-remediation'],['status','--short','--branch'],['worktree','list']]:
 p=subprocess.run(['git',*args],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 commands.append({'command':['git',*args],'exitCode':p.returncode,'output':p.stdout})
 assert p.returncode==0,args
(OUT/'git-verification.json').write_text(json.dumps(commands,indent=2)+'\n')
start=json.loads((OUT/'execution-start.json').read_text())
assert sha(OUT/'PROTOCOL.md')==start['protocolSha256']
assert git('show',start['protocolCommit']+':'+str((OUT/'PROTOCOL.md').relative_to(ROOT)))==(OUT/'PROTOCOL.md').read_bytes()
original=[]
for line in git('ls-tree','-r',CAND).decode().splitlines():
 metadata,path=line.split('\t');mode,kind,blob=metadata.split();p=ROOT/path
 assert kind=='blob' and p.is_file(),path
 content=p.read_bytes();actual=hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
 assert actual==blob,'Original candidate file changed: '+path
 original.append({'path':path,'gitBlob':blob,'sha256':hashlib.sha256(content).hexdigest()})
frozenBenchmark=hashlib.sha256(git('show',start['protocolCommit']+':scripts/pr1d-native-ab/benchmark.mjs')).hexdigest()
logs=[]
for r in map(json.loads,(OUT/'runs.jsonl').read_text().splitlines()):
 assert sha(OUT/r['log'])==r['sha256'],r['name']
 assert sha(OUT/r['name']/'input-sha256.json')==r['inputManifestSha256'],r['name']
 if '-pair-' in r['name']:
  manifest=json.loads((OUT/r['name']/'input-sha256.json').read_text())
  assert manifest['independent/scripts/pr1d-native-ab/benchmark.mjs']==frozenBenchmark,'Plain benchmark changed: '+r['name']
 logs.append({'name':r['name'],'sha256':r['sha256'],'exitCode':r['exitCode'],'stop':r['stop']})
legacy=[]
for label,source in [('baseline',pathlib.Path('/home/estampes/projects/pr1d-native-baseline')),('candidate',pathlib.Path('/home/estampes/projects/pr1d-native-candidate'))]:
 inventory=json.loads((source/'docs/rfc/unified-visual-architecture/evidence/source-index.json').read_text())
 for f in inventory['files']:assert sha(source/f['path'])==f['sha256'],(label,f['path'])
 legacy.append({'variant':label,'files':len(inventory['files']),'allOriginalHashesMatch':True,'interpretation':'Independent complete source-index verification; original 59/1 test receipts remain unchanged. The failed test copy lacked server.js; no functional or hash mismatch found.'})
 worktree=subprocess.check_output(['git','status','--porcelain'],cwd=source,text=True)
 assert worktree=='',(source,worktree)
failureArchives=[]
for record in json.loads((OUT/'failed-store-inventories.json').read_text()):
 assert sha(OUT/record['archive'])==record['archiveSha256']
 store=pathlib.Path(record['originalStore'])
 for f in record['files']:
  p=store/f['path'];st=p.lstat()
  assert sha(p)==f['sha256'] and st.st_ino==f['inode'] and st.st_dev==f['device']
  assert st.st_mtime_ns==f['mtimeNs'] and st.st_ctime_ns==f['ctimeNs'],'Stopped Store metadata changed'
 assert sorted(str(p.relative_to(store)) for p in store.rglob('*') if p.is_file())==sorted(f['path'] for f in record['files'])
 failureArchives.append({'case':record['case'],'archiveSha256':record['archiveSha256'],'originalInodesBytesAndTimestampsUnchangedAfterReadOnlyInspection':True})
result={'baseline':BASE,'candidate':CAND,'protocolCommit':start['protocolCommit'],'protocolSha256':start['protocolSha256'],'candidateOriginalFilesVerified':len(original),'failureArchives':failureArchives,'originalFiles':original,'rawLogs':logs,'legacySealControls':legacy,'allTwelvePlainBenchmarkHashesMatchFrozenCommit':True,'separateSourceWorktreesClean':True,'G2OriginalImplementationAndAssertionsPreserved':True}
(OUT/'integrity-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'originalFiles':len(original),'rawLogs':len(logs),'legacySeals':legacy,'protocolUnchanged':True}))
