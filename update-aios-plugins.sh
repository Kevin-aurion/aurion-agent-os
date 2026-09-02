#!/bin/bash

# Update the Aurion AIOS Plugin for Claude Code and/or Codex, verify the
# hosted MCP endpoint, and start the client's own OAuth browser flow when the
# MCP is not authenticated. No token is read, printed, copied, or persisted by
# this script.

set -u
set -o pipefail

PLUGIN_NAME="aurion-aios-builder"
CLAUDE_LOCAL_MARKETPLACE="aurion-aios-plugin-marketplace"
CLAUDE_REMOTE_MARKETPLACE="aurion-aios"
CLAUDE_REMOTE_MARKETPLACE_SOURCE="Kevin-aurion/aurion-aios-plugin-marketplace"
MANAGED_MARKETPLACE_NAME="aurion-aios-updater"
CLAUDE_MCP_NAME="plugin:aurion-aios-builder:aurion_aios"
CODEX_MCP_NAME="aurion_aios"
MCP_URL="https://aurion-aios-mcp.lazyoffice.app/mcp"
CODEX_INSTALL_URL="${AURION_CODEX_INSTALL_URL:-https://chatgpt.com/codex/install.sh}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
USER_PROFILE_DIR="${HOME:?找不到目前使用者的個人資料夾}"
BUNDLED_MARKETPLACE="${AURION_BUNDLED_MARKETPLACE:-}"
if [ -z "$BUNDLED_MARKETPLACE" ] && [ -d "${SCRIPT_DIR}/web os system/aios-mcp/installers/updater/marketplace" ]; then
  BUNDLED_MARKETPLACE="${SCRIPT_DIR}/web os system/aios-mcp/installers/updater/marketplace"
fi
MANAGED_MARKETPLACE="${AURION_MANAGED_MARKETPLACE:-${USER_PROFILE_DIR}/.aurion-aios/plugin-marketplace}"
PLUGIN_SOURCE="${AURION_PLUGIN_SOURCE:-${BUNDLED_MARKETPLACE:+${BUNDLED_MARKETPLACE}/plugins/${PLUGIN_NAME}}}"
if [ -z "$PLUGIN_SOURCE" ]; then
  PLUGIN_SOURCE="${SCRIPT_DIR}/web os system/aios-mcp/plugins/${PLUGIN_NAME}"
fi
CODEX_PLUGIN_DIR="${AURION_CODEX_PLUGIN_DIR:-${USER_PROFILE_DIR}/plugins/${PLUGIN_NAME}}"
CACHEBUSTER_HELPER="${AURION_CACHEBUSTER_HELPER:-${USER_PROFILE_DIR}/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py}"

UPDATE_CLAUDE=0
UPDATE_CODEX=0
EXPLICIT_TARGET=0
CHECK_ONLY=0
AUTO_AUTH=1
FAILURES=0
AVAILABLE_CLIENTS=0

usage() {
  cat <<'EOF'
Aurion AIOS Plugin 安裝／更新與 MCP 登入檢查

用法：
  ./update-aios-plugins.sh                  安裝或更新 Claude 與 Codex Plugin
  ./update-aios-plugins.sh --claude         只處理 Claude Code
  ./update-aios-plugins.sh --codex          只處理 Codex
  ./update-aios-plugins.sh --all            Claude 與 Codex 都必須處理
  ./update-aios-plugins.sh --check-only     不更新，只檢查；缺少登入仍會開啟授權頁
  ./update-aios-plugins.sh --no-auth        不開授權頁，未連線時回傳失敗

流程：
  1. 沒有 Plugin 就安裝，已安裝就更新。
  2. 檢查遠端 MCP 是否可連到。
  3. 檢查目前客戶端是否已完成 OAuth。
  4. 未登入時，由 Claude/Codex 官方 CLI 自動開啟瀏覽器授權。

完成後請重新啟動 Claude Code／Codex，並開一個新對話載入最新版 Skill。
EOF
}

info() {
  printf '\n==> %s\n' "$1"
}

ok() {
  printf '✅ %s\n' "$1"
}

warn() {
  printf '⚠️  %s\n' "$1" >&2
}

