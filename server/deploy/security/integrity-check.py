#!/usr/bin/python3
"""Compare the active release against a separately retained deployment manifest."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def check(root, manifest):
    expected = manifest["files"]
    failures = []
    for name, digest in expected.items():
        path = root / name
        try:
            path.relative_to(root)
            if ".." in Path(name).parts or path.is_symlink():
                raise ValueError("unsafe path")
            metadata = path.stat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
                raise ValueError("unsafe ownership or permissions")
            actual = hashlib.sha256()
            with path.open("rb") as content:
                for block in iter(lambda: content.read(1024 * 1024), b""):
                    actual.update(block)
            if actual.hexdigest() != digest:
                raise ValueError("checksum differs")
        except (OSError, ValueError) as error:
            failures.append({"file": name, "reason": str(error)[:160]})
    for directory in ("web", "admin"):
        for current, dirs, files in os.walk(root / directory, followlinks=False):
            for name in dirs + files:
                path = Path(current) / name
                relative = path.relative_to(root).as_posix()
                if path.is_symlink() or (path.is_file() and relative not in expected):
                    failures.append({"file": relative, "reason": "unexpected served file or symlink"})
    return failures


if __name__ == "__main__":
    root = Path("/opt/pulse/current").resolve(strict=True)
    manifest = json.loads(Path("/etc/pulse/release-manifest.json").read_text())
    failures = check(root, manifest)
    print(json.dumps({"release": str(root), "files": len(manifest["files"]),
                      "result": "failed" if failures else "passed", "failures": failures}))
    sys.exit(1 if failures else 0)
