"""Check iOS project/config wiring without claiming an Xcode target build."""
from pathlib import Path
import importlib.util
import json
import plistlib
import re
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
project = (root / "ios/PulseIM.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
ids = re.findall(r"^\s*([A-F0-9]{24}) /\*.*?\*/ =", project, re.M)
assert len(ids) == len(set(ids)), "duplicate Xcode object identifiers"
sources = list((root / "ios/PulseIM").glob("*.swift"))
for file in sources:
    assert project.count(f"path = {file.name};") == 1, file.name
    assert project.count(f"/* {file.name} in Sources */,") == 1, file.name
for file in list((root / "ios").rglob("*.plist")) + list((root / "ios").rglob("*.entitlements")):
    plistlib.loads(file.read_bytes())
for file in (root / "ios").rglob("*.xcscheme"):
    ET.parse(file)
spec = importlib.util.spec_from_file_location("ios_release_check", root / "ios/validate_release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify({"CONFIGURATION": "Debug"})
try:
    module.verify({"CONFIGURATION": "Release"})
except SystemExit:
    pass
else:
    raise AssertionError("unconfigured Release must fail")
sample = {"CONFIGURATION": "Release", "PULSE_API_URL": "https://im.build-validation.dev/api/v2", "PULSE_WS_URL": "wss://im.build-validation.dev/api/v2/realtime", "DEVELOPMENT_TEAM": "validation-only"}
module.verify(sample)
for key, invalid in [("PULSE_API_URL", "https://im.build-validation.dev/api"), ("PULSE_WS_URL", "wss://other.build-validation.dev/api/v2/realtime"), ("PULSE_API_URL", "https://im.build-validation.dev/api/v2?token=invalid")]:
    try:
        module.verify({**sample, key: invalid})
    except SystemExit:
        pass
    else:
        raise AssertionError(f"invalid configuration accepted: {key}")
print(json.dumps({"result": "passed", "swift_source_references": len(sources), "unique_project_objects": len(ids), "plist_and_scheme": "passed", "release_gate": "valid sample, missing config, wrong path, mismatched origin and query cases passed; no credentials generated", "scope": "static wiring/config validation; not an Xcode build"}, indent=2))
