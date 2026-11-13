"""Linux process sampler; reads only explicitly supplied process IDs."""
import argparse,json,time,os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pids',type=int,nargs='+',required=True);p.add_argument('--seconds',type=int,default=60);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
if not 1<=args.seconds<=3600:raise SystemExit('invalid duration')
args.output.mkdir(parents=True,exist_ok=False);started=time.monotonic();samples=[]
with (args.output/'samples.jsonl').open('w') as f:
 while time.monotonic()-started<args.seconds:
  row={'at':time.time(),'processes':[]}
  for pid in args.pids:
   try:
    raw=Path(f'/proc/{pid}/status').read_text();values={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in raw.splitlines() if ':' in line}
    stats=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split();row['processes'].append({'pid':pid,'rss_bytes':int(values.get('VmRSS','0 kB').split()[0])*1024,'threads':int(values.get('Threads','0')),'cpu_seconds':(int(stats[11])+int(stats[12]))/os.sysconf('SC_CLK_TCK')})
   except FileNotFoundError:row['processes'].append({'pid':pid,'exited':True})
  f.write(json.dumps(row)+'\n');f.flush();samples.append(row);time.sleep(2)
(args.output/'summary.json').write_text(json.dumps({'samples':len(samples),'max_aggregate_rss_bytes':max((sum(p.get('rss_bytes',0) for p in s['processes']) for s in samples),default=0),'capacity_acceptance':False},indent=2))
