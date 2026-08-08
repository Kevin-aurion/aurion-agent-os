$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MarketplaceSource = Join-Path $ScriptDir "marketplace"
$InstallRoot = Join-Path $env:USERPROFILE ".aurion-aios"
$MarketplaceTarget = Join-Path $InstallRoot "claude-plugin-marketplace"
$Manifest = Join-Path $MarketplaceSource ".claude-plugin\marketplace.json"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "找不到 Claude Code CLI。請先安裝 Claude Code，再重新執行本安裝程式。" -ForegroundColor Red
  Write-Host "https://docs.anthropic.com/en/docs/claude-code/setup"
  Read-Host "按 Enter 結束"
  exit 1
}

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
  Write-Host "安裝包不完整：找不到 marketplace.json。" -ForegroundColor Red
  Read-Host "按 Enter 結束"
  exit 1
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
if (Test-Path -LiteralPath $MarketplaceTarget) {
  $Timestamp = Get-Date -Format "yyyyMMddHHmmss"
  $BackupTarget = Join-Path $InstallRoot "claude-plugin-marketplace.backup.$Timestamp"
  Move-Item -LiteralPath $MarketplaceTarget -Destination $BackupTarget
  Write-Host "已將前一版備份至：$BackupTarget"
}
Copy-Item -LiteralPath $MarketplaceSource -Destination $MarketplaceTarget -Recurse

try { & claude plugin marketplace remove aurion-aios 2>$null } catch { }
try { & claude plugin uninstall aurion-aios-builder@aurion-aios 2>$null } catch { }
& claude plugin marketplace add --scope user $MarketplaceTarget
if ($LASTEXITCODE -ne 0) { throw "無法加入 Aurion AIOS marketplace。" }
& claude plugin install aurion-aios-builder@aurion-aios
if ($LASTEXITCODE -ne 0) { throw "無法安裝 Aurion AIOS Plugin。" }

Write-Host ""
Write-Host "Aurion AIOS Agent Builder 已安裝完成。" -ForegroundColor Green
Write-Host "客戶端沒有安裝任何 AIOS 服務；Claude 只會連線到："
Write-Host "https://aurion-aios-mcp.lazyoffice.app/mcp"
Write-Host ""
Write-Host "請重新啟動 Claude。第一次使用時，Claude 會要求登入並授權 AIOS。"
Write-Host "完成對話後可在此查看建置記錄："
Write-Host "https://aurion-aios.lazyoffice.app/agent-builds"
Read-Host "按 Enter 結束"
