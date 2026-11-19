#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-client-config-tests}"
mkdir -p "$output"
swiftc -swift-version 5 \
  "$root/ios/PulseIM/GoV2Transport.swift" "$root/ios/PulseIM/GoV2Adapter.swift" \
  "$root/ios/PulseIM/GoContactPrivacy.swift" "$root/ios/PulseIM/Models.swift" \
  "$root/ios/PulseIM/MessageForwarding.swift" "$root/ios/PulseIM/ExploreNavigation.swift" \
  "$root/ios/Tests/ClientConfigTests.swift" -o "$output/client-config-tests"
"$output/client-config-tests"
