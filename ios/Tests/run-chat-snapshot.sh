#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-chat-snapshot}"
mkdir -p "$output"
"${SWIFTC:-swiftc}" -swift-version 5 \
  "$root/ios/PulseIM/Models.swift" "$root/ios/Tests/ChatSnapshotTests.swift" \
  -o "$output/chat-snapshot"
"$output/chat-snapshot"
