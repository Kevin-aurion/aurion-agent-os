#!/bin/zsh
set -euo pipefail

KEYCHAIN_ACCOUNT='aios-employee:vincent-query-consultant'
KEYCHAIN_SERVICE='app.aurion.aios.vincent.hs256'
SCRIPT_DIR="${0:A:h}"
SERVER_DIR="${SCRIPT_DIR:h}"

echo 'Aurion AIOS — Vincent MCP HS256 shared-secret installer'
echo 'The shared secret will be entered directly into macOS Keychain.'
echo 'It will not be written to this project, the database, shell history, or logs.'
echo

# Passing -w without a value makes macOS security prompt securely. Do not
# capture the secret in a shell variable or expose it through the process list.
/usr/bin/security add-generic-password \
  -U \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -l 'Aurion AIOS — Vincent HS256 read-only MCP' \
  -j 'Short-lived JWT signer; no OAuth callback' \
  -w

cd "$SERVER_DIR"
PATH="/Users/kevin/.local/node/bin:$PATH" npx tsx src/scripts/configure-vincent-mcp.ts --provision

echo
echo 'Shared secret stored and disabled Vincent MCP registry entry provisioned.'
echo 'Running headless initialize, tools/list and knowledge smoke tests now.'
echo
PATH="/Users/kevin/.local/node/bin:$PATH" npx tsx src/scripts/configure-vincent-mcp.ts --verify

echo
echo 'Vincent MCP verified without OAuth, bound to the Hank query Agent, and enabled.'
