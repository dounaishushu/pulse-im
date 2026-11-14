#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-photo-state}"
mkdir -p "$output"
swiftc -swift-version 5 "$root/ios/PulseIM/PhotoSendState.swift" \
  "$root/ios/Tests/PhotoSendStateTests.swift" -o "$output/photo-state"
"$output/photo-state"