fail() {
  printf '❌ %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

add_client_install_paths() {
  if [ -d "${USER_PROFILE_DIR}/.local/bin" ]; then
    PATH="${PATH}:${USER_PROFILE_DIR}/.local/bin"
    export PATH
  fi
  hash -r 2>/dev/null || true
}

install_codex_when_no_client() {
  local installer
  info "Claude Code 與 Codex 都尚未安裝，現在安裝官方 Codex CLI"
  if ! has_command curl; then
    fail "找不到 curl，無法下載官方 Codex CLI 安裝程式。"
    return 1
  fi
  installer="$(mktemp -t aurion-codex-install.XXXXXX)" || {
    fail "無法建立 Codex 安裝暫存檔。"
    return 1
  }
  if ! curl -fsSL "$CODEX_INSTALL_URL" -o "$installer"; then
    /bin/rm -f "$installer"
    fail "官方 Codex CLI 安裝程式下載失敗。"
    return 1
  fi
  if ! CODEX_NON_INTERACTIVE=1 /bin/sh "$installer"; then
    /bin/rm -f "$installer"
    fail "官方 Codex CLI 安裝失敗。"
    return 1
  fi
  /bin/rm -f "$installer"
  add_client_install_paths
  if ! has_command codex; then
    fail "Codex 已完成安裝，但目前仍找不到 codex 指令；請重新登入電腦後再執行一次。"
    return 1
  fi
  ok "官方 Codex CLI 已安裝完成。"
  return 0
}

managed_marketplace_ready() {
  [ -f "${MANAGED_MARKETPLACE}/.claude-plugin/marketplace.json" ] &&
    [ -f "${MANAGED_MARKETPLACE}/.agents/plugins/marketplace.json" ] &&
    [ -d "${MANAGED_MARKETPLACE}/plugins/${PLUGIN_NAME}" ]
}

refresh_managed_marketplace() {
  if [ -z "$BUNDLED_MARKETPLACE" ]; then
    fail "這份工具沒有附帶 Plugin 安裝來源，請重新下載最新版。"
    return 1
  fi
  if [ ! -f "${BUNDLED_MARKETPLACE}/.claude-plugin/marketplace.json" ] ||
     [ ! -f "${BUNDLED_MARKETPLACE}/.agents/plugins/marketplace.json" ] ||
     [ ! -d "${BUNDLED_MARKETPLACE}/plugins/${PLUGIN_NAME}" ]; then
    fail "Plugin 安裝來源不完整，請重新下載最新版。"
    return 1
  fi
  if ! has_command rsync; then
    fail "找不到 rsync，無法安全安裝 Plugin。"
    return 1
  fi

  info "準備 Aurion AIOS 安裝來源"
  mkdir -p "$MANAGED_MARKETPLACE"
  if ! rsync -a --delete "${BUNDLED_MARKETPLACE}/" "${MANAGED_MARKETPLACE}/"; then
    fail "Plugin 安裝來源準備失敗。"
    return 1
  fi
  ok "Plugin 安裝來源已準備完成。"
  return 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --claude)
      UPDATE_CLAUDE=1
      EXPLICIT_TARGET=1
      ;;
    --codex)
      UPDATE_CODEX=1
      EXPLICIT_TARGET=1
      ;;
    --all)
      UPDATE_CLAUDE=1
      UPDATE_CODEX=1
      EXPLICIT_TARGET=1
      ;;
    --check-only)
      CHECK_ONLY=1
      ;;
    --no-auth)
      AUTO_AUTH=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '不支援的參數：%s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$EXPLICIT_TARGET" -eq 0 ]; then
  UPDATE_CLAUDE=1
  UPDATE_CODEX=1
fi

check_remote_mcp() {
  if ! has_command curl; then
    warn "找不到 curl，略過遠端 MCP 網路檢查。"
    return 0
  fi

  local http_code
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$MCP_URL" 2>/dev/null || true)"
  case "$http_code" in
    200|400|401|405)
      ok "遠端 MCP 可以連到（HTTP ${http_code}；未帶 OAuth 時 401 是正常狀態）"
      return 0
      ;;
    *)
      fail "遠端 MCP 無法連線（HTTP ${http_code:-無回應}）：${MCP_URL}"
      return 1
      ;;
  esac
}

