#!/bin/zsh
set -eu

MARKETPLACE_REPOSITORY="inventra/lazyoffice-aios-plugin-marketplace"

if ! command -v claude >/dev/null 2>&1; then
  echo "找不到 Claude Code CLI。請先安裝 Claude Code，再重新雙擊本安裝程式。"
  echo "https://docs.anthropic.com/en/docs/claude-code/setup"
  read -r "?按 Enter 結束..."
  exit 1
fi

claude plugin uninstall lazyoffice-aios-builder@lazyoffice-aios >/dev/null 2>&1 || true
claude plugin marketplace remove lazyoffice-aios >/dev/null 2>&1 || true
claude plugin uninstall lazyoffice-aios-builder@lazyoffice-aios-plugin-marketplace >/dev/null 2>&1 || true
claude plugin marketplace remove lazyoffice-aios-plugin-marketplace >/dev/null 2>&1 || true
if ! claude plugin marketplace add --scope user "$MARKETPLACE_REPOSITORY"; then
  echo "無法讀取私人 GitHub Marketplace。請先確認這台電腦已登入具有存取權的 GitHub 帳號。"
  read -r "?按 Enter 結束..."
  exit 1
fi
claude plugin install --scope user lazyoffice-aios-builder@lazyoffice-aios-plugin-marketplace

echo
echo "Lazyoffice AIOS Agent Builder 已安裝完成。"
echo "Plugin Marketplace：https://github.com/$MARKETPLACE_REPOSITORY（Private）"
echo "客戶端沒有安裝任何 AIOS 服務；Claude 只會連線到："
echo "https://aios-mcp.lazyoffice.app/mcp"
echo
echo "請重新啟動 Claude。第一次使用時，Claude 會要求登入並授權 AIOS。"
echo "完成對話後可在此查看建置記錄："
echo "https://aios-new.lazyoffice.app/agent-builds"
read -r "?按 Enter 結束..."
