"""Synthetic task-code failures for Android's real HTTP adapter, loopback only."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER = '11111111-1111-4111-8111-111111111111'
TASK = '33333333-3333-4333-8333-333333333333'

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/v2/me/profile':
            self.reply({'id': USER, 'account': 'fixture', 'nickname': '实习员工', 'version': '1'})
        elif self.path == '/api/v2/client/config':
            self.reply({'protocol': 'pulse-v2', 'routes': []})
        elif self.path == '/health':
            self.reply({'isolated': True})
        else:
            self.reply({'error': {'code': 'not_found'}}, 404)

    def do_POST(self):
        if self.path != '/api/v2/tasks/' + TASK + '/start':
            self.reply({'error': {'code': 'not_found'}}, 404)
            return
        if self.headers.get('Authorization') != 'Bearer isolated-task-verification':
            self.reply({'error': {'code': 'unauthorized'}}, 401)
            return
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        faults = {'000000': (403, 'task_code_invalid'), '000001': (409, 'task_not_open'),
                  '000002': (403, 'forbidden'), '000003': (401, 'unauthorized'),
                  '000004': (403, 'unknown_permission'), '000005': (429, 'rate_limited')}
        if data.get('code') in faults:
            status, code = faults[data['code']]
            self.reply({'error': {'code': code}}, status)
        elif data.get('code') == '123456':
            self.reply({'id': '22222222-2222-4222-8222-222222222222', 'task_id': TASK, 'user_id': USER,
                        'version': '1', 'questions': [], 'answers': {}, 'results': {}, 'status': 'in_progress',
                        'started_at': '2026-11-24T00:00:00Z', 'task_date': '2026-11-24',
                        'employee_type': 'intern', 'total': 0, 'correct_count': 0, 'unit_price': '0.402', 'wage': '0.000'})
        else:
            self.reply({'error': {'code': 'task_code_invalid'}}, 403)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18472)
    args = parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
        print('Synthetic task fixture listening on loopback:' + str(server.server_port), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
