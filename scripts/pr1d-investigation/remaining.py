# Continue serially after matrix.py history has returned.
import subprocess,sys
from run import run,NODE,HERE
subprocess.run([sys.executable,str(HERE/'matrix.py'),'documents'],check=True)
subprocess.run([sys.executable,str(HERE/'g2-run.py')],check=True)
subprocess.run([sys.executable,str(HERE/'checks.py')],check=True)
# Extra focused probes resolve stage attribution absent from initial matrix.
for mode,value in [('history','25'),('document','8')]:
 r=run(f'phase-{mode}-{value}',180,[NODE,str(HERE/'benchmark.mjs'),mode,value],True,{'PR1D_PHASES':'1'})
 if r['exitCode'] or r['stop']:raise SystemExit(1)

for enabled in [False,True]:
 r=run('instrumentation-parity-'+('profile' if enabled else 'plain'),90,[NODE,str(HERE/'parity-driver.mjs')],enabled)
 if r['exitCode'] or r['stop']:raise SystemExit(1)
