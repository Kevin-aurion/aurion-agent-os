$ErrorActionPreference = "Stop"

$PluginName = "aurion-aios-builder"
$ManagedMarketplaceName = "aurion-aios-updater"
$ClaudeMcpName = "plugin:aurion-aios-builder:aurion_aios"
$CodexMcpName = "aurion_aios"
$McpUrl = "https://aurion-aios-mcp.lazyoffice.app/mcp"
$CodexInstallUrl = "https://chatgpt.com/codex/install.ps1"
$BundledMarketplace = Join-Path $PSScriptRoot "marketplace"
$ManagedMarketplace = Join-Path $env:USERPROFILE ".aurion-aios\plugin-marketplace"
$PluginSource = Join-Path $BundledMarketplace "plugins\aurion-aios-builder"
$Failures = 0
$AvailableClients = 0

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-WarningMessage([string]$Message) {
  Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Add-Failure([string]$Message) {
  $script:Failures += 1
  Write-Host "[X] $Message" -ForegroundColor Red
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Program failed with exit code $LASTEXITCODE"
  }
}

function Add-ClientInstallPaths {
  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"),
    (Join-Path $env:APPDATA "npm"),
    (Join-Path $env:USERPROFILE ".local\bin")
  )
  $Current = @($env:Path -split ";")
  foreach ($Candidate in $Candidates) {
    if ((Test-Path -LiteralPath $Candidate -PathType Container) -and $Current -notcontains $Candidate) {
      $env:Path = "$env:Path;$Candidate"
      $Current += $Candidate
    }
  }
}

function Install-CodexWhenNoClient {
  Write-Step "Claude Code and Codex are not installed; installing the official Codex CLI"
  $Installer = Join-Path ([System.IO.Path]::GetTempPath()) ("aurion-codex-install-" + [guid]::NewGuid().ToString("N") + ".ps1")
  $HadNonInteractive = Test-Path Env:CODEX_NON_INTERACTIVE
  $PreviousNonInteractive = $env:CODEX_NON_INTERACTIVE
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $CodexInstallUrl -OutFile $Installer
    $env:CODEX_NON_INTERACTIVE = "1"
    Invoke-Checked "powershell.exe" @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Installer)
  } catch {
    Add-Failure "The official Codex CLI installation failed: $($_.Exception.Message)"
    return $false
  } finally {
    if (Test-Path -LiteralPath $Installer) { Remove-Item -LiteralPath $Installer -Force }
    if ($HadNonInteractive) {
      $env:CODEX_NON_INTERACTIVE = $PreviousNonInteractive
    } else {
      Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue
    }
  }

  Add-ClientInstallPaths
  if (Get-Command codex -ErrorAction SilentlyContinue) {
    Write-Ok "The official Codex CLI was installed."
    return $true
  }
  Add-Failure "Codex installation finished, but the codex command was not found. Restart Windows and run this updater again."
  return $false
}

function Test-ManagedMarketplace {
  return (Test-Path -LiteralPath (Join-Path $ManagedMarketplace ".claude-plugin\marketplace.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $ManagedMarketplace ".agents\plugins\marketplace.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $ManagedMarketplace "plugins\$PluginName") -PathType Container)
}

function Sync-ManagedMarketplace {
  $ClaudeManifest = Join-Path $BundledMarketplace ".claude-plugin\marketplace.json"
  $CodexManifest = Join-Path $BundledMarketplace ".agents\plugins\marketplace.json"
  if (-not (Test-Path -LiteralPath $ClaudeManifest -PathType Leaf) -or
      -not (Test-Path -LiteralPath $CodexManifest -PathType Leaf) -or
      -not (Test-Path -LiteralPath $PluginSource -PathType Container)) {
    throw "The updater package does not contain a complete Plugin marketplace."
  }

  $Parent = Split-Path -Parent $ManagedMarketplace
  $Staging = "$ManagedMarketplace.new"
  $Backup = "$ManagedMarketplace.backup"
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
  if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  Copy-Item -LiteralPath $BundledMarketplace -Destination $Staging -Recurse -Force

  if (Test-Path -LiteralPath $ManagedMarketplace) {
    Move-Item -LiteralPath $ManagedMarketplace -Destination $Backup
  }
  try {
    Move-Item -LiteralPath $Staging -Destination $ManagedMarketplace
  } catch {
    if (Test-Path -LiteralPath $Backup) {
      Move-Item -LiteralPath $Backup -Destination $ManagedMarketplace
    }
    throw
  }
}

