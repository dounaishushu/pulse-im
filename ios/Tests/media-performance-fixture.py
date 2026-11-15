"""Loopback-only wire fixture for MediaPerformanceTests.swift; uses fake identities."""
import hashlib,json,subprocess,sys,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

CID='11111111-1111-4111-8111-111111111111';SAVED='22222222-2222-4222-8222-222222222222';USER='44444444-4444-4444-8444-444444444444'
MEDIA=['10000000-0000-4000-8000-%012d'%n for n in range(1,35)]
lock=threading.Lock();state={}
def reset(mode):state.clear();state.update(mode=mode,info=0,batch=0,single=0,patch=0,last_batch_ids=0,hidden=True,version=3)
reset('normal')
def conversation(cid):
 return {'id':cid,'kind':'saved' if cid==SAVED else 'direct','title':'Fixture saved','peer_name':'Fixture peer','membership_version':'1','visible_from_seq':'1','unread_count':0,'state':{'user_id':USER,'clear_seq':'0','reminder':False},'hidden':state['hidden'],'preference_version':str(state['version']),'pinned':True,'muted_notifications':True,'can_send':True}
def message(n,media):
 return {'id':'20000000-0000-4000-8000-%012d'%n,'conversation_id':CID,'sender_id':USER,'sender':{'name':'Fixture','avatar_id':MEDIA[0]},'seq':str(n),'version':'1','request_id':'fixture-'+str(n),'kind':'image','body':'','revoked':False,'created_at':'2026-11-15T08:00:00Z','updated_at':'2026-11-15T08:00:00Z','content':{'media':{'id':media,'kind':'image','mime':'image/png','bytes':'64','filename':'fixture.png','width':4,'height':4,'duration_ms':'0','original':False}}}
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def reply(self,code,value):
  data=json.dumps(value).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def error(self,code,name):self.reply(code,{'error':{'code':name}})
 def grant(self,media):
  if media==MEDIA[-1]:return {'id':media,'error':{'status':403,'code':'forbidden'}}
  digest=hashlib.sha256((self.headers.get('Authorization','')+media).encode()).hexdigest()
  return {'id':media,'access':{'content_path':'/api/v2/media-grants/'+digest+'/content','expires_in':120}}
 def do_GET(self):self.handle_request()
 def do_POST(self):self.handle_request()
 def do_PATCH(self):self.handle_request()
 def handle_request(self):
  path=urlsplit(self.path).path.removeprefix('/api/v2');length=int(self.headers.get('Content-Length','0'));body=json.loads(self.rfile.read(length)) if length else {}
  if path=='/test-mode':
   with lock:reset(body['mode'])
   return self.reply(200,{'ok':True})
  if path=='/test-stats':
   with lock:result=state.copy()
   return self.reply(200,result)
  if path=='/conversations/saved':return self.reply(200,{'id':SAVED})
  if path=='/conversations/'+CID+'/open':
   if state['mode']=='legacy':return self.error(404,'not_found')
   if state['mode']=='summary':return self.reply(200,{'status':'opened','conversation_id':CID})
   if state['mode']=='wrong-id':return self.reply(200,conversation(SAVED))
   state['hidden']=False;return self.reply(200,conversation(CID))
  if path=='/conversations/'+CID+'/preferences':
   with lock:
    state['patch']+=1
    assert set(body)=={'hidden','expected_version'} and body['hidden'] is False
    if state['patch']==1:state['version']+=1;return self.error(409,'conflict')
    assert str(body['expected_version'])==str(state['version']);state['hidden']=False
   return self.reply(200,{'status':'updated'})
  if path in ['/conversations/'+CID,'/conversations/'+SAVED]:
   with lock:state['info']+=1
   return self.reply(200,conversation(path.rsplit('/',1)[1]))
  if path=='/conversations/'+CID+'/history':
   return self.reply(200,{'items':[message(n,media) for n,media in enumerate(MEDIA,1)],'membership_version':'1','snapshot_max_seq':'34','next_after_seq':'34','clear_seq':'0','visible_from_seq':'1','has_more':False})
  if path=='/media/grants':
   with lock:state['batch']+=1;state['last_batch_ids']=len(body['media_ids']);mode=state['mode']
   if mode=='old-grants':return self.error(404,'not_found')
   time.sleep(0.2)
   if mode=='unauthorized':return self.reply(200,{'items':[{'id':media,'error':{'status':401,'code':'unauthorized'}} for media in body['media_ids']]})
   return self.reply(200,{'items':[self.grant(media) for media in body['media_ids']]})
  if path.startswith('/media/') and path.endswith('/grants'):
   with lock:state['single']+=1
   result=self.grant(path.split('/')[2])
   if 'error' in result:return self.error(result['error']['status'],result['error']['code'])
   return self.reply(200,result['access'])
  return self.error(404,'not_found')

if __name__=='__main__':
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
 worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
 try:result=subprocess.run([str(Path(sys.argv[1]).resolve()),'http://127.0.0.1:%d/api/v2'%server.server_address[1]],timeout=60)
 finally:server.shutdown();server.server_close()
 sys.exit(result.returncode)
