"""Synthetic @ and reply histories; each viewer receives only their own notes."""
import argparse
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

def uid(n):
    return str(n).zfill(8) + '-eeee-4eee-8eee-eeeeeeeeeeee'

GROUP = uid(9000)
NAMES = {1: '发送者昵称', 2: '被提及者昵称', 3: '旁观者昵称'}
NOTES = {1: {2: '发送方私有备注'}, 2: {1: '接收方给作者的备注'}, 3: {1: '旁观者给作者的备注', 2: '旁观者自己的备注'}}

def message(n, sender, body, **extra):
    return dict(id=uid(20000+n), conversation_id=GROUP, seq=str(n), event_seq=str(n), sender_id=uid(sender),
                sender={'name': NAMES[sender]}, kind='text', body=body, content={}, request_id='fixture-'+str(n),
                version='1', created_at='2026-11-24T04:00:00Z', updated_at='2026-11-24T04:00:00Z', **extra)

PARENT = message(1, 1, '@发送方私有备注 你好')
PARENT['content'] = {'mentions': [uid(2)], 'mention_users': [{'user_id': uid(2), 'nickname': NAMES[2], 'labels': ['发送方私有备注']}]}
REPLY = message(2, 3, '引用这条消息', reply_to_id=PARENT['id'])

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args):
        pass

    def reply(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def viewer(self):
        token = self.headers.get('Authorization', '').removeprefix('Bearer ')
        if token not in {'mention-viewer-1', 'mention-viewer-2', 'mention-viewer-3'}:
            self.reply({'error': {'code': 'unauthorized'}}, 401)
            return None
        return int(token[-1])

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            self.reply({'isolated': True})
            return
        viewer = self.viewer()
        if viewer is None:
            return
        profile = lambda n: {'id': uid(n), 'account': 'viewer'+str(n), 'nickname': NAMES[n], 'avatar_id': '', 'version': '1', 'remark': NOTES[viewer].get(n, '')}
        conversation = {'id': GROUP, 'kind': 'group', 'title': '备注视角测试', 'message_seq': '2', 'event_seq': '2', 'membership_version': '1',
                        'visible_from_seq': '1', 'my_role': 'member', 'can_send': True, 'member_count': 3, 'last_message': PARENT,
                        'state': {'user_id': uid(viewer), 'clear_seq': '0', 'read_seq': '0', 'delivered_seq': '0', 'personal_seq': '0', 'version': '1'}}
        if path == '/api/v2/me/profile':
            self.reply(profile(viewer))
        elif path == '/api/v2/client/friend-page':
            people = [profile(n) for n in NOTES[viewer]]
            self.reply({'items': people, 'page': 1, 'size': 100, 'total': len(people)})
        elif path in {'/api/v2/client/contact-names', '/api/v2/contacts/names'}:
            people = [dict(user_id=uid(n), nickname=NAMES[n], remark=note) for n, note in NOTES[viewer].items()]
            self.reply({'items': people, 'page': 1, 'size': 100, 'total': len(people)})
        elif path in {'/api/v2/client/conversation-page', '/api/v2/conversations'}:
            self.reply({'items': [conversation], 'page': 1, 'size': 100, 'total': 1})
        elif path == '/api/v2/conversations/'+GROUP:
            self.reply(conversation)
        elif path == '/api/v2/conversations/'+GROUP+'/history':
            self.reply({'items': [REPLY, PARENT], 'has_more': False, 'membership_version': '1', 'snapshot_max_seq': '2',
                        'next_after_seq': '2', 'visible_from_seq': '1', 'clear_seq': '0'})
        else:
            self.reply({'error': {'code': 'not_found'}}, 404)

    def do_POST(self):
        if self.viewer() is None:
            return
        path = urlparse(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
        if path == '/api/v2/conversations/'+GROUP+'/reply-contexts':
            self.reply({'items': [{'message_id': REPLY['id'], 'reply_seq': '1', 'message': PARENT} for value in body.get('message_ids', []) if value == REPLY['id']]})
        else:
            self.reply({'error': {'code': 'not_found'}}, 404)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18473)
    parser.add_argument('--probe', help='Run a compiled iOS probe against a fresh loopback port')
    args = parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1', 0 if args.probe else args.port), Handler) as server:
        print('Synthetic mention fixture listening on loopback:'+str(server.server_port), flush=True)
        if args.probe:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                raise SystemExit(subprocess.run([args.probe, 'http://127.0.0.1:'+str(server.server_port)+'/api/v2']).returncode)
            finally:
                server.shutdown()
        else:
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
