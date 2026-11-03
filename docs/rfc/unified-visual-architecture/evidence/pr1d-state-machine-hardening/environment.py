import json,os,platform,subprocess
commands=[['uname','-a'],['id'],['findmnt','-T','/workspace/Estampes'],['findmnt','-T','/tmp'],['/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node','--version'],['npm','--version'],['python3','--version'],['/usr/bin/flock','--version'],['/usr/bin/chromium','--version'],['python3','-c','import sympy,mpmath; print(sympy.__version__,mpmath.__version__)'],['git','rev-parse','origin/main','origin/codex/pr1d-native-reacceptance-round3'],['git','diff','--name-only','b2f853c..31dae29','--','src','tests','scripts','server.js','package.json','package-lock.json']]
results=[]
for argv in commands:
 r=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);results.append({'argv':argv,'exitCode':r.returncode,'output':r.stdout})
for sha in ['b2f853c5','94f3b59f','a33fe411','322038b4','c090d93','05913e9','88d8928','58f7789','26a51e6']:
 r=subprocess.run(['git','merge-base','--is-ancestor',sha,'31dae29']);results.append({'ancestor':sha,'exitCode':r.returncode})
print(json.dumps({'results':results,'memoryLimitBytes':open('/sys/fs/cgroup/memory.max').read().strip(),'nodeProfile':'linux-process-crash-test; native ext4/XFS not available','clientTimezone':'Asia/Taipei'},indent=2))
