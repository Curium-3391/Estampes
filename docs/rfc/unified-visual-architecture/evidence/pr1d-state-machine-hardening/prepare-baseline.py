"""Reconstruct the exact baseline code without switching/rebasing a checkout."""
import pathlib,subprocess,sys,tarfile,tempfile
repository=pathlib.Path(sys.argv[1]).resolve();target=pathlib.Path(sys.argv[2]).resolve();target.mkdir(exist_ok=False)
with tempfile.TemporaryFile() as archive:
 subprocess.run(['git','archive','31dae29f1cf7d1e8caf6c670124eed7c7ed91e11','src','tests','package.json'],cwd=repository,stdout=archive,check=True)
 archive.seek(0)
 with tarfile.open(fileobj=archive) as tar:tar.extractall(target,filter='data')
(target/'node_modules').symlink_to(repository/'node_modules',target_is_directory=True)
print(target)
