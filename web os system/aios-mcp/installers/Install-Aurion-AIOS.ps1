$ErrorActionPreference = "Stop"

$MarketplaceRepository = "Kevin-aurion/aurion-aios-plugin-marketplace"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "找不到 Claude Code CLI。請先安裝 Claude Code，再重新執行本安裝程式。" -ForegroundColor Red
  Write-Host "https://docs.anthropic.com/en/docs/claude-code/setup"
  Read-Host "按 Enter 結束"
  exit 1
}

try { & claude plugin uninstall aurion-aios-builder@aurion-aios 2>$null } catch { }
try { & claude plugin marketplace remove aurion-aios 2>$null } catch { }
try { & claude plugin uninstall aurion-aios-builder@aurion-aios-plugin-marketplace 2>$null } catch { }
try { & claude plugin marketplace remove aurion-aios-plugin-marketplace 2>$null } catch { }
& claude plugin marketplace add --scope user $MarketplaceRepository
if ($LASTEXITCODE -ne 0) {
  throw "無法讀取私人 GitHub Marketplace；請先登入具有存取權的 GitHub 帳號。"
}
& claude plugin install --scope user aurion-aios-builder@aurion-aios-plugin-marketplace
if ($LASTEXITCODE -ne 0) { throw "無法安裝 Aurion AIOS Plugin。" }

Write-Host ""
Write-Host "Aurion AIOS Agent Builder 已安裝完成。" -ForegroundColor Green
Write-Host "Plugin Marketplace：https://github.com/$MarketplaceRepository（Private）"
Write-Host "客戶端沒有安裝任何 AIOS 服務；Claude 只會連線到："
Write-Host "https://aios-mcp.lazyoffice.app/mcp"
Write-Host ""
Write-Host "請重新啟動 Claude。第一次使用時，Claude 會要求登入並授權 AIOS。"
Write-Host "完成對話後可在此查看建置記錄："
Write-Host "https://aios-new.lazyoffice.app/agent-builds"
Read-Host "按 Enter 結束"