claude_selector() {
  local installed
  installed="$(claude plugin list 2>&1 || true)"
  if printf '%s\n' "$installed" | grep -F "${PLUGIN_NAME}@${MANAGED_MARKETPLACE_NAME}" >/dev/null; then
    printf '%s@%s\n' "$PLUGIN_NAME" "$MANAGED_MARKETPLACE_NAME"
    return 0
  fi
  if printf '%s\n' "$installed" | grep -F "${PLUGIN_NAME}@${CLAUDE_LOCAL_MARKETPLACE}" >/dev/null; then
    printf '%s@%s\n' "$PLUGIN_NAME" "$CLAUDE_LOCAL_MARKETPLACE"
    return 0
  fi
  if printf '%s\n' "$installed" | grep -F "${PLUGIN_NAME}@${CLAUDE_REMOTE_MARKETPLACE}" >/dev/null; then
    printf '%s@%s\n' "$PLUGIN_NAME" "$CLAUDE_REMOTE_MARKETPLACE"
    return 0
  fi
  return 1
}

ensure_claude_plugin() {
  local selector marketplace configured
  selector="$(claude_selector || true)"

  if [ -z "$selector" ] && [ "$CHECK_ONLY" -eq 1 ]; then
    fail "Claude 尚未安裝 ${PLUGIN_NAME}。"
    return 1
  fi

  if [ -z "$selector" ]; then
    if ! managed_marketplace_ready; then
      fail "找不到可用的 Plugin 安裝來源，請重新下載最新版工具。"
      return 1
    fi
    configured="$(claude plugin marketplace list 2>&1 || true)"
    marketplace="$MANAGED_MARKETPLACE_NAME"
    if ! printf '%s\n' "$configured" | grep -F "$MANAGED_MARKETPLACE_NAME" >/dev/null; then
      info "第一次使用：安裝 Claude Plugin 來源"
      if ! claude plugin marketplace add --scope user "$MANAGED_MARKETPLACE"; then
        fail "無法加入 Claude Plugin 安裝來源。"
        return 1
      fi
    fi
    selector="${PLUGIN_NAME}@${marketplace}"
    info "第一次使用：安裝 Claude Plugin"
    if ! claude plugin install --yes --scope user "$selector"; then
      fail "Claude Plugin 安裝失敗。"
      return 1
    fi
  else
    marketplace="${selector#*@}"
  fi

  if [ "$CHECK_ONLY" -eq 0 ]; then
    info "更新 Claude Plugin：${selector}"
    if ! claude plugin marketplace update "$marketplace"; then
      fail "Claude Marketplace 更新失敗。"
      return 1
    fi
    if ! claude plugin update "$selector"; then
      fail "Claude Plugin 更新失敗。"
      return 1
    fi
  fi

  ok "Claude Plugin 已就緒：${selector}"
  return 0
}

claude_mcp_connected() {
  local detail
  detail="$(claude mcp get "$CLAUDE_MCP_NAME" 2>&1 || true)"
  printf '%s\n' "$detail" | grep -E 'Status:[[:space:]]+.*Connected' >/dev/null
}

verify_claude_mcp() {
  if claude_mcp_connected; then
    ok "Claude MCP 已連線並完成授權。"
    return 0
  fi

  if [ "$AUTO_AUTH" -eq 0 ]; then
    fail "Claude MCP 尚未連線；重新執行時請拿掉 --no-auth。"
    return 1
  fi

  info "Claude MCP 尚未授權，現在由 Claude CLI 開啟瀏覽器登入"
  if ! claude mcp login "$CLAUDE_MCP_NAME"; then
    fail "Claude MCP OAuth 沒有完成。"
    return 1
  fi
  if claude_mcp_connected; then
    ok "Claude MCP OAuth 完成，連線正常。"
    return 0
  fi

  fail "Claude 已執行登入，但 MCP 仍未顯示 Connected；請重啟 Claude 後再執行一次。"
  return 1
}

codex_selector() {
  local installed row
  installed="$(codex plugin list 2>&1 || true)"
  row="$(printf '%s\n' "$installed" | grep -E "^${PLUGIN_NAME}@[A-Za-z0-9._-]+[[:space:]]+installed, enabled" | head -n 1 || true)"
  [ -n "$row" ] || return 1
  printf '%s\n' "${row%%[[:space:]]*}"
}

