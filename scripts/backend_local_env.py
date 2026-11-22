"""Control the isolated Windows backend test runtimes configured on this PC."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
BASE = Path.home() / ".codex/test-runtimes/pulse-im"
CONFIG = BASE / "config.json"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


@contextmanager
def exclusive():
    import msvcrt
    with (BASE / "test-run.lock").open("a+b") as handle:
        if not handle.tell():
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError("Another local test or service-control command is already running") from error
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def config():
    value = json.loads(CONFIG.read_text(encoding="utf-8"))
    if value["database"] != "pulse_core_test" or value["postgres_port"] != 15432 or value["redis_port"] != 16379:
        raise RuntimeError("Refusing to use anything except the dedicated local test database and ports")
    for key in ("postgres_bin", "postgres_data", "redis_exe"):
        if not Path(value[key]).resolve().is_relative_to(BASE.resolve()):
            raise RuntimeError("Test runtime path is outside the local test directory")
    return value


def run(args, **options):
    return subprocess.run(args, creationflags=FLAGS, timeout=40, **options)


def psql(c, sql):
    env = os.environ.copy()
    env["PGPASSWORD"] = c["postgres_password"]
    result = run([str(Path(c["postgres_bin"]) / "psql.exe"), "-h", "127.0.0.1", "-p", str(c["postgres_port"]),
                  "-U", c["postgres_user"], "-d", c["database"], "-X", "-v", "ON_ERROR_STOP=1", "-tAc", sql],
                 env=env, capture_output=True)
    if result.returncode:
        raise RuntimeError("Local PostgreSQL check failed: " + result.stderr.decode("utf-8", "replace"))
    return result.stdout.decode("utf-8", "replace").strip()


def redis(c, *commands):
    def send(stream, *args):
        values = [str(x).encode() for x in args]
        stream.write(b"*" + str(len(values)).encode() + b"\r\n" +
                     b"".join(b"$" + str(len(x)).encode() + b"\r\n" + x + b"\r\n" for x in values))
        stream.flush()
        line = stream.readline()
        if line.startswith(b"-"):
            raise RuntimeError("Local Redis command failed: " + line.decode("utf-8", "replace"))
        if line.startswith(b"$"):
            size = int(line[1:].strip())
            value = stream.read(size)
            stream.read(2)
            return value.decode("utf-8", "replace")
        return line[1:].decode("utf-8", "replace").strip()
    with socket.create_connection(("127.0.0.1", c["redis_port"]), timeout=3) as connection:
        with connection.makefile("rwb") as stream:
            if send(stream, "AUTH", c["redis_password"]) != "OK":
                raise RuntimeError("Local Redis authentication failed")
            return send(stream, *commands)


def health(c):
    directory = Path(psql(c, "SHOW data_directory")).resolve()
    if directory != Path(c["postgres_data"]).resolve():
        raise RuntimeError("The database on the test port is not the configured test cluster")
    if psql(c, "SELECT current_database()") != "pulse_core_test" or redis(c, "PING") != "PONG":
        raise RuntimeError("Local test dependency health check failed")
    return {"postgres": "127.0.0.1:15432/pulse_core_test", "postgres_version": psql(c, "SHOW server_version"),
            "redis": "127.0.0.1:16379", "redis_implementation": c["redis_implementation"],
            "data_directory": str(directory), "ffprobe": c.get("ffprobe", "not configured"), "production_connected": False}


def start(c):
    pg_ctl = str(Path(c["postgres_bin"]) / "pg_ctl.exe")
    if run([pg_ctl, "-D", c["postgres_data"], "status"], capture_output=True).returncode:
        # File handles avoid Windows background children keeping caller pipes open.
        with (BASE / "pg-ctl-launch.log").open("ab") as output:
            result = run([pg_ctl, "-D", c["postgres_data"], "-l", str(BASE / "postgres-server.log"), "-w", "-t", "30", "start"],
                         stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, close_fds=True)
        if result.returncode:
            raise RuntimeError("PostgreSQL failed to start; see the local runtime logs")
    try:
        if redis(c, "PING") == "PONG":
            return health(c)
    except OSError:
        pass
    with (BASE / "memurai-launch.log").open("ab") as output:
        process = subprocess.Popen([c["redis_exe"], str(BASE / "memurai-test.conf")], cwd=BASE / "redis-data",
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                   creationflags=FLAGS, close_fds=True)
    for _ in range(60):
        try:
            if redis(c, "PING") == "PONG":
                return health(c)
        except OSError:
            pass
        if process.poll() is not None:
            raise RuntimeError("Redis-compatible service exited; see the local runtime logs")
        time.sleep(.1)
    raise RuntimeError("Redis-compatible service startup timed out")


def stop(c):
    pg_ctl = str(Path(c["postgres_bin"]) / "pg_ctl.exe")
    pg_running = run([pg_ctl, "-D", c["postgres_data"], "status"], capture_output=True).returncode == 0
    if pg_running and Path(psql(c, "SHOW data_directory")).resolve() != Path(c["postgres_data"]).resolve():
        raise RuntimeError("The database on the test port is not the configured test cluster")
    try:
        redis(c, "PING")
    except ConnectionRefusedError:
        pass
    else:
        try:
            redis(c, "SHUTDOWN", "NOSAVE")
        except ConnectionResetError:
            # Memurai on Windows resets the socket when SHUTDOWN completes.
            pass
    if pg_running:
        result = run([pg_ctl, "-D", c["postgres_data"], "-m", "fast", "-w", "stop"], capture_output=True)
        if result.returncode:
            raise RuntimeError("PostgreSQL shutdown failed")
    print("Local test services stopped; data and runtime files retained.")


def test(c, pattern):
    print(json.dumps(start(c), ensure_ascii=False), flush=True)
    env = os.environ.copy()
    env["PULSE_CORE_TEST_DSN"] = (f"postgres://{c['postgres_user']}:{quote(c['postgres_password'], safe='')}"
                                  "@127.0.0.1:15432/pulse_core_test?sslmode=disable")
    env["PULSE_CORE_TEST_REDIS_URL"] = f"redis://:{quote(c['redis_password'], safe='')}@127.0.0.1:16379/0"
    env["PULSE_CORE_TEST_DATABASE"] = "pulse_core_test"
    if c.get("ffprobe") and c.get("media_samples"):
        env["PULSE_TEST_FFPROBE"] = c["ffprobe"]
        env["PULSE_TEST_MEDIA_SAMPLES"] = c["media_samples"]
    go = Path.home() / "AppData/Local/Programs/Go/bin/go.exe"
    executable = str(go) if go.is_file() else shutil.which("go")
    if not executable:
        raise RuntimeError("Go compiler not found")
    args = [executable, "-C", str(ROOT / "server"), "test", "-json", "-count=1", "-p=1", "-timeout=15m"]
    if pattern:
        args.extend(["-run", pattern])
    args.append("./...")
    output = ROOT / ".local/backend-tests" / datetime.now().strftime("%Y%m%d-%H%M%S")
    output.mkdir(parents=True, exist_ok=False)
    log = output / "go-tests.jsonl"
    print("Running Go integration tests; log: " + str(log), flush=True)
    with log.open("wb") as stream:
        result = subprocess.run(args, env=env, stdout=stream, stderr=subprocess.STDOUT, creationflags=FLAGS)
    events = []
    for line in log.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    report = {"exit_code": result.returncode, "pattern": pattern or "all", "postgres_version": c["postgres_version"],
              "redis_implementation": c["redis_implementation"], "ffprobe_configured": bool(c.get("ffprobe")),
              "passed_tests": [r["Test"] for r in events if r.get("Action") == "pass" and r.get("Test")],
              "failed_tests": [r["Test"] for r in events if r.get("Action") == "fail" and r.get("Test")],
              "skipped_tests": [r["Test"] for r in events if r.get("Action") == "skip" and r.get("Test")],
              "production_connected": False, "log": str(log)}
    (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**report, "passed_tests": len(report["passed_tests"])}, ensure_ascii=False), flush=True)
    if result.returncode:
        print("\n".join(log.read_text(encoding="utf-8-sig", errors="replace").splitlines()[-35:]))
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop", "status", "test"])
    parser.add_argument("--run", default="", help="Optional Go test name regular expression")
    args = parser.parse_args()
    c = config()
    with nullcontext() if args.action == "status" else exclusive():
        if args.action == "test":
            return test(c, args.run)
        if args.action == "stop":
            stop(c)
        else:
            print(json.dumps(start(c) if args.action == "start" else health(c), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
