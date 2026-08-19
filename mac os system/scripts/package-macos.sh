#!/usr/bin/env bash
# package-macos.sh — clean-build Release aios-system and produce an installable .pkg
#
# Usage (from repo):
#   ./scripts/package-macos.sh
#   ./scripts/package-macos.sh --sign "Developer ID Installer: Example (TEAMID)"
#
# Output (unambiguous):
#   dist/aios-system-<version>.pkg          (final path; may be UNSIGNED)
#   dist/aios-system-<version>-UNSIGNED.pkg (always written when unsigned)
#   PACKAGE_SIGNATURE_STATUS=UNSIGNED|SIGNED
#   PKG_PATH=...
#   PKG_SHA256=...
#
# Release entitlements: com.apple.security.get-task-allow MUST be false.
# Packaging fails if:
#   - get-task-allow is true
#   - pkgutil --payload-files contains any path matching /._ or /.__
#   - staged/extracted app codesign verify fails
#
# No tokens, API keys, server URLs, or device credentials are embedded.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/aios-system/aios-system.xcodeproj"
SCHEME="aios-system"
CONFIG="Release"
DERIVED="$ROOT/build/DerivedData-package"
DIST="$ROOT/dist"
STAGE="$ROOT/build/pkg-stage"
CLEAN="$ROOT/build/pkg-clean"
PKGDIR="$ROOT/build/pkg-flat"
RELEASE_ENTS="$ROOT/aios-system/aios-system.Release.entitlements"
VERSION="1.0"
IDENTIFIER="aurion.aios-system"
INSTALL_LOCATION="/Applications"
SIGN_IDENTITY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign) SIGN_IDENTITY="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$DIST" "$ROOT/build"
rm -rf "$DERIVED" "$STAGE" "$CLEAN" "$PKGDIR"
mkdir -p "$STAGE" "$CLEAN" "$PKGDIR"

# ── Build Release ─────────────────────────────────────────────────────────────
echo "==> Clean build Release (CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO)"
set +e
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" \
  clean build \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
  CODE_SIGN_ENTITLEMENTS="aios-system.Release.entitlements" \
  >"$ROOT/build/package-xcodebuild.log" 2>&1
BUILD_STATUS=$?
set -e

if [[ $BUILD_STATUS -ne 0 ]]; then
  echo "ERROR: xcodebuild Release failed (exit $BUILD_STATUS)" >&2
  grep -E 'error:|warning:|BUILD SUCCEEDED|BUILD FAILED|fatal error:' \
    "$ROOT/build/package-xcodebuild.log" >&2 || true
  exit "$BUILD_STATUS"
fi
echo "==> xcodebuild Release OK"
grep -E 'warning:|BUILD SUCCEEDED' "$ROOT/build/package-xcodebuild.log" || true

APP_SRC=$(find "$DERIVED/Build/Products/$CONFIG" -maxdepth 1 -name 'aios-system.app' -print -quit)
if [[ -z "${APP_SRC:-}" || ! -d "$APP_SRC" ]]; then
  echo "ERROR: aios-system.app not found" >&2
  exit 1
fi
if [[ ! -f "$RELEASE_ENTS" ]]; then
  echo "ERROR: missing $RELEASE_ENTS" >&2
  exit 1
fi

# ── get-task-allow gate ───────────────────────────────────────────────────────
assert_get_task_allow_false() {
  local app="$1" label="$2" ents_xml val
  ents_xml=$(codesign -d --entitlements :- "$app" 2>/dev/null || true)
  if [[ -z "$ents_xml" ]]; then
    echo "ERROR: [$label] codesign -d --entitlements empty" >&2
    exit 1
  fi
  echo "==> [$label] codesign entitlements:"
  echo "$ents_xml" | plutil -p - 2>/dev/null || echo "$ents_xml"

  # plutil keypaths treat '.' as nesting — escape for the literal entitlement key.
  local keypath='com\.apple\.security\.get-task-allow'
  val=$(printf '%s' "$ents_xml" | plutil -extract "$keypath" raw -o - - 2>/dev/null || true)
  if [[ -z "$val" ]]; then
    # Fallback: only the value token immediately after this key (not other keys' <true/>).
    local after
    after=$(printf '%s' "$ents_xml" | sed -n 's/.*com\.apple\.security\.get-task-allow<\/key>[[:space:]]*\(<[^>]*\>\).*/\1/p' | head -1)
    case "$after" in
      '<true/>'|'<true />')
        echo "ERROR: [$label] get-task-allow is true" >&2
        exit 1
        ;;
      '<false/>'|'<false />'|'')
        echo "==> [$label] get-task-allow absent/false ✓"
        return 0
        ;;
      *)
        echo "ERROR: [$label] could not parse get-task-allow (token=$after)" >&2
        exit 1
        ;;
    esac
  fi
  case "$val" in
    false|0|NO|no)
      echo "==> [$label] get-task-allow=$val ✓"
      ;;
    true|1|YES|yes)
      echo "ERROR: [$label] com.apple.security.get-task-allow=$val (Release must be false)" >&2
      exit 1
      ;;
    *)
      echo "ERROR: [$label] unexpected get-task-allow value: $val" >&2
      exit 1
      ;;
  esac
}

