"""Reconstruct the exact baseline code without switching/rebasing a checkout."""
import pathlib,subprocess,sys,tarfile,tempfile
repository=pathlib.Path(sys.argv[1]).resolve();target=pathlib.Path(sys.argv[2]).resolve();target.mkdir(exist_ok=False)
with tempfile.TemporaryFile() as archive:
 subprocess.run(['git','archive','a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0','src','tests','package.json'],cwd=repository,stdout=archive,check=True)
 archive.seek(0)
 with tarfile.open(fileobj=archive) as tar:tar.extractall(target,filter='data')
(target/'node_modules').symlink_to(repository/'node_modules',target_is_directory=True)
print(target)