codex_plugin_metadata() {
  local installed_json
  installed_json="$(codex plugin list --json 2>/dev/null || true)"
  [ -n "$installed_json" ] || return 1

  # macOS ships JXA with osascript, so the click installer does not need jq or
  # a separately installed Python. Keep a Python fallback for Linux/dev use.
  if [ -x /usr/bin/osascript ]; then
    /usr/bin/osascript -l JavaScript -e '
      function run(argv) {
        const name = argv[0];
        const data = JSON.parse(argv[1]);
        const plugin = (data.installed || []).find((item) =>
          item.name === name && item.installed && item.enabled
        );
        if (!plugin) return "";
        return [
          plugin.pluginId || "",
          plugin.marketplaceName || "",
          (plugin.source && plugin.source.path) || "",
          (plugin.marketplaceSource && plugin.marketplaceSource.sourceType) || "local"
        ].join("\t");
      }
    ' "$PLUGIN_NAME" "$installed_json"
    return $?
  fi

  if has_command python3; then
    CODEX_PLUGIN_NAME="$PLUGIN_NAME" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
name = os.environ["CODEX_PLUGIN_NAME"]
plugin = next((item for item in data.get("installed", [])
               if item.get("name") == name and item.get("installed") and item.get("enabled")), None)
if plugin:
    source = plugin.get("source") or {}
    marketplace_source = plugin.get("marketplaceSource") or {}
    print("\t".join([
        plugin.get("pluginId", ""),
        plugin.get("marketplaceName", ""),
        source.get("path", ""),
        marketplace_source.get("sourceType", "local"),
    ]))
' <<<"$installed_json"
    return $?
  fi

  return 1
}

bump_codex_cachebuster() {
  local plugin_directory manifest version base stamp
  plugin_directory="${1:-$CODEX_PLUGIN_DIR}"
  manifest="${plugin_directory}/.codex-plugin/plugin.json"
  [ -f "$manifest" ] || return 1

  if [ -f "$CACHEBUSTER_HELPER" ] && has_command python3; then
    python3 "$CACHEBUSTER_HELPER" "$plugin_directory"
    return $?
  fi

  if [ -x /usr/bin/plutil ]; then
    version="$(/usr/bin/plutil -extract version raw "$manifest" 2>/dev/null || true)"
    [ -n "$version" ] || return 1
    base="${version%%+*}"
    stamp="$(date -u +%Y%m%d%H%M%S)"
    /usr/bin/plutil -replace version -string "${base}+codex.${stamp}" "$manifest"
    return $?
  fi

  return 1
}

ensure_codex_plugin() {
  local selector previous_selector configured managed_plugin metadata installed_path marketplace_source_type installed
  metadata="$(codex_plugin_metadata || true)"
  if [ -n "$metadata" ]; then
    IFS=$'\t' read -r previous_selector _ installed_path marketplace_source_type <<<"$metadata"
  else
    previous_selector="$(codex_selector || true)"
    installed_path=""
    marketplace_source_type=""
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ -z "$previous_selector" ]; then
      fail "Codex 尚未安裝 ${PLUGIN_NAME}。"
      return 1
    fi
    selector="$previous_selector"
  else
    if ! managed_marketplace_ready; then
      fail "找不到可用的 Plugin 安裝來源，請重新下載最新版工具。"
      return 1
    fi

    configured="$(codex plugin marketplace list --json 2>&1 || true)"
    if ! printf '%s\n' "$configured" | grep -E "\"name\"[[:space:]]*:[[:space:]]*\"${MANAGED_MARKETPLACE_NAME}\"" >/dev/null; then
      info "安裝 Codex Plugin 來源"
      if ! codex plugin marketplace add "$MANAGED_MARKETPLACE"; then
        fail "無法加入 Codex Plugin 安裝來源。"
        return 1
      fi
    fi
    selector="${PLUGIN_NAME}@${MANAGED_MARKETPLACE_NAME}"
    managed_plugin="${MANAGED_MARKETPLACE}/plugins/${PLUGIN_NAME}"
    if ! bump_codex_cachebuster "$managed_plugin"; then
      fail "Codex Plugin cachebuster 更新失敗。"
      return 1
    fi

    info "安裝／更新 Codex Plugin：${selector}"
    if ! codex plugin add "$selector"; then
      fail "Codex Plugin 更新失敗。"
      return 1
    fi

    installed="$(codex plugin list 2>&1 || true)"
    if ! printf '%s\n' "$installed" | grep -E "^${selector}[[:space:]]+installed, enabled" >/dev/null; then
      fail "新版 Codex Plugin 安裝後沒有顯示 installed, enabled；舊版未移除。"
      return 1
    fi

    if [ -n "$previous_selector" ] && [ "$previous_selector" != "$selector" ]; then
      info "移除舊的 Codex Plugin 登錄：${previous_selector}"
      if ! codex plugin remove "$previous_selector"; then
        fail "新版已安裝，但舊的 Codex Plugin 登錄無法移除：${previous_selector}"
        return 1
      fi
    fi
  fi

  installed="$(codex plugin list 2>&1 || true)"
  if ! printf '%s\n' "$installed" | grep -E "^${selector}[[:space:]]+installed, enabled" >/dev/null; then
    fail "Codex Plugin 沒有顯示 installed, enabled。"
    return 1
  fi
  ok "Codex Plugin 已就緒：${selector}"
  return 0
}

