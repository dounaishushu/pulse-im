"""Loopback-only mall fixture for real WebKit session regression checks."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import sys
import threading


class Mall(BaseHTTPRequestHandler):
    counts = {"home": 0, "account": 0, "login": 0}
    lock = threading.Lock()

    def log_message(self, *_):
        pass

    def respond(self, status, body=b"", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/stats":
            with self.lock:
                body = json.dumps(self.counts).encode()
            self.respond(200, body)
            return
        cookies = SimpleCookie(self.headers.get("Cookie", ""))
        logged_in = cookies.get("mall_session") is not None
        if self.path == "/":
            with self.lock:
                self.counts["home"] += 1
            if logged_in:
                self.respond(302, headers=(("Location", "/account"),))
            else:
                self.respond(200, b'<body id="login"><form method="post" action="/login"><button id="sign-in">Login</button></form></body>')
        elif self.path == "/account":
            with self.lock:
                self.counts["account"] += 1
            if not logged_in:
                self.respond(302, headers=(("Location", "/"),))
            else:
                self.respond(200, b'<body id="account"><input id="draft"><p>Signed in</p></body>')
        else:
            self.respond(404)

    def do_POST(self):
        self.rfile.read(min(1024, int(self.headers.get("Content-Length", "0"))))
        if self.path != "/login":
            self.respond(404)
            return
        with self.lock:
            self.counts["login"] += 1
        self.respond(303, headers=(("Location", "/account"), ("Set-Cookie", "mall_session=fixture; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax")))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), Mall)
    Path(sys.argv[1]).write_text(str(server.server_port), encoding="utf-8")
    try:
        server.serve_forever()
    finally:
        server.server_close()
