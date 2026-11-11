#!/usr/bin/env bash
set -euo pipefail
# Configuration: {"base":"http://127.0.0.1:18080/api/v2","prefix":"fixture-prefix","password":"disposable-password"}
# Create four fresh disposable accounts named <prefix>a/b/c/d; only a is internal_staff.
# The probe changes their password, groups and relationships. Never use production accounts.
root="$(cd "$(dirname "$0")/../.." && pwd)"
config="${1:?Pass an absolute path to isolated probe-config.json}"
output="${2:-$root/.local/ios-core-probe}"
mkdir -p "$output"
swiftc -swift-version 5 \
  "$root/ios/PulseIM/GoV2Transport.swift" "$root/ios/PulseIM/GoV2Adapter.swift" \
  "$root/ios/PulseIM/GoContactPrivacy.swift" "$root/ios/PulseIM/Models.swift" \
  "$root/ios/PulseIM/MessageForwarding.swift" "$root/ios/Tests/GoV2Integration.swift" \
  -o "$output/probe"
"$output/probe" "$config"
