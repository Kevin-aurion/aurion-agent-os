#!/bin/zsh
set -euo pipefail

CLIENT_ID='3db2b7a3-9fcf-4cf4-9afc-d30d29fbe801'
KEYCHAIN_SERVICE='app.aurion.aios.vincent.read'
SCRIPT_DIR="${0:A:h}"
SERVER_DIR="${SCRIPT_DIR:h}"

echo 'Aurion AIOS — Vincent MCP credential installer'
echo 'The client secret will be entered directly into macOS Keychain.'
echo 'It will not be written to this project, the database, shell history, or logs.'
echo

# Passing -w without a value makes macOS security prompt securely. Do not
# capture the secret in a shell variable or expose it through the process list.
/usr/bin/security add-generic-password \
  -U \
  -a "$CLIENT_ID" \
  -s "$KEYCHAIN_SERVICE" \
  -l 'Aurion AIOS — Vincent read-only MCP' \
  -j 'Expires 2026-09-10; callback http://localhost:3335/oauth/callback' \
  -w

cd "$SERVER_DIR"
PATH="/Users/kevin/.local/node/bin:$PATH" npx tsx src/scripts/configure-vincent-mcp.ts --provision

echo
echo 'Credential stored and disabled Vincent MCP registry entry provisioned.'
echo 'A browser OAuth page will open next. Complete the Vincent authorization there.'
echo
PATH="/Users/kevin/.local/node/bin:$PATH" npx tsx src/scripts/configure-vincent-mcp.ts --verify

echo
echo 'Vincent MCP verified, bound to the Hank query Agent, and enabled.'