assert_get_task_allow_false "$APP_SRC" "built-Release"

# ── Stage + re-sign (working copy under build/) ───────────────────────────────
echo "==> Stage signed app under $STAGE (staging only)"
export COPYFILE_DISABLE=1
STAGED_APP="$STAGE/aios-system.app"
rsync -a --exclude='._*' --exclude='.DS_Store' "$APP_SRC/" "$STAGED_APP/"
find "$STAGE" \( -name '._*' -o -name '.DS_Store' \) -delete 2>/dev/null || true
xattr -cr "$STAGED_APP" 2>/dev/null || true

codesign --force --sign - --options runtime \
  --entitlements "$RELEASE_ENTS" \
  --timestamp=none \
  "$STAGED_APP"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"
assert_get_task_allow_false "$STAGED_APP" "staged-Release"

# ── Materialize clean tree (data forks only → no AppleDouble in Bom) ──────────
# cat creates fresh inodes without resource forks; mkbom then omits ._* entries.
echo "==> Materialize xattr-free clean tree for Bom/Payload"
cd "$STAGE"
find aios-system.app \( -type f -o -type d \) -print0 | while IFS= read -r -d '' p; do
  if [[ -d "$p" && ! -L "$p" ]]; then
    mkdir -p "$CLEAN/$p"
  elif [[ -f "$p" ]]; then
    mkdir -p "$CLEAN/$(dirname "$p")"
    cat "$p" > "$CLEAN/$p"
    chmod "$(stat -f '%Lp' "$p")" "$CLEAN/$p"
  fi
done
chmod 755 "$CLEAN/aios-system.app/Contents/MacOS/aios-system"
find "$CLEAN" \( -name '._*' -o -name '.DS_Store' \) -delete 2>/dev/null || true

# ── Assemble flat package (Bom + gzip cpio Payload + PackageInfo + xar) ───────
echo "==> Build Bom + Payload without AppleDouble sidecars"
mkbom "$CLEAN" "$PKGDIR/Bom"
if lsbom "$PKGDIR/Bom" | grep -Eq '\._|/\.__'; then
  echo "ERROR: mkbom still produced AppleDouble entries" >&2
  lsbom "$PKGDIR/Bom" | grep -E '\._|/\.__' >&2 || true
  exit 1
fi

( cd "$CLEAN" && find . | COPYFILE_DISABLE=1 cpio -o -H odc 2>/dev/null | gzip -n > "$PKGDIR/Payload" )

NUM_FILES=$(find "$CLEAN" | wc -l | tr -d ' ')
KBYTES=$(du -sk "$CLEAN" | awk '{print $1}')
cat > "$PKGDIR/PackageInfo" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<pkg-info format-version="2" identifier="${IDENTIFIER}" version="${VERSION}" install-location="${INSTALL_LOCATION}" auth="root" overwrite-permissions="true" relocatable="false">
  <payload installKBytes="${KBYTES}" numberOfFiles="${NUM_FILES}"/>
  <bundle path="./aios-system.app" id="${IDENTIFIER}" CFBundleShortVersionString="${VERSION}" CFBundleVersion="${VERSION}"/>
  <bundle-version>
    <bundle id="${IDENTIFIER}"/>
  </bundle-version>
</pkg-info>
EOF

