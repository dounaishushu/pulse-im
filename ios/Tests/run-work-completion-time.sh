#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="$(mktemp -d)"
trap 'rm -rf "$output"' EXIT
"${SWIFTC:-swiftc}" -swift-version 5 \
  "$root/ios/PulseIM/Models.swift" \
  "$root/ios/Tests/WorkCompletionTimeTests.swift" \
  -o "$output/work-completion-time"
"$output/work-completion-time"
