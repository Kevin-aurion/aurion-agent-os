#!/bin/bash

# Double-click launcher for non-technical macOS users.

set -u

LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_RESOURCES="${LAUNCHER_DIR}/Aurion AIOS Updater.app/Contents/Resources"
UPDATER="${APP_RESOURCES}/update-aios-plugins.sh"
BUNDLED_MARKETPLACE="${APP_RESOURCES}/marketplace"
PLUGIN_SOURCE="${BUNDLED_MARKETPLACE}/plugins/aurion-aios-builder"

clear
printf 'Aurion AIOS 安裝／更新工具\n'
printf '==========================\n\n'
printf '接下來會自動安裝或更新 Claude／Codex Plugin，並檢查 MCP 登入。\n'
printf '如果尚未授權，瀏覽器會自動開啟，請在網頁完成登入。\n\n'

if [ ! -f "$UPDATER" ] || [ ! -d "$PLUGIN_SOURCE" ]; then
  printf '❌ 更新套件不完整，請重新下載。\n'
  printf '\n按 Enter 關閉視窗...'
  read -r _
  exit 1
fi

# Read the bundled script through Apple's system shell instead of executing the
# quarantined nested file directly. Finder already asked the user to approve
# this launcher; a second direct exec can otherwise be terminated by Gatekeeper
# with SIGKILL ("Killed: 9") before the updater prints any diagnostics.
AURION_BUNDLED_MARKETPLACE="$BUNDLED_MARKETPLACE" AURION_PLUGIN_SOURCE="$PLUGIN_SOURCE" /bin/bash "$UPDATER"
RESULT=$?

printf '\n'
if [ "$RESULT" -eq 0 ]; then
  printf '全部完成。請重新開啟 Claude／Codex，再開一個新對話。\n'
else
  printf '有項目尚未完成，請保留這個畫面並交給管理人員查看。\n'
fi
printf '\n按 Enter 關閉視窗...'
read -r _
exit "$RESULT"