function Test-RemoteMcp {
  $StatusCode = 0
  try {
    $Response = Invoke-WebRequest -Uri $McpUrl -Method Get -UseBasicParsing -TimeoutSec 15
    $StatusCode = [int]$Response.StatusCode
  } catch {
    if ($null -ne $_.Exception.Response) {
      try {
        $RawStatus = $_.Exception.Response.StatusCode
        if ($null -ne $RawStatus.value__) {
          $StatusCode = [int]$RawStatus.value__
        } else {
          $StatusCode = [int]$RawStatus
        }
      } catch { $StatusCode = 0 }
    }
  }

  if ($StatusCode -in @(200, 400, 401, 405)) {
    Write-Ok "The Aurion MCP server is reachable (HTTP $StatusCode; 401 is normal before OAuth)."
    return $true
  }
  Add-Failure "The Aurion MCP server is not reachable: $McpUrl"
  return $false
}

function Get-ClaudePlugin {
  try {
    $Raw = (& claude plugin list --json 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $Rows = $Raw | ConvertFrom-Json
    return $Rows | Where-Object { $_.id -like "$PluginName@*" } | Select-Object -First 1
  } catch {
    return $null
  }
}

function Test-ClaudeMcp {
  $Detail = (& claude mcp get $ClaudeMcpName 2>&1) -join [Environment]::NewLine
  return $Detail -match "Status:\s+.*Connected"
}

function Update-Claude {
  $Plugin = Get-ClaudePlugin
  if ($null -eq $Plugin) {
    if (-not (Test-ManagedMarketplace)) {
      Add-Failure "The bundled Claude Plugin installer is not ready. Please download this tool again."
      return
    }
    try {
      $Configured = (& claude plugin marketplace list 2>&1) -join [Environment]::NewLine
      if ($Configured -notmatch [regex]::Escape($ManagedMarketplaceName)) {
        Write-Step "First use: installing the Claude Plugin source"
        Invoke-Checked "claude" @("plugin", "marketplace", "add", "--scope", "user", $ManagedMarketplace)
      }
      $Selector = "$PluginName@$ManagedMarketplaceName"
      Write-Step "First use: installing the Claude Plugin"
      Invoke-Checked "claude" @("plugin", "install", "--yes", "--scope", "user", $Selector)
    } catch {
      Add-Failure "Claude Plugin installation failed: $($_.Exception.Message)"
      return
    }
  } else {
    $Selector = [string]$Plugin.id
  }

  $Marketplace = ($Selector -split "@", 2)[1]
  try {
    Write-Step "Installing or updating Claude Plugin: $Selector"
    Invoke-Checked "claude" @("plugin", "marketplace", "update", $Marketplace)
    Invoke-Checked "claude" @("plugin", "update", $Selector)
    Write-Ok "Claude Plugin is ready."
  } catch {
    Add-Failure "Claude Plugin update failed: $($_.Exception.Message)"
    return
  }

  if (Test-ClaudeMcp) {
    Write-Ok "Claude MCP is connected and authorized."
    return
  }

  Write-Step "Claude MCP needs authorization. Opening your browser now"
  try {
    Invoke-Checked "claude" @("mcp", "login", $ClaudeMcpName)
    if (Test-ClaudeMcp) {
      Write-Ok "Claude MCP authorization completed."
    } else {
      Add-Failure "Claude login finished, but the MCP is still not connected. Restart Claude and run this updater again."
    }
  } catch {
    Add-Failure "Claude MCP authorization was not completed."
  }
}

function Get-CodexPlugin {
  try {
    $Raw = (& codex plugin list --json 2>$null) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $Data = $Raw | ConvertFrom-Json
    return $Data.installed | Where-Object { $_.name -eq $PluginName } | Select-Object -First 1
  } catch {
    return $null
  }
}

function Set-CodexCachebuster([string]$PluginDirectory) {
  $ManifestPath = Join-Path $PluginDirectory ".codex-plugin\plugin.json"
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Codex Plugin manifest is missing."
  }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $BaseVersion = ([string]$Manifest.version -split "\+", 2)[0]
  $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
  $Manifest.version = "$BaseVersion+codex.$Stamp"
  $Json = $Manifest | ConvertTo-Json -Depth 100
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ManifestPath, "$Json`n", $Utf8NoBom)
}

