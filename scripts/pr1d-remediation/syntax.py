from pathlib import Path
import subprocess,ast
ROOT=Path(__file__).resolve().parents[2]
NODE='/workspace/.estampes-tools/node-v22.23.4-linux-x64/bin/node'
js=[*sorted((ROOT/'src').rglob('*.js')),*sorted((ROOT/'scripts/pr1d-remediation').glob('*.mjs')),ROOT/'tests/persistence-metadata-remediation.test.js',ROOT/'tests/document-canonical-remediation.test.js']
for p in js:subprocess.run([NODE,'--check',str(p)],check=True)
py=list((ROOT/'scripts/pr1d-remediation').glob('*.py'))
for p in py:ast.parse(p.read_text(),filename=str(p))
print(f'Syntax PASS: {len(js)} JS/MJS and {len(py)} Python inputs')
