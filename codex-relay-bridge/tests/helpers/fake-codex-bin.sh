#!/usr/bin/env bash
# Wrapper so AppServerClient can spawn(CODEX_BIN, ["app-server"], ...).
# Ignores the "app-server" argument and runs the fake Node script.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="${HOME}/.local/node/bin:${PATH}"
# Shift past "app-server" if present
if [[ "${1:-}" == "app-server" ]]; then
  shift
fi
# FAKE_SCRIPT / FAKE_LOG / FAKE_RESPONSE_LOG already in env
exec node --import tsx "$DIR/fake-app-server.ts" "$@"