function Install-PackagedCodexPlugin([object]$Plugin) {
  if (-not (Test-Path -LiteralPath $PluginSource -PathType Container)) {
    throw "The updater package does not contain the Aurion Plugin."
  }
  $Target = [System.IO.Path]::GetFullPath([string]$Plugin.source.path)
  if ([System.IO.Path]::GetFileName($Target) -ne $PluginName) {
    throw "The installed Codex Plugin path is not safe to replace."
  }

  $Backup = "$Target.aios-backup"
  if (Test-Path -LiteralPath $Backup) {
    Remove-Item -LiteralPath $Backup -Recurse -Force
  }
  if (Test-Path -LiteralPath $Target) {
    Move-Item -LiteralPath $Target -Destination $Backup
  }
  try {
    Copy-Item -LiteralPath $PluginSource -Destination $Target -Recurse -Force
    Set-CodexCachebuster $Target
  } catch {
    if (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
    if (Test-Path -LiteralPath $Backup) {
      Move-Item -LiteralPath $Backup -Destination $Target
    }
    throw
  }
}

function Test-CodexMcp {
  $Rows = (& codex mcp list 2>&1) -join [Environment]::NewLine
  $Line = ($Rows -split "`r?`n" | Where-Object { $_ -match "^$CodexMcpName\s" } | Select-Object -First 1)
  return -not [string]::IsNullOrWhiteSpace($Line) -and $Line -match "\senabled\s" -and $Line -notmatch "Not logged in"
}

function Update-Codex {
  $Plugin = Get-CodexPlugin
  $PreviousSelector = if ($null -ne $Plugin) { [string]$Plugin.pluginId } else { "" }
  if (-not (Test-ManagedMarketplace)) {
    Add-Failure "The bundled Codex Plugin installer is not ready. Please download this tool again."
    return
  }

  try {
    $Configured = (& codex plugin marketplace list --json 2>&1) -join [Environment]::NewLine
    if ($Configured -notmatch ('"name"\s*:\s*"' + [regex]::Escape($ManagedMarketplaceName) + '"')) {
      Write-Step "Installing the Codex Plugin source"
      Invoke-Checked "codex" @("plugin", "marketplace", "add", $ManagedMarketplace)
    }
    $Selector = "$PluginName@$ManagedMarketplaceName"
    Write-Step "Preparing the bundled Codex Plugin"
    Set-CodexCachebuster (Join-Path $ManagedMarketplace "plugins\$PluginName")
    Write-Step "Installing or updating Codex Plugin: $Selector"
    Invoke-Checked "codex" @("plugin", "add", $Selector)

    $Installed = (& codex plugin list 2>&1) -join [Environment]::NewLine
    if ($Installed -notmatch ('(?m)^' + [regex]::Escape($Selector) + '\s+installed, enabled')) {
      throw "The new Codex Plugin did not report installed, enabled. The previous plugin was not removed."
    }
    if (-not [string]::IsNullOrWhiteSpace($PreviousSelector) -and $PreviousSelector -ne $Selector) {
      Write-Step "Removing the previous Codex Plugin registration: $PreviousSelector"
      Invoke-Checked "codex" @("plugin", "remove", $PreviousSelector)
    }
    Write-Ok "Codex Plugin is ready."
  } catch {
    Add-Failure "Codex Plugin update failed: $($_.Exception.Message)"
    return
  }

  if (Test-CodexMcp) {
    Write-Ok "Codex MCP is connected and authorized."
    return
  }

  Write-Step "Codex MCP needs authorization. Opening your browser now"
  try {
    Invoke-Checked "codex" @("mcp", "login", $CodexMcpName)
    if (Test-CodexMcp) {
      Write-Ok "Codex MCP authorization completed."
    } else {
      Add-Failure "Codex login finished, but the MCP still shows Not logged in. Restart Codex and run this updater again."
    }
  } catch {
    Add-Failure "Codex MCP authorization was not completed."
  }
}

try {
  Write-Step "Preparing the Aurion AIOS Plugin installer"
  Sync-ManagedMarketplace
  Write-Ok "The Plugin installer is ready."
} catch {
  Add-Failure "Plugin installer preparation failed: $($_.Exception.Message)"
}

Write-Step "Checking the Aurion AIOS Remote MCP"
$null = Test-RemoteMcp

Add-ClientInstallPaths
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and
    -not (Get-Command codex -ErrorAction SilentlyContinue)) {
  $null = Install-CodexWhenNoClient
}

if (Get-Command claude -ErrorAction SilentlyContinue) {
  $AvailableClients += 1
  Update-Claude
} else {
  Write-WarningMessage "Claude Code is not installed. Skipping Claude."
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
  $AvailableClients += 1
  Update-Codex
} else {
  Write-WarningMessage "Codex is not installed. Skipping Codex."
}

if ($AvailableClients -eq 0 -and $Failures -eq 0) {
  Add-Failure "Claude Code and Codex were not found on this computer."
}

Write-Host ""
if ($Failures -gt 0) {
  Write-Host "Finished with $Failures unresolved item(s)." -ForegroundColor Red
  exit 1
}

Write-Host "Plugin installation/update and MCP checks completed successfully." -ForegroundColor Green
Write-Host "Restart Claude or Codex and open a new conversation."
exit 0
