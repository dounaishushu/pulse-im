#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:-$root/.local/ios-explore-session-tests}"
mkdir -p "$output"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Requires macOS 14+ with Swift/Xcode and a GUI session for real WebKit checks." >&2
  exit 2
fi
suite="pulse.explore.tests.$(uuidgen)"
port_file="$output/fixture-port-$suite"
python3 "$root/ios/Tests/explore-session-fixture.py" "$port_file" &
fixture_pid=$!
base=""
cleanup() {
  if [[ -x "$output/explore-session" && -n "$base" ]]; then
    "$output/explore-session" cleanup "$base" "$suite" || true
  fi
  kill "$fixture_pid" 2>/dev/null || true
  rm -f "$port_file"
}
trap cleanup EXIT
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$port_file" ]] && break
  sleep 0.05
done
base="http://127.0.0.1:$(cat "$port_file")/"
cat "$root/ios/PulseIM/ExploreViews.swift" "$root/ios/Tests/ExploreSessionWebKitTests.swift" > "$output/ExploreSessionRunner.swift"
"${SWIFTC:-swiftc}" -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macosx14.0" \
  "$root/ios/PulseIM/Models.swift" "$root/ios/PulseIM/ExploreNavigation.swift" \
  "$root/ios/PulseIM/ExploreCertificateTrust.swift" "$output/ExploreSessionRunner.swift" \
  -o "$output/explore-session"
"$output/explore-session" seed "$base" "$suite"
"$output/explore-session" verify "$base" "$suite"
