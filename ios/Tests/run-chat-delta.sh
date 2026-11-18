#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-chat-delta}"
mkdir -p "$output"
"${SWIFTC:-swiftc}" -swift-version 5 \
  "$root/ios/PulseIM/GoV2Transport.swift" "$root/ios/PulseIM/GoV2Adapter.swift" \
  "$root/ios/PulseIM/GoContactPrivacy.swift" "$root/ios/PulseIM/Models.swift" \
  "$root/ios/PulseIM/MessageForwarding.swift" "$root/ios/Tests/ChatDeltaTests.swift" \
  -o "$output/probe"
python3 "$root/ios/Tests/chat-delta-fixture.py" "$output/probe"
