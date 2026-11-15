#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-chat-scroll}"
mkdir -p "$output"
"${SWIFTC:-swiftc}" -swift-version 5 "$root/ios/PulseIM/ChatScrollState.swift" \
  "$root/ios/Tests/ChatScrollStateTests.swift" -o "$output/chat-scroll"
"$output/chat-scroll"
