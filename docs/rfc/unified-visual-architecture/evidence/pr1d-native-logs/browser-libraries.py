from pathlib import Path
import subprocess
root=Path(__file__).parent;libs=root/"browser-libs";libs.mkdir(exist_ok=True)
subprocess.run(["apt-get","download","libnss3","libnspr4","libasound2t64"],cwd=libs,check=True)
for p in libs.glob("*.deb"):subprocess.run(["dpkg-deb","-x",str(p),str(libs/"extracted")],check=True)
