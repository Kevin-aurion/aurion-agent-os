#!/bin/zsh
set -eu

SCRIPT_DIR="${0:A:h}"
MARKETPLACE_SOURCE="$SCRIPT_DIR/marketplace"
INSTALL_ROOT="$HOME/.aurion-aios"
MARKETPLACE_TARGET="$INSTALL_ROOT/claude-plugin-marketplace"

if ! command -v claude >/dev/null 2>&1; then
  echo "找不到 Claude Code CLI。請先安裝 Claude Code，再重新雙擊本安裝程式。"
  echo "https://docs.anthropic.com/en/docs/claude-code/setup"
  read -r "?按 Enter 結束..."
  exit 1
fi

if [[ ! -f "$MARKETPLACE_SOURCE/.claude-plugin/marketplace.json" ]]; then
  echo "安裝包不完整：找不到 marketplace.json。"
  read -r "?按 Enter 結束..."
  exit 1
fi

mkdir -p "$INSTALL_ROOT"
if [[ -e "$MARKETPLACE_TARGET" ]]; then
  BACKUP_TARGET="$INSTALL_ROOT/claude-plugin-marketplace.backup.$(date +%Y%m%d%H%M%S)"
  mv "$MARKETPLACE_TARGET" "$BACKUP_TARGET"
  echo "已將前一版備份至：$BACKUP_TARGET"
fi
cp -R "$MARKETPLACE_SOURCE" "$MARKETPLACE_TARGET"

claude plugin marketplace remove aurion-aios >/dev/null 2>&1 || true
claude plugin uninstall aurion-aios-builder@aurion-aios >/dev/null 2>&1 || true
claude plugin marketplace add --scope user "$MARKETPLACE_TARGET"
claude plugin install aurion-aios-builder@aurion-aios

echo
echo "Aurion AIOS Agent Builder 已安裝完成。"
echo "客戶端沒有安裝任何 AIOS 服務；Claude 只會連線到："
echo "https://aurion-aios-mcp.lazyoffice.app/mcp"
echo
echo "請重新啟動 Claude。第一次使用時，Claude 會要求登入並授權 AIOS。"
echo "完成對話後可在此查看建置記錄："
echo "https://aurion-aios.lazyoffice.app/agent-builds"
read -r "?按 Enter 結束..."