codex_mcp_connected() {
  local row
  row="$(codex mcp list 2>&1 | grep -E "^${CODEX_MCP_NAME}[[:space:]]" | head -n 1 || true)"
  [ -n "$row" ] && printf '%s\n' "$row" | grep -E '[[:space:]]enabled[[:space:]]' >/dev/null && ! printf '%s\n' "$row" | grep -F 'Not logged in' >/dev/null
}

verify_codex_mcp() {
  if codex_mcp_connected; then
    ok "Codex MCP 已連線並完成授權。"
    return 0
  fi

  if [ "$AUTO_AUTH" -eq 0 ]; then
    fail "Codex MCP 尚未登入；重新執行時請拿掉 --no-auth。"
    return 1
  fi

  info "Codex MCP 尚未授權，現在由 Codex CLI 開啟瀏覽器登入"
  if ! codex mcp login "$CODEX_MCP_NAME"; then
    fail "Codex MCP OAuth 沒有完成。"
    return 1
  fi
  if codex_mcp_connected; then
    ok "Codex MCP OAuth 完成，連線正常。"
    return 0
  fi

  fail "Codex 已執行登入，但 MCP 仍顯示 Not logged in；請重啟 Codex 後再執行一次。"
  return 1
}

info "檢查 Aurion AIOS 遠端 MCP"
check_remote_mcp || true

add_client_install_paths
if [ "$CHECK_ONLY" -eq 0 ] && [ "$UPDATE_CODEX" -eq 1 ] && ! has_command claude && ! has_command codex; then
  install_codex_when_no_client || true
fi

if [ "$CHECK_ONLY" -eq 0 ] && [ -n "$BUNDLED_MARKETPLACE" ]; then
  refresh_managed_marketplace || true
fi

if [ "$UPDATE_CLAUDE" -eq 1 ]; then
  if has_command claude; then
    AVAILABLE_CLIENTS=$((AVAILABLE_CLIENTS + 1))
    info "處理 Claude Code"
    if ensure_claude_plugin; then
      verify_claude_mcp || true
    fi
  elif [ "$EXPLICIT_TARGET" -eq 1 ]; then
    fail "找不到 Claude Code CLI（claude）。"
  else
    warn "這台電腦沒有 Claude Code CLI，略過 Claude。"
  fi
fi

if [ "$UPDATE_CODEX" -eq 1 ]; then
  if has_command codex; then
    AVAILABLE_CLIENTS=$((AVAILABLE_CLIENTS + 1))
    info "處理 Codex"
    if ensure_codex_plugin; then
      verify_codex_mcp || true
    fi
  elif [ "$EXPLICIT_TARGET" -eq 1 ]; then
    fail "找不到 Codex CLI（codex）。"
  else
    warn "這台電腦沒有 Codex CLI，略過 Codex。"
  fi
fi

if [ "$AVAILABLE_CLIENTS" -eq 0 ] && [ "$FAILURES" -eq 0 ]; then
  fail "找不到可處理的 Claude 或 Codex CLI。"
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '完成，但有 %s 個問題尚未解決。請看上方 ❌ 訊息。\n' "$FAILURES" >&2
  exit 1
fi

printf '✅ Plugin 安裝／更新與 MCP 驗證全部完成。\n'
printf '請重新啟動 Claude Code／Codex，並開一個新對話使用最新版 Skill。\n'
