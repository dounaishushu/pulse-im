"""Xcode Release gate. It validates real supplied configuration, never generates credentials."""
import os
import re
from urllib.parse import urlparse

def endpoint(value, scheme):
    url = urlparse(value)
    host = (url.hostname or "").lower()
    reserved = ("localhost", "local", "lan", "internal", "test", "invalid", "example", "example.com", "example.org", "example.net")
    return (url.scheme == scheme and not url.username and not url.fragment and "." in host and ":" not in host
            and not any(host == suffix or host.endswith("." + suffix) for suffix in reserved)
            and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split("."))
            and not all(c in "0123456789." for c in host))

def verify(environ):
    if environ.get("CONFIGURATION") != "Release":
        return
    errors = []
    for name, scheme in (("PULSE_API_URL", "https"), ("PULSE_WS_URL", "wss")):
        if not endpoint(environ.get(name, ""), scheme):
            errors.append(f"{name} must use your production {scheme.upper()} domain")
    api, ws = urlparse(environ.get("PULSE_API_URL", "")), urlparse(environ.get("PULSE_WS_URL", ""))
    if not api.path.endswith("/api/v2") or api.query or api.password:
        errors.append("PULSE_API_URL must end in /api/v2 without query or credentials")
    if ws.netloc != api.netloc or ws.path != api.path + "/realtime" or ws.query or ws.password:
        errors.append("PULSE_WS_URL must use the API origin and /api/v2/realtime path")
    if not environ.get("DEVELOPMENT_TEAM", "").strip():
        errors.append("select a real Apple Developer team")
    if errors:
        raise SystemExit("error: Release blocked: " + "; ".join(errors))

if __name__ == "__main__":
    verify(os.environ)
