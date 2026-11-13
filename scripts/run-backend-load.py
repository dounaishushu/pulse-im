"""Run an isolated Windows capacity probe with four logical CPUs and an 7.5 GiB combined process-family limits.
Uses only the explicitly named disposable PostgreSQL/Redis PIDs; never stops them.
"""
import argparse,ctypes,json,os,subprocess,time
from ctypes import wintypes as w
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--server',type=Path,required=True);p.add_argument('--loadcheck',type=Path,required=True);p.add_argument('--postgres-pid',type=int,required=True);p.add_argument('--redis-pid',type=int,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--connections',type=int,default=10000);p.add_argument('--seconds',type=int,default=60);p.add_argument('--images',type=int,default=300);p.add_argument('--rate',type=int,default=100);args=p.parse_args()
if os.name!='nt':raise SystemExit('Windows job runner only')
if args.output.exists():raise SystemExit('Preserve old evidence; use a fresh output directory')
args.output.mkdir(parents=True)
base=Path(__file__).resolve().parents[1];env=os.environ.copy()
if env.get('PULSE_CORE_TEST_DSN')!='postgres://pulse_test@127.0.0.1:15440/pulse_core_test?sslmode=disable' or env.get('PULSE_CORE_TEST_REDIS_URL')!='redis://127.0.0.1:16382/0':raise SystemExit('Explicit isolated test endpoints required')
env.update(PULSE_POSTGRES_DSN=env['PULSE_CORE_TEST_DSN'],PULSE_REDIS_URL=env['PULSE_CORE_TEST_REDIS_URL'],PULSE_LISTEN='127.0.0.1:18082',PULSE_TRUSTED_PROXY_CIDRS='127.0.0.1/32',PULSE_ALLOWED_ORIGINS='',PULSE_MEDIA_DIR=str(args.output/'media'),PULSE_RUNTIME_DIR=str(args.output/'runtime'),PULSE_FFPROBE=str(base/'.local/media-tools/ffprobe.exe'),GOMAXPROCS='4',GOMEMLIMIT='1200MiB')
for name in ['PULSE_TELEGRAM_TOKEN','PULSE_TELEGRAM_WEBHOOK_SECRET','PULSE_APNS_KEY_PATH','PULSE_FCM_ACCOUNT_PATH','PULSE_IP_LOCATION_URL']:env.pop(name,None)
class IOCOUNTERS(ctypes.Structure):_fields_=[(n,ctypes.c_ulonglong)for n in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
class BASIC(ctypes.Structure):_fields_=[('PerProcessUserTimeLimit',ctypes.c_longlong),('PerJobUserTimeLimit',ctypes.c_longlong),('LimitFlags',w.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',w.DWORD),('Affinity',ctypes.c_size_t),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]
class EXTENDED(ctypes.Structure):_fields_=[('BasicLimitInformation',BASIC),('IoInfo',IOCOUNTERS),('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]
k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateJobObjectW.restype=w.HANDLE;k.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR];k.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD];k.QueryInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD,ctypes.c_void_p];k.OpenProcess.restype=w.HANDLE;k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE];k.CloseHandle.argtypes=[w.HANDLE];k.SetProcessAffinityMask.argtypes=[w.HANDLE,ctypes.c_size_t];k.GetProcessAffinityMask.argtypes=[w.HANDLE,ctypes.POINTER(ctypes.c_size_t),ctypes.POINTER(ctypes.c_size_t)]
def new_job(memory_limit):
 job=k.CreateJobObjectW(None,None);limits=EXTENDED();limits.BasicLimitInformation.LimitFlags=0x200;limits.JobMemoryLimit=memory_limit
 if not k.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)):raise ctypes.WinError(ctypes.get_last_error())
 return job
