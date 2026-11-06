from pathlib import Path
import subprocess
from run import HERE,NODE,REPO
for path in HERE.glob('*.py'):compile(path.read_text(),str(path),'exec')
paths=list(HERE.glob('*.mjs'))+[REPO/'tests/pr1d-evidence-preservation.test.js',REPO/'tests/fixtures/uva-lifecycle.mjs']
for path in paths:subprocess.run([NODE,'--check',str(path)],check=True)
print('Syntax checks passed:',len(paths),'JavaScript modules and all investigation Python scripts')
