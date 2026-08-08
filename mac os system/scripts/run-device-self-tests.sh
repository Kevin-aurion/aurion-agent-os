#!/usr/bin/env bash
# Headless pure device-agent self-tests.
# Builds Debug (if needed) and runs: aios-system --self-test
#
# Build failures always propagate (pipefail + PIPESTATUS). Filtered diagnostics
# are printed only after a successful build — never mask a failed xcodebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/aios-system/aios-system.xcodeproj"
DERIVED="${AIOS_DERIVED_DATA:-$ROOT/build/DerivedData-selftest}"
LOG="$ROOT/build/selftest-xcodebuild.log"
mkdir -p "$ROOT/build"

echo "==> xcodebuild Debug (platform=macOS)"
set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme aios-system \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" \
  build \
  >"$LOG" 2>&1
BUILD_STATUS=$?
set -e

if [[ $BUILD_STATUS -ne 0 ]]; then
  echo "ERROR: xcodebuild failed (exit $BUILD_STATUS). Diagnostics:" >&2
  grep -E 'error:|warning:|BUILD SUCCEEDED|BUILD FAILED|fatal error:' "$LOG" >&2 || true
  echo "(full log: $LOG)" >&2
  exit "$BUILD_STATUS"
fi

echo "==> xcodebuild OK — filtered diagnostics:"
grep -E 'error:|warning:|BUILD SUCCEEDED|BUILD FAILED' "$LOG" || true

APP=$(find "$DERIVED/Build/Products/Debug" -maxdepth 1 -name 'aios-system.app' -print -quit)
if [[ -z "$APP" ]]; then
  echo "ERROR: app not found after successful build" >&2
  exit 1
fi

BIN="$APP/Contents/MacOS/aios-system"
echo "==> $BIN --self-test"
exec "$BIN" --self-test