pg_job=new_job(4*1024**3);redis_job=new_job(512*1024**2);app_job=new_job(3*1024**3)
all_jobs=[pg_job,redis_job,app_job]
# Do not attach PIDs based on a stale number: verify live executable and known test path first.
ps=f"Get-CimInstance Win32_Process | Where-Object {{ $_.ProcessId -eq {args.postgres_pid} -or $_.ParentProcessId -eq {args.postgres_pid} -or $_.ProcessId -eq {args.redis_pid} }} | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
raw=subprocess.check_output(['powershell','-NoProfile','-Command',ps],creationflags=subprocess.CREATE_NO_WINDOW)
processes=json.loads(raw.decode('utf-8-sig'));processes=processes if isinstance(processes,list) else [processes]
parents={x['ProcessId']:x for x in processes}
pg=parents.get(args.postgres_pid,{});rd=parents.get(args.redis_pid,{})
if 'postgres' not in str(pg.get('ExecutablePath','')).lower() or 'desktop-web' not in str(pg.get('CommandLine','')) or 'postgres-test' not in str(pg.get('CommandLine','')):raise SystemExit('PostgreSQL PID is not the isolated fixture')
if 'redis' not in str(rd.get('ExecutablePath','')).lower() or 'redis-tests.conf' not in str(rd.get('CommandLine','')):raise SystemExit('Redis PID is not the isolated fixture')
old_affinities={}
def attach(pid,job):
 handle=k.OpenProcess(0x0001|0x0100|0x0200|0x0400,False,pid)
 if not handle:raise ctypes.WinError(ctypes.get_last_error())
 try:
  old,system=ctypes.c_size_t(),ctypes.c_size_t()
  if not k.GetProcessAffinityMask(handle,ctypes.byref(old),ctypes.byref(system)):raise ctypes.WinError(ctypes.get_last_error())
  old_affinities[pid]=old.value
  if not k.SetProcessAffinityMask(handle,15):raise ctypes.WinError(ctypes.get_last_error())
  if not k.AssignProcessToJobObject(job,handle):raise ctypes.WinError(ctypes.get_last_error())
 finally:k.CloseHandle(handle)
for row in processes:attach(row['ProcessId'],redis_job if row['ProcessId']==args.redis_pid else pg_job)
with (args.output/'server.log').open('wb') as log:
 migration=subprocess.run([str(args.server),'migrate'],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,timeout=60)
 if migration.returncode:raise SystemExit('test migration failed')
 server=subprocess.Popen([str(args.server),'serve'],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
 try:attach(server.pid,app_job)
 except Exception:
  server.terminate();server.wait(timeout=20);raise
 (args.output/'server.pid').write_text(str(server.pid))
 import urllib.request
 for i in range(60):
  try:
   if urllib.request.urlopen('http://127.0.0.1:18082/readyz',timeout=1).status==200:break
  except Exception:time.sleep(.25)
 else:raise SystemExit('test server not ready')
 started=time.time();samples=[]
 with (args.output/'load.log').open('wb') as loadlog,(args.output/'job-samples.jsonl').open('w') as joblog:
  load=subprocess.Popen([str(args.loadcheck),'--url','http://127.0.0.1:18082','--connections',str(args.connections),'--duration',f'{args.seconds}s','--messages-per-second',str(args.rate),'--images',str(args.images),'--output',str(args.output/'workload')],env=env,stdout=loadlog,stderr=loadlog,creationflags=subprocess.CREATE_NO_WINDOW)
  try:
   while load.poll() is None:
    values=[]
    for handle in all_jobs:
     sample=EXTENDED()
     if not k.QueryInformationJobObject(handle,9,ctypes.byref(sample),ctypes.sizeof(sample),None):raise ctypes.WinError(ctypes.get_last_error())
     values.append(sample)
    row={'at':time.time(),'sum_family_peak_commit_bytes':sum(s.PeakJobMemoryUsed for s in values),'peak_process_commit_bytes':max(s.PeakProcessMemoryUsed for s in values)};samples.append(row);joblog.write(json.dumps(row)+'\n');joblog.flush()

    if time.time()-started>1500:load.terminate();raise RuntimeError('load timeout')
    time.sleep(2)
  finally:
   if load.poll() is None:load.terminate();load.wait(timeout=20)
   server.terminate();server.wait(timeout=20)
  (args.output/'constraints.json').write_text(json.dumps({'logical_cpu_affinity_mask':15,'logical_cpus_allowed':4,'aggregate_memory_limit_bytes':int(7.5*1024**3),'family_memory_limits_bytes':{'app':3*1024**3,'postgres':4*1024**3,'redis':512*1024**2},'app_gomaxprocs':4,'app_gomemlimit':'1200MiB','server_pid':server.pid,'postgres_pid':args.postgres_pid,'redis_pid':args.redis_pid,'elapsed_seconds':time.time()-started,'workload_exit':load.returncode,'sum_family_peak_commit_bytes':max((s['sum_family_peak_commit_bytes'] for s in samples),default=0),'production_changed':False,'host_shared_with_other_workloads':True},indent=2))
for handle in all_jobs:
 limits=EXTENDED();k.SetInformationJobObject(handle,9,ctypes.byref(limits),ctypes.sizeof(limits))
for pid,mask in old_affinities.items():
 handle=k.OpenProcess(0x0200,False,pid)
 if handle:
  k.SetProcessAffinityMask(handle,mask);k.CloseHandle(handle)
for handle in all_jobs:k.CloseHandle(handle)
print('Capacity probe finished; evidence:',args.output)
raise SystemExit(load.returncode)