UNSIGNED_PKG="$DIST/aios-system-${VERSION}-UNSIGNED.pkg"
FINAL_PKG="$DIST/aios-system-${VERSION}.pkg"
rm -f "$UNSIGNED_PKG" "$FINAL_PKG" \
  "$DIST/aios-system-${VERSION}-unsigned.pkg" 2>/dev/null || true

( cd "$PKGDIR" && xar --compression none -cf "$UNSIGNED_PKG" Bom Payload PackageInfo )
echo "==> Wrote $UNSIGNED_PKG"

# ── Payload sidecar gate ──────────────────────────────────────────────────────
echo "==> pkgutil --payload-files"
PAYLOAD_LIST=$(pkgutil --payload-files "$UNSIGNED_PKG")
echo "$PAYLOAD_LIST"
if echo "$PAYLOAD_LIST" | grep -E '/\._|/\.__' >/dev/null; then
  echo "ERROR: package payload contains AppleDouble / sidecar path entries" >&2
  echo "$PAYLOAD_LIST" | grep -E '/\._|/\.__' >&2 || true
  exit 1
fi
echo "==> No AppleDouble sidecar paths in package payload ✓"

# Codesign must still verify after extract from package
TMP_EXTRACT=$(mktemp -d)
trap 'rm -rf "$TMP_EXTRACT"' EXIT
pkgutil --expand "$UNSIGNED_PKG" "$TMP_EXTRACT/e"
mkdir -p "$TMP_EXTRACT/r"
( cd "$TMP_EXTRACT/r" && gzip -dc "$TMP_EXTRACT/e/Payload" | cpio -id 2>/dev/null )
codesign --verify --deep --strict "$TMP_EXTRACT/r/aios-system.app"
assert_get_task_allow_false "$TMP_EXTRACT/r/aios-system.app" "pkg-extracted-Release"
echo "==> Extracted app codesign valid ✓"

# ── Optional installer productsign ────────────────────────────────────────────
PACKAGE_SIGNATURE_STATUS="UNSIGNED"
if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> productsign with identity: $SIGN_IDENTITY"
  productsign --sign "$SIGN_IDENTITY" "$UNSIGNED_PKG" "$FINAL_PKG"
  rm -f "$UNSIGNED_PKG"
  PACKAGE_SIGNATURE_STATUS="SIGNED"
  SIG_PATH="$FINAL_PKG"
else
  # Keep stable final name; also retain explicit UNSIGNED filename (same bytes).
  cp -f "$UNSIGNED_PKG" "$FINAL_PKG"
  SIG_PATH="$UNSIGNED_PKG"
fi

# Inspect installer package signature
SIG_OUT=$(pkgutil --check-signature "$FINAL_PKG" 2>&1 || true)
echo "==> Package signature inspection:"
echo "$SIG_OUT"
if echo "$SIG_OUT" | grep -qi 'Status: signed by'; then
  PACKAGE_SIGNATURE_STATUS="SIGNED"
else
  PACKAGE_SIGNATURE_STATUS="UNSIGNED"
fi

SHA256=$(shasum -a 256 "$FINAL_PKG" | awk '{print $1}')

cat <<EOF

========================================================================
PACKAGE_SIGNATURE_STATUS=$PACKAGE_SIGNATURE_STATUS
PKG_PATH=$FINAL_PKG
PKG_UNSIGNED_PATH=${UNSIGNED_PKG}
PKG_SHA256=$SHA256
get-task-allow=false (Release verified on built + staged + pkg-extracted app)
payload AppleDouble sidecars=none
========================================================================
EOF

if [[ "$PACKAGE_SIGNATURE_STATUS" == "UNSIGNED" ]]; then
  cat <<EOF

*** PACKAGE IS UNSIGNED — local QA only ***
Explicit UNSIGNED file:
  $UNSIGNED_PKG
Also available as (same content):
  $FINAL_PKG

pkgutil --check-signature status: no signature

For external customers you MUST:
  1. productsign --sign "Developer ID Installer: Your Name (TEAMID)" \\
       "$FINAL_PKG" dist/aios-system-${VERSION}-signed.pkg
  2. xcrun notarytool submit dist/aios-system-${VERSION}-signed.pkg --wait …
  3. xcrun stapler staple dist/aios-system-${VERSION}-signed.pkg

No tokens or runtime config are embedded in this package.
EOF
else
  echo "PACKAGE_SIGNATURE_STATUS=SIGNED — proceed with notarization if required."
fi
