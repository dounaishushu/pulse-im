from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock
import argparse,json,time,uuid,zlib,struct,subprocess,threading

lock=Lock();stats={'grant_batches':0,'single_grants':0,'progress_writes':0,'green_downloads':0,'slow_started':0}
version=1;answers={}
def uid(n):return str(uuid.UUID(int=n))
questions=[{'id':uid(100+n),'code':'question-'+str(n),'media_id':uid(1000+n)} for n in range(24)]
def record():
    return {'id':'22222222-2222-4222-8222-222222222222','task_id':'33333333-3333-4333-8333-333333333333','user_id':'11111111-1111-4111-8111-111111111111',
       'version':str(version),'questions':questions,'answers':dict(answers),'results':{},'status':'in_progress','started_at':'2026-11-20T00:00:00Z','task_date':'2026-11-20',
       'employee_type':'intern','duration_seconds':0,'total':len(questions),'correct_count':0,'unit_price':'1.000','wage':'0.000','avatar_id':''}
def png(rgb):
    def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',zlib.crc32(name+data)&0xffffffff)
    width,height=1600,2400
    data=zlib.compress((b'\0'+bytes(rgb)*width)*height,6)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',data)+chunk(b'IEND',b'')
green,blue,red=png((0,255,0)),png((0,0,255)),png((255,0,0))
class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    def reply(self,data,code=200,kind='application/json'):
        data=json.dumps(data).encode() if kind=='application/json' else data
        self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_GET(self):
        path=self.path.split('?')[0]
        if path=='/stats':
            with lock:self.reply(dict(stats,saved_answers=len(answers)))
        elif path.startswith('/api/v2/task-records/'):
            with lock:self.reply(record())
        elif path.startswith('/fixture/') or path.startswith('/api/v2/media-grants/'):
            color=blue
            if 'cache-green' in path:
                with lock:stats['green_downloads']+=1
                color=green
            if 'slow-red' in path:
                with lock:stats['slow_started']+=1
                time.sleep(2);color=red
            self.reply(color,kind='image/png')
        elif path=='/api/v2/client/config':self.reply({'protocol':'pulse-v2','routes':[],'explore_links':[]})
        else:self.reply({'error':{'code':'not_found'}},404)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path=='/api/v2/media/grants':
            with lock:stats['grant_batches']+=1
            rows=[]
            for mid in body['media_ids']:
                token=uuid.UUID(mid).hex*2
                rows.append({'id':mid,'access':{'content_path':'/api/v2/media-grants/'+token+'/content','expires_in':120}})
            self.reply({'items':rows})
        elif self.path.endswith('/grants'):
            with lock:stats['single_grants']+=1
            self.reply({'content_path':'/api/v2/media-grants/'+'a'*64+'/content','expires_in':120})
        else:self.reply({'error':{'code':'not_found'}},404)
    def do_PUT(self):
        global version
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path.endswith('/answers'):
            with lock:stats['progress_writes']+=1
            time.sleep(1.2)
            with lock:
                if body['expected_version']!=str(version):self.reply({'error':{'code':'request_conflict'}},409);return
                answers.update(body['answers']);version+=1;self.reply(record())
        else:self.reply({'error':{'code':'not_found'}},404)
if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Synthetic mobile task fixture; binds loopback only.')
    parser.add_argument('port',nargs='?',type=int,default=18230)
    parser.add_argument('--probe',help='Run a compiled iOS adapter probe on a fresh ephemeral port.')
    args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',0 if args.probe else args.port),Handler)
    port=server.server_address[1]
    print('Work task fixture listening on 127.0.0.1:'+str(port),flush=True)
    try:
        if args.probe:
            threading.Thread(target=server.serve_forever,daemon=True).start()
            try: code=subprocess.run([args.probe,'http://127.0.0.1:'+str(port)+'/api/v2']).returncode
            finally: server.shutdown()
            raise SystemExit(code)
        server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
