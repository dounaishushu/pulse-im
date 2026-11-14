"""Inventory retained view route literals. This is not UI or business acceptance."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = "auth|contacts|contact-requests|notifications|conversations|conversation-folders|messages|work-tasks|client|blocks|media|admin|go"
ROUTE = re.compile(r"['\"`](/(?:" + FAMILIES + r")(?:/[A-Za-z0-9_.-]*)*)")
LITERAL = re.compile(r"['\"`](/[A-Za-z0-9_./-]+)['\"`]")
IGNORE = {"go-v2.js", "go-realtime.js", "go-v2-ui.js", "GoV2Transport.swift", "GoV2Transport.kt", "GoV2Ids.kt", "GoContactPrivacy.swift", "go-routes.js", "route-manager.js", "go-api.js"}
SPECS = {
    "web": ("web", "client-shared/go-v2.js"),
    "pc": ("pc/web", "client-shared/go-v2.js"),
    "android": ("android/app/src/main/java", "android/app/src/main/java/com/pulseim/android/GoV2Api.kt"),
    "ios": ("ios/PulseIM", "ios/PulseIM/GoV2Adapter.swift"),
    "admin": ("admin/src", "admin/src/go-api.js"),
}
SPECIAL = {
    "web": {"/client/update": "direct_go: app.js GO.raw('/client/update')", "/conversations/members/": "dynamic: role, mute and remove dispatch cases"},
    "pc": {"/client/update": "direct_go: app.js GO.raw('/client/update')", "/conversations/members/": "dynamic: role, mute and remove dispatch cases", "/media": "validation: retained signed-media URL parser; Go uses grant URLs"},
    "android": {"/conversations/": "validation: idempotent message replay path pattern in ApiClient.goRequest", "/client/diagnostics": "direct_go: ApiClient.goRequest", "/client/route-manifest": "legacy_only: VerifiedRoutes.refresh returns via Go config branch", "/client/route-probe": "legacy_only: VerifiedRoutes.probe returns via Go config branch", "/media": "validation: retained media path parser", "/media/": "direct_go: ApiClient.uploadGoMedia", "/media/uploads": "direct_go: ApiClient.uploadGoMedia"},
    "ios": {"/client/route-probe": "legacy_only: VerifiedRoutes.probe returns via Go config branch", "/contact-requests/summary": "legacy_only: APIClient.friendRequestSummary uses paged Go requests", "/media": "validation: retained media path parser; Go uses grant URLs"},
    "admin": {"/admin/auth/": "classification_prefix: permission routing", "/admin/maintenance/": "dynamic: config, preview, cache-preview, run and runs", "/admin/mobile-devices/": "classification_prefix: policy/unbind/unbind-all dispatch cases", "/media": "validation: signed-media URL parser; Go uses authorized blob content"},
}


def inventory(name, directory, adapter):
    adapter_path = ROOT / adapter
    dispatch = set(LITERAL.findall(adapter_path.read_text(encoding="utf-8")))
    found = {}
    for path in sorted((ROOT / directory).rglob("*")):
        if name == "admin" and path.parent.name == "router":
            continue  # Vue route paths are navigation, not HTTP endpoints.
        if path.suffix not in {".js", ".kt", ".swift", ".ts", ".vue"} or path == adapter_path or path.name in IGNORE:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in ROUTE.finditer(line):
                found.setdefault(match[1], []).append(f"{path.relative_to(ROOT).as_posix()}:{number}")
    rows = []
    for route, occurrences in sorted(found.items()):
        resolution = "adapter_literal" if route in dispatch else SPECIAL[name].get(route, "unresolved")
        rows.append({"route": route, "resolution": resolution, "sources": occurrences})
    return {"scope": "Static route literals and documented dynamic/direct branches; not feature, UI, device or deployment acceptance", "adapter": adapter, "route_count": len(rows), "unresolved": [row["route"] for row in rows if row["resolution"] == "unresolved"], "routes": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    report = {name: inventory(name, *spec) for name, spec in SPECS.items()}
    if any(value["unresolved"] for value in report.values()):
        print(json.dumps({name: value["unresolved"] for name, value in report.items()}, ensure_ascii=False))
        raise SystemExit(1)
    outputs = {"docs/client-api-coverage.json": report, "docs/android-api-coverage.json": report["android"], "docs/ios-api-coverage.json": report["ios"]}
    for relative, value in outputs.items():
        data = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        target = ROOT / relative
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != data:
                raise SystemExit(f"Coverage report is stale: {relative}")
        else:
            target.write_text(data, encoding="utf-8")
    print(json.dumps({name: {"routes": value["route_count"], "unresolved": 0} for name, value in report.items()}))


if __name__ == "__main__":
    main()
