"""Disposable HTTP fixture for the actual Swift adapter; never contacts a server."""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

CID = '10000000-0000-4000-8000-000000000001'
OTHER = '10000000-0000-4000-8000-000000000002'
USER = '30000000-0000-4000-8000-000000000001'
state = {'mode': 'empty', 'sync': 0, 'personal': 0, 'info': 0, 'history': 0}


def message(seq, version=1, revoked=False, wrong=False):
    return dict(id='20000000-0000-4000-8000-%012d' % seq,
                conversation_id=OTHER if wrong else CID, sender_id=USER,
                sender={'name': 'Fixture'}, seq=str(seq), event_seq=str(seq), version=str(version),
                request_id='fixture-%d' % seq, kind='text', body='Fixture %d' % seq,
                revoked=revoked, created_at='2026-11-18T00:00:00Z',
                updated_at='2026-11-18T00:00:00Z', content={})


def info():
    mode = state['mode']
    maximum = 1200 if mode in ['paged', 'changed-upper'] else 5001 if mode == 'long-gap' else 1004 if mode == 'append' else 1003 if mode in ['edited', 'revoked', 'wrong-chat', 'bad-sequence', 'cutoff-race'] else 1000
    personal = 8 if mode in ['deleted', 'cleared', 'reminder'] else 7
    clear = 1003 if mode == 'cutoff-race' else 990 if mode == 'cleared' else 0
    return dict(id=CID, kind='direct', title='Fixture', peer_name='Fixture',
                membership_version='2' if mode == 'late-membership' else '1',
                event_seq=str(maximum), visible_from_seq='1', unread_count=0,
                state={'personal_seq': str(personal), 'clear_seq': str(clear), 'reminder': False}, can_send=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, value, code=200):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path.removeprefix('/api/v2')
        q = parse_qs(parts.query)
        if path == '/test-mode':
            state.update(mode=q['mode'][0], sync=0, personal=0, info=0, history=0)
            return self.reply({'ok': 1})
        if path == '/test-stats':
            return self.reply({k: v for k, v in state.items() if k != 'mode'})
        mode = state['mode']
        if path == '/conversations/' + CID:
            state['info'] += 1
            return self.reply(info())
        if path.endswith('/history'):
            state['history'] += 1
            return self.reply({'error': {'code': 'unexpected_history'}}, 500)
        if path == '/conversations/' + CID + '/sync':
            state['sync'] += 1
            if mode == 'denied':
                return self.reply({'error': {'code': 'forbidden'}}, 403)
            after = int(q['after'][0])
            maximum = 1200 if mode in ['paged', 'changed-upper'] else 5000 if mode == 'long-gap' else 1003 if mode in ['append', 'edited', 'revoked', 'wrong-chat', 'bad-sequence', 'cutoff-race'] else 1001 if mode == 'non-progress' else 1000
            next_seq = min(after + 100, maximum)
            events = []
            if mode in ['append', 'paged', 'changed-upper', 'edited', 'revoked', 'wrong-chat', 'bad-sequence', 'cutoff-race']:
                for seq in range(after + 1, next_seq + 1):
                    events.append({'seq': str(seq), 'kind': 'message.updated' if mode == 'edited' else 'message.created',
                                   'message': message(seq, 2 if mode == 'edited' else 1, mode == 'revoked', mode == 'wrong-chat')})
            if mode == 'bad-sequence':
                events[0]['seq'] = str(next_seq + 1)
            if mode == 'changed-upper' and after > 1000:
                maximum = 1300
            if mode == 'non-progress':
                next_seq = after
            if after > 1000 and mode == 'paged':
                assert q['snapshot_max_seq'] == ['1200']
            return self.reply(dict(events=events, membership_version='2' if mode == 'membership' else '1',
                                   snapshot_max_seq=str(maximum), next_after_seq=str(next_seq), has_more=next_seq < maximum))
        if path == '/conversations/' + CID + '/personal-sync':
            state['personal'] += 1
            maximum = 8 if mode in ['deleted', 'cleared', 'reminder', 'bad-personal'] else 7
            kinds = {'deleted': 'message.deleted', 'cleared': 'history.cleared', 'reminder': 'reminder.changed'}
            events = [{'seq': '8', 'kind': kinds[mode], 'boundary_seq': '990'}] if mode in kinds else []
            next_seq = 7 if mode == 'bad-personal' else maximum
            return self.reply(dict(events=events, snapshot_max_seq=str(maximum), next_after_seq=str(next_seq), has_more=next_seq < maximum))
        return self.reply({'error': {'code': 'not_found'}}, 404)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d/api/v2' % server.server_address[1]
    try:
        if sys.argv[1] == '--self-test':
            for mode in ['empty', 'append', 'paged', 'edited', 'revoked', 'deleted', 'cleared', 'reminder', 'long-gap', 'cutoff-race']:
                json.load(urlopen(base + '/test-mode?mode=' + mode))
                page = json.load(urlopen(base + '/conversations/' + CID + '/sync?after=1000&limit=100&membership_version=1'))
                assert page['snapshot_max_seq'] and 'events' in page
                assert json.load(urlopen(base + '/conversations/' + CID))['id'] == CID
            print('Fixture self-test passed; Swift adapter has not been executed by this check.')
            return 0
        return subprocess.run([str(Path(sys.argv[1]).resolve()), base], timeout=120).returncode
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    sys.exit(main())
