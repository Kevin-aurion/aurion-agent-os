#!/usr/bin/env bash
set -euo pipefail
CODEX_BIN="${CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex}"
"$CODEX_BIN" app-server generate-ts --out "$(dirname "$0")/../src/generated"
"$CODEX_BIN" --version > "$(dirname "$0")/../src/generated/CODEX_VERSION"
